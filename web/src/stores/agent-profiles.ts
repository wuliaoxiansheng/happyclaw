import { create } from 'zustand';
import { api, apiFetch } from '../api/client';
import { extractErrorMessage } from '../utils/error';
import type {
  AgentProfile,
  AgentProfileGovernance,
  AgentProfilePromptMode,
  AgentProfilePrompts,
  AgentProfileRuntimePolicy,
  AgentProfileRuntimePolicyPatch,
  GroupInfo,
  InheritedModel,
  ModelConfigOption,
} from '../types';
import { useChatStore } from './chat';
import { useGroupsStore } from './groups';
import {
  buildWorkspaceAgentProfilePatch,
  getAgentProfileDisplayName,
} from '../utils/agent-product';

interface AgentProfileDraft extends AgentProfilePrompts {
  name: string;
}

export interface AgentPromptChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentPromptRefinement extends Omit<
  AgentProfilePrompts,
  'prompt_mode'
> {
  reply: string;
}

interface AgentProfilesState {
  profiles: AgentProfile[];
  modelConfigs: ModelConfigOption[];
  /** What an Agent without its own binding follows; null until loaded. */
  inheritedModel: InheritedModel | null;
  governanceByProfile: Record<string, AgentProfileGovernance | undefined>;
  governanceLoading: Record<string, boolean | undefined>;
  governanceErrors: Record<string, string | undefined>;
  loading: boolean;
  profilesError: string | null;
  error: string | null;
  loadProfiles: () => Promise<void>;
  refreshProfile: (id: string) => Promise<AgentProfile>;
  loadProfileGovernance: (id: string) => Promise<AgentProfileGovernance>;
  retryRuntimeCleanup: (id: string) => Promise<void>;
  generateProfileDraft: (description: string) => Promise<AgentProfileDraft>;
  refineProfilePrompt: (
    id: string,
    data: {
      section: 'identity' | 'soul' | 'agents' | 'tools';
      message: string;
      current_prompts: Omit<AgentProfilePrompts, 'prompt_mode'>;
      history: AgentPromptChatMessage[];
    },
  ) => Promise<AgentPromptRefinement>;
  createProfile: (data: {
    prompt_schema_version?: 2;
    name: string;
    identity_prompt?: string;
    soul_prompt?: string;
    agents_prompt?: string;
    tools_prompt?: string;
    prompt_mode?: AgentProfilePromptMode;
    include_claude_preset?: boolean;
    avatar_emoji?: string | null;
    avatar_color?: string | null;
    model_config_id?: string | null;
    /** Needs `model_config_id`; must be one of that configuration's models. */
    model?: string | null;
    runtime_policy?: AgentProfileRuntimePolicy;
  }) => Promise<AgentProfile>;
  updateProfile: (
    id: string,
    data: {
      prompt_schema_version?: 2;
      name?: string;
      identity_prompt?: string;
      soul_prompt?: string;
      agents_prompt?: string;
      tools_prompt?: string;
      prompt_mode?: AgentProfilePromptMode;
      include_claude_preset?: boolean;
      avatar_emoji?: string | null;
      avatar_color?: string | null;
      model_config_id?: string | null;
      /** Null clears it; changing `model_config_id` clears it as well. */
      model?: string | null;
      runtime_policy?: AgentProfileRuntimePolicyPatch;
    },
  ) => Promise<AgentProfile>;
  uploadProfileAvatar: (id: string, file: File) => Promise<AgentProfile>;
  removeProfileAvatar: (id: string) => Promise<AgentProfile>;
  deleteProfile: (id: string) => Promise<void>;
  /** Move every Workspace to `targetId` and delete, all or nothing. */
  migrateAndDeleteProfile: (id: string, targetId: string) => Promise<void>;
  duplicateProfile: (
    id: string,
  ) => Promise<{ profile: AgentProfile; stripped: AgentHostGrant[] }>;
  exportProfile: (id: string) => Promise<AgentProfileExportDocument>;
  importProfile: (data: {
    data: unknown;
    name?: string;
    drop_missing?: boolean;
    confirm_host_grants?: boolean;
  }) => Promise<AgentProfileImportResult>;
  setWorkspaceAgentProfile: (jid: string, profileId: string) => Promise<void>;
}

/** Host grants a member's copy or import loses. */
export type AgentHostGrant = 'host_context' | 'host_skills';

export interface AgentProfileExportDocument {
  format: 'happyclaw-agent';
  version: number;
  exported_at?: string;
  agent: { name: string } & Record<string, unknown>;
}

export interface AgentCapabilityReferences {
  skills: string[];
  host_skills: string[];
  mcp: string[];
}

export interface AgentProfileImportResult {
  profile: AgentProfile;
  stripped: AgentHostGrant[];
  dropped: AgentCapabilityReferences;
}

