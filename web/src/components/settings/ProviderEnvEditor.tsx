import { useState } from 'react';
import {
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  TriangleAlert,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { IconButton } from '@/components/common/IconButton';
import {
  CONNECTION_ENV_PREFILL,
  CONNECTION_MODEL_ENV_KEYS,
} from '@/lib/model-providers';
import type { EnvRow } from './types';

/** Keys the connection's own fields hold: address and credentials. */
const CREDENTIAL_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

/** Keys the launch derives from the models, windows and roles. */
const MODEL_ENV_KEYS: ReadonlySet<string> = new Set(CONNECTION_MODEL_ENV_KEYS);

const MODEL_ENV_KEY_HINT = '由模型设置决定';

/** Prefilled switches and timeouts: nothing secret, shown in the clear. */
const PLAIN_VALUE_KEYS: ReadonlySet<string> = new Set(
  Object.keys(CONNECTION_ENV_PREFILL),
);

const PROXY_ENV_KEY_RE = /^(https?|all|no)_proxy$/i;

/** A stored `customEnv` as editable rows, in stored order. */
export function envRowsFrom(customEnv: Record<string, string>): EnvRow[] {
  return Object.entries(customEnv).map(([key, value]) => ({ key, value }));
}

/**
 * The `customEnv` the server stores. A row without a value is not saved, so
 * the variable is not injected at all; a key the models or the credential
 * fields decide is refused.
 */
export function buildProviderCustomEnv(rows: readonly EnvRow[]): {
  customEnv: Record<string, string>;
  error: string | null;
} {
  const customEnv: Record<string, string> = {};
  for (const [idx, row] of rows.entries()) {
    const key = row.key.trim();
    const value = row.value;
    if (!key && !value.trim()) continue;
    if (!key) {
      return { customEnv: {}, error: `第 ${idx + 1} 行环境变量 Key 不能为空` };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return {
        customEnv: {},
        error: `环境变量 Key "${key}" 格式无效（需匹配 [A-Za-z_][A-Za-z0-9_]*）`,
      };
    }
    if (MODEL_ENV_KEYS.has(key)) {
      return {
        customEnv: {},
        error: `${key} ${MODEL_ENV_KEY_HINT}，请在模型列表或「后台与子代理」里设置`,
      };
    }
    if (CREDENTIAL_ENV_KEYS.has(key)) {
      return {
        customEnv: {},
        error: `${key} 由服务地址和密钥字段管理，请在对应字段中填写`,
      };
    }
    if (customEnv[key] !== undefined) {
      return { customEnv: {}, error: `环境变量 Key "${key}" 重复` };
    }
    if (!value.trim()) continue;
    customEnv[key] = value;
  }
  return { customEnv, error: null };
}

interface ProviderEnvEditorProps {
  value: EnvRow[];
  onChange: (next: EnvRow[]) => void;
  disabled?: boolean;
}

/** The collapsed 高级设置 block: the connection's own environment rows. */
export function ProviderEnvEditor({
  value,
  onChange,
  disabled = false,
}: ProviderEnvEditorProps) {
  const [shown, setShown] = useState<Record<number, boolean>>({});
  const proxyKeys = value
    .map((row) => row.key.trim())
    .filter((key) => PROXY_ENV_KEY_RE.test(key));
  const saved = value.filter((row) => row.key.trim() && row.value.trim());
  const updateRow = (index: number, field: keyof EnvRow, next: string) =>
    onChange(
      value.map((row, i) => (i === index ? { ...row, [field]: next } : row)),
    );

  return (
    <details className="group/env overflow-hidden rounded-lg ring-1 ring-surface-border">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-label text-foreground outline-none transition-colors duration-100 select-none hover:bg-surface-hover focus-visible:bg-surface-hover pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open/env:rotate-90"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">高级设置 · 环境变量</span>
        <span className="shrink-0 text-caption text-muted-foreground">
          {saved.length > 0 ? `${saved.length} 项` : '未设置'}
        </span>
      </summary>

      <div className="border-t border-surface-border px-3 py-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <p className="text-caption leading-5 text-muted-foreground">
            随这个连接的每次运行注入。值为空的行不会保存，也不会注入；模型、上下文和子代理在模型列表里设置。
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange([...value, { key: '', value: '' }])}
            disabled={disabled}
            className="shrink-0"
          >
            <Plus />
            添加
          </Button>
        </div>

        {proxyKeys.length > 0 && (
          <p className="mb-2 flex gap-1.5 text-caption leading-5 text-warning">
            <TriangleAlert
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            {proxyKeys.join('、')}
            会作用于 Agent 的全部网络请求（包括 Bash 和 MCP）；Container 模式下
            127.0.0.1 指向容器自身。建议改在系统或工作区层面配置代理。
          </p>
        )}
        {value.length === 0 ? (
          <p className="text-caption text-muted-foreground">
            没有环境变量，大多数连接无需添加。
          </p>
        ) : (
          <div className="space-y-3">
            {value.map((row, idx) => {
              const key = row.key.trim();
              const refused = MODEL_ENV_KEYS.has(key);
              const visible = shown[idx] ?? PLAIN_VALUE_KEYS.has(key);
              return (
                <div key={idx} className="space-y-1">
                  <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                    <Input
                      variant="code"
                      type="text"
                      value={row.key}
                      onChange={(e) => updateRow(idx, 'key', e.target.value)}
                      disabled={disabled}
                      placeholder="KEY"
                      aria-label={`第 ${idx + 1} 行环境变量 Key`}
                      aria-invalid={refused ? true : undefined}
                      className="w-full font-mono text-caption sm:w-[42%] md:text-caption"
                    />
                    <div className="flex min-w-0 flex-1 items-center gap-1">
                      {key === 'ANTHROPIC_CUSTOM_HEADERS' ? (
                        // Claude Code reads one `Name: value` per line.
                        <Textarea
                          variant="code"
                          value={row.value}
                          onChange={(e) =>
                            updateRow(idx, 'value', e.target.value)
                          }
                          disabled={disabled}
                          rows={2}
                          spellCheck={false}
                          placeholder={'X-Header: value\nX-Other: value'}
                          aria-label={`第 ${idx + 1} 行环境变量值`}
                          className="min-h-9 min-w-0 flex-1 font-mono text-caption md:text-caption"
                        />
                      ) : (
                        <Input
                          variant="code"
                          type={visible ? 'text' : 'password'}
                          value={row.value}
                          onChange={(e) =>
                            updateRow(idx, 'value', e.target.value)
                          }
                          disabled={disabled}
                          placeholder="留空则不注入"
                          aria-label={`第 ${idx + 1} 行环境变量值`}
                          className="min-w-0 flex-1 font-mono text-caption md:text-caption"
                        />
                      )}
                      <IconButton
                        label={visible ? '隐藏环境变量值' : '显示环境变量值'}
                        icon={visible ? <EyeOff /> : <Eye />}
                        onClick={() =>
                          setShown((current) => ({
                            ...current,
                            [idx]: !visible,
                          }))
                        }
                      />
                      <IconButton
                        label="删除环境变量"
                        icon={<X />}
                        onClick={() => {
                          setShown({});
                          onChange(value.filter((_, i) => i !== idx));
                        }}
                        disabled={disabled}
                        className="hover:text-destructive"
                      />
                    </div>
                  </div>
                  {refused && (
                    <p role="alert" className="text-caption text-error">
                      {key} {MODEL_ENV_KEY_HINT}，不能在这里设置
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}
