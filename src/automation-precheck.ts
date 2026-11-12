/**
 * Shell commands an automation runs on the host: the pre-run check that
 * decides whether a run happens, and script-mode runs.
 *
 * Both are admin + Host workspace only (the service enforces it before a
 * command is saved, and the scheduler again before it runs). Commands get a
 * small, fixed environment instead of the service's own (which holds
 * provider credentials and the session secret), run in their own process
 * group so a timeout kills everything they started, and have their output
 * capped.
 */
import { spawn } from 'node:child_process';

import {
  AUTOMATION_LIMITS,
  type AutomationPreCheckResult,
} from './automation.js';

const INHERITED_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'TZ',
  'USER',
  'SHELL',
  'TMPDIR',
];

export interface AutomationCommandIdentity {
  automationId: string;
  automationName: string;
  runId: string;
}

/** The allowlisted environment plus the automation's identity. */
export function buildAutomationCommandEnv(
  identity: AutomationCommandIdentity,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (INHERITED_ENV_KEYS.includes(key) || key.startsWith('LC_')) {
      env[key] = value;
    }
  }
  env.HAPPYCLAW_AUTOMATION_ID = identity.automationId;
  env.HAPPYCLAW_AUTOMATION_RUN_ID = identity.runId;
  env.HAPPYCLAW_AUTOMATION_NAME = identity.automationName;
  return env;
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
  /** Spawn failed (missing cwd, no /bin/sh). */
  spawnError: string | null;
}

interface CommandOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  /** Restart the timer on every chunk of output (a no-output watchdog). */
  resetTimeoutOnOutput: boolean;
  outputMax: number;
  signal?: AbortSignal;
}

function appendCapped(current: string, chunk: string, max: number): string {
  if (current.length >= max) return current;
  return (current + chunk).slice(0, max);
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function runCommand(options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (result: Omit<CommandResult, 'stdout' | 'stderr'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ ...result, stdout, stderr });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/bin/sh', ['-c', options.command], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: '',
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const arm = () =>
      setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, options.timeoutMs);
    let timer = arm();
    const onOutput = () => {
      if (!options.resetTimeoutOnOutput || timedOut) return;
      clearTimeout(timer);
      timer = arm();
    };
    const onAbort = () => {
      aborted = true;
      killGroup(child.pid);
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk, options.outputMax);
      onOutput();
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk, options.outputMax);
      onOutput();
    });
    child.on('error', (error) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        aborted,
        spawnError: error.message,
      });
    });
    child.on('close', (code, signal) => {
      finish({
        exitCode: code,
        signal,
        timedOut,
        aborted,
        spawnError: null,
      });
    });
    // A command that never reads stdin must not fail the write.
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.stdin ?? '');
  });
}

export interface PreRunCheckInput extends AutomationCommandIdentity {
  command: string;
  cwd: string;
  timeoutMs?: number | null;
  firedAt: string;
  lastFinishedAt: string | null;
  /** Kills the check's process group (cancel, delete, shutdown). */
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/**
 * Exit 0 → run (stdout is handed to the run as untrusted data), exit 2 →
 * skip, anything else, a timeout or a spawn failure → block.
 */
export async function runPreRunCheck(
  input: PreRunCheckInput,
): Promise<AutomationPreCheckResult> {
  const result = await runCommand({
    command: input.command,
    cwd: input.cwd,
    env: buildAutomationCommandEnv(input, input.env),
    stdin: JSON.stringify({
      automationId: input.automationId,
      automationName: input.automationName,
      runId: input.runId,
      firedAt: input.firedAt,
      lastFinishedAt: input.lastFinishedAt,
    }),
    timeoutMs: input.timeoutMs ?? AUTOMATION_LIMITS.preRunCheckDefaultTimeoutMs,
    resetTimeoutOnOutput: false,
    outputMax: AUTOMATION_LIMITS.preRunCheckOutputMax,
    signal: input.signal,
  });
  const exitCode = result.timedOut ? null : result.exitCode;
  return {
    decision: exitCode === 0 ? 'run' : exitCode === 2 ? 'skip' : 'block',
    exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.spawnError ?? result.stderr,
  };
}

/** Human-readable reason a pre-run check blocked the run. */
export function describePreRunCheckFailure(
  result: AutomationPreCheckResult,
  timeoutMs: number,
): string {
  if (result.timedOut)
    return `前置检查超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止`;
  const detail = result.stderr.trim().split('\n').slice(-3).join('\n');
  const code =
    result.exitCode === null
      ? '前置检查未能运行'
      : `前置检查退出码 ${result.exitCode}`;
  return detail ? `${code}：${detail}` : code;
}

export interface ScriptRunInput extends AutomationCommandIdentity {
  command: string;
  cwd: string;
  /** No-output watchdog (CONTAINER_TIMEOUT). */
  idleTimeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export type ScriptRunResult =
  | { status: 'success'; output: string }
  | { status: 'failed'; output: string; error: string }
  | { status: 'cancelled'; output: string };

const SCRIPT_OUTPUT_MAX = 16_000;

function joinOutput(stdout: string, stderr: string): string {
  const out = stdout.trimEnd();
  const err = stderr.trimEnd();
  if (!err) return out;
  return out ? `${out}\n\n[stderr]\n${err}` : `[stderr]\n${err}`;
}

/** Run a script-mode automation; cancellation is read from `signal`. */
export async function runAutomationScript(
  input: ScriptRunInput,
): Promise<ScriptRunResult> {
  const result = await runCommand({
    command: input.command,
    cwd: input.cwd,
    env: buildAutomationCommandEnv(input, input.env),
    timeoutMs: input.idleTimeoutMs,
    resetTimeoutOnOutput: true,
    outputMax: SCRIPT_OUTPUT_MAX,
    signal: input.signal,
  });
  const output = joinOutput(result.stdout, result.stderr);
  if (result.aborted) return { status: 'cancelled', output };
  if (result.spawnError)
    return {
      status: 'failed',
      output,
      error: `脚本未能启动：${result.spawnError}`,
    };
  if (result.timedOut)
    return {
      status: 'failed',
      output,
      error: `脚本超过 ${Math.round(input.idleTimeoutMs / 60_000)} 分钟没有输出，已终止`,
    };
  if (result.exitCode !== 0)
    return {
      status: 'failed',
      output,
      error:
        result.exitCode === null
          ? `脚本被信号 ${result.signal ?? '未知'} 终止`
          : `脚本退出码 ${result.exitCode}`,
    };
  return { status: 'success', output };
}
