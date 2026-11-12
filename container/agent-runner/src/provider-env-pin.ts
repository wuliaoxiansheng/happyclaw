import {
  CLAUDE_BACKEND_SWITCH_ENV_KEYS,
  HAPPYCLAW_OWNED_CLAUDE_ENV_KEYS,
} from './claude-provider-env.js';

/**
 * Flag settings (the SDK `settings` option, which outranks the user, project
 * and local settings files) that pin the bound connection and the session's
 * choices. A settings file's `env` outranks the process environment, so a
 * workspace's .claude/settings.json could otherwise change the endpoint,
 * the credentials or the effort of a run.
 *
 * Only what HappyClaw set is pinned, so the agent's own tools never see an
 * empty ANTHROPIC_BASE_URL or the like. Each backend switch is pinned off
 * ('0') unless the connection turned it on. A key HappyClaw leaves unset
 * stays open to the workspace's own project and local settings; the host
 * strips it from the admin's layer and from an inherited shell.
 */
export function pinBoundProviderSettings(
  env: Readonly<Record<string, string | undefined>>,
): { env: Record<string, string>; apiKeyHelper: string } {
  const pinned: Record<string, string> = {};
  for (const key of CLAUDE_BACKEND_SWITCH_ENV_KEYS)
    pinned[key] = env[key] || '0';
  for (const key of HAPPYCLAW_OWNED_CLAUDE_ENV_KEYS) {
    const value = env[key];
    if (value && !(key in pinned)) pinned[key] = value;
  }
  return { env: pinned, apiKeyHelper: '' };
}