export const useAgentProfilesStore = create<AgentProfilesState>((set, get) => ({
  profiles: [],
  modelConfigs: [],
  inheritedModel: null,
  governanceByProfile: {},
  governanceLoading: {},
  governanceErrors: {},
  loading: false,
  profilesError: null,
  error: null,

  loadProfiles: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{
        profiles: AgentProfile[];
        model_configs: ModelConfigOption[];
        inherited_model?: InheritedModel;
      }>('/api/agent-profiles');
      set({
        profiles: data.profiles.map((profile) =>
          profile.is_default
            ? { ...profile, name: getAgentProfileDisplayName(profile.name) }
            : profile,
        ),
        modelConfigs: data.model_configs ?? [],
        inheritedModel: data.inherited_model ?? null,
        loading: false,
        profilesError: null,
        error: null,
      });
    } catch (err) {
      const message = extractErrorMessage(err);
      set({
        loading: false,
        profilesError: message,
        error: message,
      });
    }
  },

  refreshProfile: async (id) => {
    const data = await api.get<{
      profiles: AgentProfile[];
      model_configs: ModelConfigOption[];
      inherited_model?: InheritedModel;
    }>('/api/agent-profiles');
    const profile = data.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new Error('智能体配置不存在');
    set((state) => ({
      profiles: state.profiles.map((candidate) =>
        candidate.id === id ? profile : candidate,
      ),
      modelConfigs: data.model_configs ?? [],
      inheritedModel: data.inherited_model ?? null,
      governanceByProfile: {
        ...state.governanceByProfile,
        [id]: state.governanceByProfile[id]
          ? { ...state.governanceByProfile[id], profile }
          : undefined,
      },
      error: null,
    }));
    return profile;
  },

  loadProfileGovernance: async (id) => {
    set((state) => ({
      governanceLoading: { ...state.governanceLoading, [id]: true },
      governanceErrors: { ...state.governanceErrors, [id]: undefined },
    }));
    try {
      const data = await api.get<AgentProfileGovernance>(
        `/api/agent-profiles/${encodeURIComponent(id)}/workspaces`,
      );
      set((state) => ({
        governanceByProfile: { ...state.governanceByProfile, [id]: data },
        governanceLoading: { ...state.governanceLoading, [id]: false },
        governanceErrors: { ...state.governanceErrors, [id]: undefined },
      }));
      return data;
    } catch (err) {
      const message = extractErrorMessage(err);
      set((state) => ({
        governanceLoading: { ...state.governanceLoading, [id]: false },
        governanceErrors: { ...state.governanceErrors, [id]: message },
      }));
      throw err;
    }
  },

  retryRuntimeCleanup: async (id) => {
    await api.post<{
      success: boolean;
      cleaned_runtime_jids: number;
      runtime_cleanup_pending: false;
    }>(
      `/api/agent-profiles/${encodeURIComponent(id)}/runtime-cleanup`,
      undefined,
      120_000,
    );
    set((state) => ({
      governanceByProfile: {
        ...state.governanceByProfile,
        [id]: state.governanceByProfile[id]
          ? {
              ...state.governanceByProfile[id],
              runtime_cleanup_pending: false,
            }
          : undefined,
      },
      error: null,
    }));
  },

  generateProfileDraft: async (description) => {
    try {
      const res = await api.post<{ draft: AgentProfileDraft }>(
        '/api/agent-profiles/generate',
        { description },
        60_000,
      );
      set({ error: null });
      return res.draft;
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },

  refineProfilePrompt: async (id, data) => {
    try {
      const res = await api.post<{ refinement: AgentPromptRefinement }>(
        `/api/agent-profiles/${encodeURIComponent(id)}/refine-prompt`,
        data,
        60_000,
      );
      set({ error: null });
      return res.refinement;
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },

  createProfile: async (data) => {
    try {
      const res = await api.post<{ profile: AgentProfile }>(
        '/api/agent-profiles',
        { ...data, prompt_schema_version: 2 },
      );
      set((state) => ({
        profiles: [
          res.profile,
          ...state.profiles.filter((p) => p.id !== res.profile.id),
        ].sort((a, b) => Number(b.is_default) - Number(a.is_default)),
        error: null,
      }));
      await get().loadProfiles();
      return res.profile;
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },

  updateProfile: async (id, data) => {
    try {
      const res = await api.patch<{ profile: AgentProfile }>(
        `/api/agent-profiles/${encodeURIComponent(id)}`,
        { ...data, prompt_schema_version: 2 },
        120_000,
      );
      set((state) => ({
        profiles: state.profiles.map((p) => (p.id === id ? res.profile : p)),
        governanceByProfile: {
          ...state.governanceByProfile,
          [id]: state.governanceByProfile[id]
            ? {
                ...state.governanceByProfile[id],
                profile: res.profile,
                runtime_cleanup_pending: false,
              }
            : undefined,
        },
        error: null,
      }));
      // The profile PATCH is already committed at this point. A secondary
      // navigation-list refresh must not turn a successful capability save
      // into a false failure that makes the editor roll back its UI.
      await Promise.allSettled([
        useChatStore.getState().loadGroups(),
        useGroupsStore.getState().loadGroups(),
      ]);
      return res.profile;
    } catch (err) {
      const persistedProfile =
        err &&
        typeof err === 'object' &&
        'body' in err &&
        (err as { body?: Record<string, unknown> }).body?.persisted === true
          ? (err as { body?: { profile?: AgentProfile } }).body?.profile
          : undefined;
      if (persistedProfile?.id === id) {
        set((state) => ({
          profiles: state.profiles.map((profile) =>
            profile.id === id ? persistedProfile : profile,
          ),
          governanceByProfile: {
            ...state.governanceByProfile,
            [id]: state.governanceByProfile[id]
              ? {
                  ...state.governanceByProfile[id],
                  profile: persistedProfile,
                  runtime_cleanup_pending: true,
                }
              : undefined,
          },
          error:
            err && typeof err === 'object' && 'message' in err
              ? String(err.message)
              : '配置已保存，但运行时清理失败',
        }));
        throw err;
      }
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },

  uploadProfileAvatar: async (id, file) => {
    const body = new FormData();
    body.append('avatar', file);
    const res = await apiFetch<{ profile: AgentProfile }>(
      `/api/agent-profiles/${encodeURIComponent(id)}/avatar`,
      { method: 'POST', body },
    );
    set((state) => ({
      profiles: state.profiles.map((profile) =>
        profile.id === id ? res.profile : profile,
      ),
    }));
    return res.profile;
  },

  removeProfileAvatar: async (id) => {
    const res = await api.delete<{ profile: AgentProfile }>(
      `/api/agent-profiles/${encodeURIComponent(id)}/avatar`,
    );
    set((state) => ({
      profiles: state.profiles.map((profile) =>
        profile.id === id ? res.profile : profile,
      ),
    }));
    return res.profile;
  },

  deleteProfile: async (id) => {
    try {
      await api.delete(`/api/agent-profiles/${encodeURIComponent(id)}`);
      set((state) => ({
        profiles: state.profiles.filter((p) => p.id !== id),
        governanceByProfile: Object.fromEntries(
          Object.entries(state.governanceByProfile).filter(
            ([key]) => key !== id,
          ),
        ),
        governanceErrors: Object.fromEntries(
          Object.entries(state.governanceErrors).filter(([key]) => key !== id),
        ),
        error: null,
      }));
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },

  migrateAndDeleteProfile: async (id, targetId) => {
    try {
      await api.post(
        `/api/agent-profiles/${encodeURIComponent(id)}/migrate-and-delete`,
        { target_agent_profile_id: targetId },
        120_000,
      );
      set((state) => ({
        profiles: state.profiles.filter((p) => p.id !== id),
        governanceByProfile: Object.fromEntries(
          Object.entries(state.governanceByProfile).filter(
            ([key]) => key !== id && key !== targetId,
          ),
        ),
        error: null,
      }));
      // The Workspaces now belong to the target; navigation lists show it.
      await Promise.allSettled([
        useChatStore.getState().loadGroups(),
        useGroupsStore.getState().loadGroups(),
      ]);
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },

  duplicateProfile: async (id) => {
    const res = await api.post<{
      profile: AgentProfile;
      stripped: AgentHostGrant[];
    }>(`/api/agent-profiles/${encodeURIComponent(id)}/duplicate`);
    await get().loadProfiles();
    return res;
  },

  exportProfile: (id) =>
    api.get<AgentProfileExportDocument>(
      `/api/agent-profiles/${encodeURIComponent(id)}/export`,
    ),

  importProfile: async (data) => {
    const res = await api.post<AgentProfileImportResult>(
      '/api/agent-profiles/import',
      data,
    );
    await get().loadProfiles();
    return res;
  },

  setWorkspaceAgentProfile: async (jid, profileId) => {
    try {
      const res = await api.patch<{
        success: boolean;
        agent_profile_id: string;
        agent_profile_name: string;
        agent_profile_version: number;
      }>(`/api/groups/${encodeURIComponent(jid)}/agent-profile`, {
        ...buildWorkspaceAgentProfilePatch(profileId),
      });
      const patchGroup = (group?: GroupInfo): GroupInfo | undefined =>
        group
          ? {
              ...group,
              agent_profile_id: res.agent_profile_id,
              agent_profile_name: res.agent_profile_name,
              agent_profile_version: res.agent_profile_version,
            }
          : group;

      useChatStore.setState((state) => {
        const patched = patchGroup(state.groups[jid]);
        if (!patched) return state;
        return { groups: { ...state.groups, [jid]: patched } };
      });
      useGroupsStore.setState((state) => {
        const patched = patchGroup(state.groups[jid]);
        if (!patched) return state;
        return { groups: { ...state.groups, [jid]: patched } };
      });
      set({ error: null });
    } catch (err) {
      set({ error: extractErrorMessage(err) });
      throw err;
    }
  },
}));
