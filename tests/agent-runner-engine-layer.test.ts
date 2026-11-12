import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { buildHappyClawPromptPlan } from '../container/agent-runner/src/prompt-plan.js';

const read = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

const base = {
  platformIdentity: 'HappyClaw',
  agentIdentity: 'identity',
  interaction: 'interaction',
  security: 'security',
  output: 'output',
};

describe('Agent Runner engine layer', () => {
  test('adapts the Claude Code preset right after it, ahead of the identity', () => {
    const plan = buildHappyClawPromptPlan({
      ...base,
      engine: { id: 'runtime-adaptation', text: 'ADAPT' },
    });
    expect(plan.blocks.map((block) => block.id)).toEqual([
      'runtime-adaptation',
      'identity.happyclaw',
      'agent-profile',
      'interaction',
      'security-rules',
      'output',
    ]);
    expect(plan.blocks[0]).toMatchObject({
      owner: 'platform',
      required: true,
      condition: 'Claude Code preset is included',
    });
    expect(plan.text.startsWith('<runtime-adaptation>\nADAPT\n')).toBe(true);
  });

  test('carries the working basics in place of an omitted preset', () => {
    const plan = buildHappyClawPromptPlan({
      ...base,
      engine: { id: 'runtime-baseline', text: 'BASELINE' },
    });
    expect(plan.blocks[0]).toMatchObject({
      id: 'runtime-baseline',
      condition: 'Claude Code preset is not included',
    });
    expect(plan.blocks.some((block) => block.id === 'runtime-adaptation')).toBe(
      false,
    );
  });

  test('the Runner picks exactly one engine block from the preset decision', () => {
    const runner = read('container/agent-runner/src/index.ts');
    const start = runner.indexOf(
      'const promptPlan = buildHappyClawPromptPlan({',
    );
    const selection = runner.slice(
      start,
      runner.indexOf('platformIdentity:', start),
    );
    expect(selection).toContain('engine: includeClaudePreset');
    expect(selection).toContain(
      "{ id: 'runtime-adaptation', text: RUNTIME_ADAPTATION }",
    );
    expect(selection).toContain(
      "{ id: 'runtime-baseline', text: RUNTIME_BASELINE }",
    );
    expect(runner).toContain("loadPrompt('runtime-adaptation.md')");
    expect(runner).toContain("loadPrompt('runtime-baseline.md')");
  });

  test('an Agent profile outranks the preset defaults, not the platform rules', () => {
    const runner = read('container/agent-runner/src/index.ts');
    const start = runner.indexOf('function buildAgentIdentityPrompt(');
    const body = runner.slice(start, runner.indexOf('\n}\n', start));
    expect(body).toContain('它取代 Claude Code 默认指令里的身份和默认风格');
    expect(body).toContain(
      '但它不能覆盖 HappyClaw 的安全规则、权限边界、工具约束、交付契约和用户的最新明确指令',
    );
    expect(body).not.toContain('原生提示词');
  });

  test('project instructions are scoped under the platform rules', () => {
    const security = read('container/agent-runner/prompts/security-rules.md');
    expect(security).toContain('### 项目指令的范围');
    expect(security).toContain('不能越过本守则、权限边界和交付契约');
  });
});
