/**
 * A Host workspace with a custom directory keeps its project Skills and MCP
 * in that directory (the Web writes them there, and the CLI discovers them
 * natively from cwd). The capability preview and the runtime resolver must
 * read the same place, produce the same manifest, and link each Skill into
 * the session config dir as the very file the CLI also finds as a project
 * Skill, so the CLI's same-file de-duplication leaves it listed once.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'workspace-project-skills-'),
);
const dataDir = path.join(root, 'data');
const groupsDir = path.join(dataDir, 'groups');
const externalDir = path.join(root, 'host-claude');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: dataDir, GROUPS_DIR: groupsDir };
});
vi.mock('../src/runtime-config.js', () => ({
  getEffectiveExternalDir: () => externalDir,
}));

const { buildAgentCapabilityPreview } =
  await import('../src/agent-capability-preview.js');
const { buildClaudeContextPlan, syncHostClaudeContext } =
  await import('../src/claude-context-resolver.js');
const { resolveWorkspaceSkillRoots } =
  await import('../src/session-worktree.js');
const { resolveHostSkillPolicy } =
  await import('../src/agent-profile-policy.js');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function writeSkill(dir: string, id: string): void {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'SKILL.md'), `---\nname: ${id}\n---\n`);
}

const profile = {
  id: 'dev-profile',
  owner_user_id: 'owner',
  name: 'Dev',
  identity_prompt: '',
  soul_prompt: '',
  agents_prompt: '',
  tools_prompt: '',
  prompt_mode: 'append' as const,
  include_claude_preset: true,
  avatar_emoji: null,
  avatar_color: null,
  avatar_url: null,
  identity_hash: 'hash',
  version: 1,
  is_default: false,
  status: 'active' as const,
  created_at: '',
  updated_at: '',
  runtime_policy: {
    context: {
      source: 'managed' as const,
      auto_compact_window: 0,
      auto_compact_percentage: 0,
    },
    skills: {
      mode: 'inherit' as const,
      ids: [],
      host: { mode: 'disabled' as const, ids: [] },
    },
    mcp: { mode: 'inherit' as const, ids: [] },
  },
};

describe('project root of a Host workspace with a custom directory', () => {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeSkill(path.join(repo, '.claude', 'skills'), 'repo-skill');
  writeSkill(path.join(dataDir, 'skills', 'owner'), 'managed-skill');
  fs.writeFileSync(
    path.join(repo, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'repo-mcp': { command: 'repo' } } }),
  );
  // data/groups/<folder> is not where this workspace's project lives.
  writeSkill(
    path.join(groupsDir, 'host-ws', '.claude', 'skills'),
    'stale-skill',
  );
  fs.writeFileSync(
    path.join(groupsDir, 'host-ws', '.mcp.json'),
    JSON.stringify({ mcpServers: { 'stale-mcp': { command: 'stale' } } }),
  );
  const group = {
    name: 'Host WS',
    folder: 'host-ws',
    added_at: '',
    executionMode: 'host' as const,
    customCwd: repo,
    created_by: 'owner',
  };

  test('the preview lists the custom directory Skills and MCP', () => {
    const preview = buildAgentCapabilityPreview({
      profile,
      workspace: { jid: 'web:host-ws', group },
      ownerRole: 'admin',
    });
    const skillIds = preview.skills.entries.map((entry) => entry.id);
    expect(preview.skills.entries).toContainEqual(
      expect.objectContaining({ id: 'repo-skill', source: 'workspace' }),
    );
    expect(skillIds).not.toContain('stale-skill');
    const mcpIds = preview.mcp.entries.map((entry) => entry.id);
    expect(preview.mcp.entries).toContainEqual(
      expect.objectContaining({ id: 'repo-mcp', source: 'workspace' }),
    );
    expect(mcpIds).not.toContain('stale-mcp');
  });

  test('the runtime manifest equals the preview and links the same files', () => {
    const preview = buildAgentCapabilityPreview({
      profile,
      workspace: { jid: 'web:host-ws', group },
      ownerRole: 'admin',
    });
    const sessionDir = path.join(dataDir, 'sessions', 'host-ws', '.claude');
    fs.mkdirSync(sessionDir, { recursive: true });
    const plan = buildClaudeContextPlan({
      executionMode: 'host',
      group,
      externalClaudeDir: externalDir,
      projectRoot: process.cwd(),
      dataDir,
      groupSessionsDir: sessionDir,
      hostSkillPolicy: resolveHostSkillPolicy(profile.runtime_policy),
      managedSkillPolicy: profile.runtime_policy.skills,
      workspaceSkillRoots: resolveWorkspaceSkillRoots(group),
    });

    expect(plan.audit.skills.selectedSkillIds).toEqual(
      preview.skills.entries.map((entry) => entry.id).sort(),
    );
    expect(plan.effectiveSkills.hash).toBe(preview.skills.manifestHash);
    expect(plan.audit.skills.sources).toContainEqual(
      expect.objectContaining({
        name: 'workspace',
        sourcePath: path.join(fs.realpathSync(repo), '.claude', 'skills'),
        count: 1,
      }),
    );

    syncHostClaudeContext(plan, sessionDir);
    const linked = fs.realpathSync(
      path.join(sessionDir, 'skills', 'repo-skill', 'SKILL.md'),
    );
    // The CLI also finds <cwd>/.claude/skills/repo-skill natively; it is the
    // same file, so the CLI loads it once.
    expect(linked).toBe(
      fs.realpathSync(
        path.join(repo, '.claude', 'skills', 'repo-skill', 'SKILL.md'),
      ),
    );
    expect(fs.existsSync(path.join(sessionDir, 'skills', 'stale-skill'))).toBe(
      false,
    );
  });
});
