import { useEffect } from 'react';
import { create } from 'zustand';

import { api, type ApiError } from '../api/client';
import { wsManager } from '../api/ws';
import type {
  Automation,
  AutomationDraft,
  AutomationRun,
} from '../lib/automation';

/** POST /api/automations. */
export interface AutomationCreateBody extends AutomationDraft {
  workspaceJid: string;
  /** bound: the chosen session. */
  targetSessionJid?: string | null;
}

/** PATCH /api/automations/:id: only the named fields change. */
export type AutomationPatchBody = Partial<
  Omit<AutomationDraft, 'execution'>
> & {
  targetSessionJid?: string | null;
};

export type AutomationSessionDisposal = 'keep' | 'archive' | 'delete';

/** What the create form starts from (⌘K, a session's ⋯ menu). */
export interface AutomationFormPrefill {
  workspaceJid?: string;
  /** Bind the new automation to this session. */
  targetSessionJid?: string | null;
}

export type AutomationFormRequest =
  | { mode: 'create'; prefill: AutomationFormPrefill; nonce: number }
  | { mode: 'edit'; automationId: string; nonce: number };

interface AutomationChangedEvent {
  automationId?: string;
  deleted?: boolean;
}

interface AutomationRunUpdatedEvent {
  automationId?: string;
  run?: AutomationRun;
}

interface AutomationsState {
  automations: Automation[];
  /** Latest runs per automation, newest first, once its detail was opened. */
  runs: Record<string, AutomationRun[]>;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Automations with a 立即运行 request in flight (list and detail share it). */
  runBusy: Record<string, boolean>;
  formRequest: AutomationFormRequest | null;

  loadAutomations: () => Promise<void>;
  loadDetail: (id: string) => Promise<void>;
  create: (body: AutomationCreateBody) => Promise<Automation>;
  /** Rejects with status 409 when `expectedRevision` is stale. */
  update: (
    id: string,
    expectedRevision: number,
    patch: AutomationPatchBody,
  ) => Promise<Automation>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string, sessions: AutomationSessionDisposal) => Promise<void>;
  runNow: (id: string) => Promise<void>;
  cancelRun: (id: string, runId: string) => Promise<void>;
  markRead: (id: string) => Promise<void>;
  handleChanged: (event: AutomationChangedEvent) => void;
  handleRunUpdated: (event: AutomationRunUpdatedEvent) => void;
  openCreateForm: (prefill?: AutomationFormPrefill) => void;
  openEditForm: (automationId: string) => void;
  closeForm: () => void;
}

const base = '/api/automations';
const path = (id: string, suffix = '') =>
  `${base}/${encodeURIComponent(id)}${suffix}`;

function upsertAutomation(list: Automation[], next: Automation): Automation[] {
  const index = list.findIndex((item) => item.id === next.id);
  if (index === -1) return [...list, next];
  const copy = list.slice();
  // Detail and mutation responses may omit the list-only fields: keep them.
  const merged = { ...list[index] } as Record<string, unknown>;
  for (const [key, value] of Object.entries(next))
    if (value !== undefined) merged[key] = value;
  copy[index] = merged as unknown as Automation;
  return copy;
}

function upsertRun(runs: AutomationRun[], run: AutomationRun): AutomationRun[] {
  const index = runs.findIndex((item) => item.id === run.id);
  if (index !== -1) {
    const copy = runs.slice();
    copy[index] = run;
    return copy;
  }
  return [run, ...runs];
}

// WS events refetch the automation they name, at most once per burst: a run
// that settles sends a run update and a change together.
const REFRESH_DELAY_MS = 120;
const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>();
let formNonce = 0;

