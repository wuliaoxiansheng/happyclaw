/**
 * Data behind the composer's `/` and `@` palettes: HappyClaw's own commands,
 * the Skills the workspace's Agent can use, and workspace directory listings.
 * Skill lists are cached per workspace for a short while, so switching
 * sessions does not refetch them; listings are read fresh for each `@`.
 */
import { api } from '../../../api/client';
import { listWorkspaceFiles } from '../../../stores/files';
import type { Skill } from '../../../stores/skills';
import type { AgentCapabilityPreview } from '../../../types';

export interface SlashCommandItem {
  name: string;
  description: string;
  kind: 'command' | 'skill';
}

export interface WorkspaceEntry {
  type: 'file' | 'dir';
  name: string;
  /** Workspace-relative path, without a trailing slash. */
  relPath: string;
}

/**
 * Commands the server handles itself (CLAUDE.md §6.4). They need the right to
 * reset the conversation, so they are offered only where that is allowed.
 */
export const HAPPYCLAW_COMMANDS: readonly SlashCommandItem[] = [
  {
    name: 'clear',
    description: '清除当前会话的上下文，下一条消息从头开始',
    kind: 'command',
  },
  {
    name: 'fresh',
    description: '换新窗口：清除上下文并带上工作区快照，可在后面附交接备注',
    kind: 'command',
  },
];

const TTL_MS = 60_000;

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

const skillCache = new Map<string, CacheEntry<SlashCommandItem[]>>();
// A huge directory (dependencies, build output) is browsed by narrowing the
// path; ranking every entry on each keystroke would stall typing.
const MAX_LISTED_ENTRIES = 1000;

function cached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  ttl: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  // A failure is not cached; the next open retries.
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

/** Forget cached skill lists (tests). */
export function clearPaletteSourceCache(): void {
  skillCache.clear();
}

/** What the workspace's Agent actually loads (owners only). */
function capabilityPreview(agentProfileId: string, workspaceJid: string) {
  const path = `/api/agent-profiles/${encodeURIComponent(agentProfileId)}`;
  return api.post<{ preview: AgentCapabilityPreview }>(
    `${path}/effective-capabilities`,
    { workspace_jid: workspaceJid },
  );
}

/**
 * Skills the workspace's Agent loads, by directory name, with descriptions
 * from the user's skill list where it has them. Skills that are not meant to
 * be invoked by users (`user-invocable: false`) are left out: the CLI drops a
 * message that names one.
 */
export function loadWorkspaceSkills(
  workspaceJid: string,
  agentProfileId: string | undefined,
): Promise<SlashCommandItem[]> {
  return cached(
    skillCache,
    `${workspaceJid}|${agentProfileId ?? ''}`,
    TTL_MS,
    async () => {
      const [listed, preview] = await Promise.all([
        api.get<{ skills: Skill[] }>('/api/skills').catch(() => null),
        agentProfileId
          ? capabilityPreview(agentProfileId, workspaceJid).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!listed && !preview) throw new Error('技能列表加载失败');
      const known = new Map<string, Skill>();
      for (const skill of listed?.skills ?? []) {
        const current = known.get(skill.id);
        if (!current || (skill.effective && !current.effective)) {
          known.set(skill.id, skill);
        }
      }
      // The preview is what this workspace actually loads; without it (not
      // the workspace owner), fall back to the user's effective skills.
      const ids = preview
        ? preview.preview.skills.entries
            .filter((entry) => entry.available)
            .map((entry) => entry.id)
        : [...known.values()]
            .filter((skill) => skill.effective && skill.enabled)
            .map((skill) => skill.id);
      return [...new Set(ids)]
        .filter((id) => known.get(id)?.userInvocable !== false)
        .sort((a, b) => a.localeCompare(b))
        .map((id) => ({
          name: id,
          description: known.get(id)?.description ?? '',
          kind: 'skill' as const,
        }));
    },
  );
}

/** Never offered by `@`: version-control internals, not something to cite. */
const UNLISTED_NAMES = new Set(['.git', '.hg', '.svn']);

/**
 * One directory level of the workspace: directories first, hidden entries
 * (dot names) after the visible ones of their kind.
 */
export async function loadWorkspaceDirectory(
  workspaceJid: string,
  dir: string,
): Promise<WorkspaceEntry[]> {
  const data = await listWorkspaceFiles(workspaceJid, dir);
  const hidden = (entry: WorkspaceEntry) =>
    entry.name.startsWith('.') ? 1 : 0;
  return data.files
    .filter((file) => !file.isSystem && !UNLISTED_NAMES.has(file.name))
    .map((file) => ({
      type: file.type === 'directory' ? ('dir' as const) : ('file' as const),
      name: file.name,
      relPath: file.path.replace(/\\/g, '/').replace(/\/+$/, ''),
    }))
    .sort(
      (a, b) =>
        (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) ||
        hidden(a) - hidden(b) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, MAX_LISTED_ENTRIES);
}

/** Split an `@` query into the directory to list and the name filter. */
export function splitWorkspaceQuery(query: string): {
  dir: string;
  needle: string;
} {
  const normalized = query.replace(/\\/g, '/').replace(/^\/+/, '');
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return { dir: '', needle: normalized };
  const dir = normalized.slice(0, slash).replace(/\/+$/, '');
  // Never list outside the workspace.
  if (dir.split('/').some((part) => part === '..')) {
    return { dir: '', needle: normalized.slice(slash + 1) };
  }
  return { dir, needle: normalized.slice(slash + 1) };
}