export const useAutomationsStore = create<AutomationsState>((set, get) => {
  const scheduleRefresh = (id: string) => {
    if (pendingRefresh.has(id)) return;
    pendingRefresh.set(
      id,
      setTimeout(() => {
        pendingRefresh.delete(id);
        void get()
          .loadDetail(id)
          .catch(() => undefined);
      }, REFRESH_DELAY_MS),
    );
  };

  return {
    automations: [],
    runs: {},
    loaded: false,
    loading: false,
    error: null,
    runBusy: {},
    formRequest: null,

    loadAutomations: async () => {
      set({ loading: true });
      try {
        const data = await api.get<{ automations: Automation[] }>(base);
        set({ automations: data.automations, loaded: true, error: null });
      } catch (err) {
        set({ error: (err as ApiError).message || '加载自动化失败' });
      } finally {
        set({ loading: false });
      }
    },

    loadDetail: async (id) => {
      try {
        const data = await api.get<{
          automation: Automation;
          runs: AutomationRun[];
        }>(path(id));
        set((state) => ({
          automations: upsertAutomation(state.automations, data.automation),
          runs: { ...state.runs, [id]: data.runs },
        }));
      } catch (err) {
        if ((err as ApiError).status === 404) {
          set((state) => removeLocally(state, id));
          return;
        }
        throw err;
      }
    },

    create: async (body) => {
      const data = await api.post<{ automation: Automation }>(base, body);
      set((state) => ({
        automations: upsertAutomation(state.automations, data.automation),
      }));
      return data.automation;
    },

    update: async (id, expectedRevision, patch) => {
      const data = await api.patch<{ automation: Automation }>(path(id), {
        expectedRevision,
        ...patch,
      });
      set((state) => ({
        automations: upsertAutomation(state.automations, data.automation),
      }));
      return data.automation;
    },

    setEnabled: async (id, enabled) => {
      const data = await api.post<{ automation: Automation }>(
        path(id, enabled ? '/resume' : '/pause'),
      );
      set((state) => ({
        automations: upsertAutomation(state.automations, data.automation),
      }));
    },

    remove: async (id, sessions) => {
      await api.delete<void>(
        `${path(id)}?sessions=${encodeURIComponent(sessions)}`,
      );
      set((state) => removeLocally(state, id));
    },

    runNow: async (id) => {
      if (get().runBusy[id]) return;
      set((state) => ({ runBusy: { ...state.runBusy, [id]: true } }));
      try {
        const data = await api.post<{ run: AutomationRun }>(path(id, '/run'));
        get().handleRunUpdated({ automationId: id, run: data.run });
      } finally {
        set((state) => {
          const runBusy = { ...state.runBusy };
          delete runBusy[id];
          return { runBusy };
        });
      }
    },

    cancelRun: async (id, runId) => {
      await api.post<void>(
        path(id, `/runs/${encodeURIComponent(runId)}/cancel`),
      );
      scheduleRefresh(id);
    },

    markRead: async (id) => {
      const now = new Date().toISOString();
      // Optimistic: the mark goes the moment the detail is seen.
      set((state) => ({
        automations: state.automations.map((item) =>
          item.id === id ? { ...item, unreadRuns: 0 } : item,
        ),
        runs: state.runs[id]
          ? {
              ...state.runs,
              [id]: state.runs[id].map((run) =>
                run.readAt ? run : { ...run, readAt: now },
              ),
            }
          : state.runs,
      }));
      try {
        await api.post<void>(path(id, '/runs/read'), {});
      } catch {
        scheduleRefresh(id);
      }
    },

    handleChanged: (event) => {
      if (!event.automationId) return;
      if (event.deleted) {
        set((state) => removeLocally(state, event.automationId!));
        return;
      }
      scheduleRefresh(event.automationId);
    },

    handleRunUpdated: (event) => {
      const { automationId, run } = event;
      if (!automationId || !run) return;
      set((state) => ({
        runs: {
          ...state.runs,
          [automationId]: upsertRun(state.runs[automationId] ?? [], run),
        },
        // The cell shows 排队中 / 运行中 at once; the refetch below brings the
        // counts and the next fire time.
        automations: state.automations.some(
          (item) =>
            item.id === automationId && item.lastRunStatus !== run.status,
        )
          ? state.automations.map((item) =>
              item.id === automationId
                ? { ...item, lastRunStatus: run.status }
                : item,
            )
          : state.automations,
      }));
      scheduleRefresh(automationId);
    },

    openCreateForm: (prefill = {}) =>
      set({ formRequest: { mode: 'create', prefill, nonce: ++formNonce } }),
    openEditForm: (automationId) =>
      set({ formRequest: { mode: 'edit', automationId, nonce: ++formNonce } }),
    closeForm: () => set({ formRequest: null }),
  };
});

function removeLocally(
  state: AutomationsState,
  id: string,
): Partial<AutomationsState> {
  const runs = { ...state.runs };
  delete runs[id];
  return {
    automations: state.automations.filter((item) => item.id !== id),
    runs,
  };
}

/** Load the list and keep it current; mount once for the signed-in app. */
export function useAutomationSubscription(): void {
  useEffect(() => {
    const store = useAutomationsStore.getState();
    void store.loadAutomations();
    const unsubs = [
      wsManager.on('automation_changed', (data: AutomationChangedEvent) =>
        useAutomationsStore.getState().handleChanged(data ?? {}),
      ),
      wsManager.on(
        'automation_run_updated',
        (data: AutomationRunUpdatedEvent) =>
          useAutomationsStore.getState().handleRunUpdated(data ?? {}),
      ),
      // Events missed while the socket was down.
      wsManager.on('connected', (data: { reconnect?: boolean }) => {
        if (data?.reconnect)
          void useAutomationsStore.getState().loadAutomations();
      }),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, []);
}
