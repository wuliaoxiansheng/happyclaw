import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Cpu, Gauge, Loader2, Settings2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';

/** One model a ChatGPT login may run, with the efforts this user may pick on it. */
export interface CodexModelChoice {
  value: string;
  label: string;
  /** Low to high; levels the user may not pick are not listed. */
  efforts: string[];
  /** What the model runs at when no effort is picked. */
  defaultEffort: string;
}

export interface CodexSelectionView {
  /** The configuration's own model: what "default" runs. */
  defaultModel: string;
  defaultEffort: string;
  /** `live` is the account's own list; anything else is a fallback. */
  source: string;
  /** The login was rejected and has to be redone before it can run. */
  needsReauth: boolean;
  models: CodexModelChoice[];
}

export interface SessionModelOption {
  id: string;
  name: string;
  kind: 'official' | 'third_party' | 'codex';
  enabled: boolean;
  model: string;
  /** False when the configuration holds no credential and would fail. */
  usable?: boolean;
  /** Present on ChatGPT configurations: the models and efforts to choose from. */
  codex?: CodexSelectionView;
}

export interface SessionModelSelection {
  selectedModelConfigId: string | null;
  /** Older servers do not send the next two. */
  selectedModel?: string | null;
  selectedEffort?: string | null;
  default: {
    source: 'agent' | 'default' | 'single' | 'pool' | 'workspace_env' | 'none';
    modelConfigId: string | null;
    enabledCount: number;
  };
  options: SessionModelOption[];
}

const DEFAULT_VALUE = '__default__';

const KIND_LABELS: Record<SessionModelOption['kind'], string> = {
  official: 'Claude 官方',
  codex: 'ChatGPT 订阅',
  third_party: '兼容接口',
};

/** Human label for "what the default resolves to" in this conversation. */
export function describeDefaultModel(selection: SessionModelSelection): string {
  const { source, modelConfigId, enabledCount } = selection.default;
  const named = selection.options.find((option) => option.id === modelConfigId);
  switch (source) {
    case 'agent':
    case 'default':
    case 'single':
      // A ChatGPT configuration is named by the model it runs.
      return (named?.codex ? named.codex.defaultModel : named?.name) ?? '默认';
    case 'pool':
      return `自动 · ${enabledCount} 个`;
    case 'workspace_env':
      return '工作区环境变量';
    default:
      return '系统默认';
  }
}

function defaultHint(selection: SessionModelSelection): string {
  switch (selection.default.source) {
    case 'agent':
      return '跟随智能体绑定的模型配置';
    case 'default':
      return '使用模型配置里设为默认的模型';
    case 'pool':
      return '未设置默认模型，在已启用的模型配置间自动选择';
    case 'workspace_env':
      return '使用工作区环境变量中的模型网关';
    case 'single':
      return '使用唯一启用的模型配置';
    default:
      return '使用系统设置';
  }
}

/** Whether a ChatGPT configuration can be chosen right now. */
function codexUsable(option: SessionModelOption): boolean {
  return option.usable !== false && !option.codex?.needsReauth;
}

/** A ChatGPT login with models to list; the others are one row each. */
function hasModelList(option: SessionModelOption): boolean {
  return !!option.codex && option.codex.models.length > 0;
}

/** Why a ChatGPT login is listed but not (or not usually) chosen. */
function codexStatus(option: SessionModelOption): string {
  if (option.usable === false) return '缺少凭据';
  if (option.codex?.needsReauth) return '需重新登录';
  return option.enabled ? '' : '未启用';
}

/** What a radio of the model menu stands for. */
interface ModelChoiceTarget {
  modelConfigId: string;
  model: string | null;
}

function configValue(id: string): string {
  return `cfg:${id}`;
}

function modelValue(id: string, model: string): string {
  return `mdl:${id}:${model}`;
}

/**
 * The configuration, model and effort the conversation actually runs on, when
 * that is a ChatGPT login the effort button can act on. An automatic pool, a
 * workspace override or another kind of configuration has none.
 */
export function resolveEffortContext(selection: SessionModelSelection): {
  option: SessionModelOption;
  codex: CodexSelectionView;
  model: CodexModelChoice | null;
  /** Null when the conversation follows the default effort. */
  effort: string | null;
  /** The model to send back with an effort: only an explicit pick. */
  pinnedModel: string | null;
} | null {
  const { selectedModelConfigId, default: fallback } = selection;
  const configId =
    selectedModelConfigId ??
    (fallback.source === 'agent' ||
    fallback.source === 'default' ||
    fallback.source === 'single'
      ? fallback.modelConfigId
      : null);
  const option = selection.options.find((item) => item.id === configId);
  if (!option?.codex) return null;
  const pinnedModel = selectedModelConfigId
    ? (selection.selectedModel ?? null)
    : null;
  const modelValueInUse = pinnedModel ?? option.codex.defaultModel;
  return {
    option,
    codex: option.codex,
    model:
      option.codex.models.find((item) => item.value === modelValueInUse) ??
      null,
    effort: selectedModelConfigId ? (selection.selectedEffort ?? null) : null,
    pinnedModel,
  };
}

/** Compact trigger look shared by the model and the effort buttons. */
const TRIGGER_CLASS =
  'inline-flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 text-micro font-medium text-muted-foreground transition-colors duration-100 hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground pointer-coarse:h-10';

interface ModelSelectorProps {
  groupJid: string;
  /** Runtime Session id; null addresses the main conversation. */
  agentId: string | null;
  canChange: boolean;
}

export function ModelSelector({
  groupJid,
  agentId,
  canChange,
}: ModelSelectorProps) {
  const navigate = useNavigate();
  const canManageModels = useAuthStore((s) =>
    s.hasPermission('manage_system_config'),
  );
  const [selection, setSelection] = useState<SessionModelSelection | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const lastRefreshAt = useRef(0);
  // Bumped by every save: a look-up that started before one must not put an
  // older selection back over the saved one.
  const saves = useRef(0);
  const basePath = `/api/groups/${encodeURIComponent(groupJid)}/model-selection`;
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';

  const load = useCallback(async () => {
    try {
      setSelection(await api.get<SessionModelSelection>(`${basePath}${query}`));
    } catch {
      // Older server or no access: the picker simply stays hidden.
      setSelection(null);
    }
  }, [basePath, query]);

  useEffect(() => {
    lastRefreshAt.current = Date.now();
    void load();
  }, [load]);

  // The first list of a ChatGPT login is the global catalog until the server
  // has fetched the account's own: look again when the menu is opened. A
  // failed look keeps what is shown.
  const refreshCatalog = useCallback(
    (open: boolean) => {
      if (
        !open ||
        Date.now() - lastRefreshAt.current < 5_000 ||
        !selection?.options.some(
          (option) => option.codex && option.codex.source !== 'live',
        )
      ) {
        return;
      }
      lastRefreshAt.current = Date.now();
      const startedAt = saves.current;
      api
        .get<SessionModelSelection>(`${basePath}${query}`)
        .then((next) => {
          if (saves.current === startedAt) setSelection(next);
        })
        .catch(() => {});
    },
    [basePath, query, selection],
  );

  const save = async (
    body: {
      modelConfigId: string | null;
      model?: string | null;
      effort?: string | null;
    },
    success: (next: SessionModelSelection) => string,
  ) => {
    if (saving) return;
    saves.current += 1;
    setSaving(true);
    try {
      const next = await api.put<SessionModelSelection>(basePath, {
        agentId,
        ...body,
      });
      setSelection(next);
      toast.success(success(next));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '切换模型失败');
      void load();
    } finally {
      setSaving(false);
    }
  };

  if (!selection || selection.options.length === 0) return null;

  // value → what picking it means; non-ChatGPT configurations keep one radio.
  const targets = new Map<string, ModelChoiceTarget>();
  for (const option of selection.options) {
    targets.set(configValue(option.id), {
      modelConfigId: option.id,
      model: null,
    });
    for (const model of option.codex?.models ?? []) {
      if (model.value === option.codex?.defaultModel) continue;
      targets.set(modelValue(option.id, model.value), {
        modelConfigId: option.id,
        model: model.value,
      });
    }
  }

  const selected = selection.options.find(
    (option) => option.id === selection.selectedModelConfigId,
  );
  const effortContext = resolveEffortContext(selection);
  const hasCodex = selection.options.some((option) => option.codex);
  const selectedModel =
    selected?.codex && selection.selectedModel ? selection.selectedModel : null;
  const radioValue = !selected
    ? DEFAULT_VALUE
    : selectedModel && selectedModel !== selected.codex?.defaultModel
      ? modelValue(selected.id, selectedModel)
      : configValue(selected.id);
  // A ChatGPT configuration is named by the model it runs; the others by name.
  const triggerLabel = selected
    ? selected.codex
      ? (selectedModel ?? selected.codex.defaultModel)
      : selected.name
    : `默认 · ${describeDefaultModel(selection)}`;

  const handleChange = (value: string) => {
    const target =
      value === DEFAULT_VALUE
        ? ({ modelConfigId: '', model: null } as const)
        : targets.get(value);
    if (!target || saving) return;
    const modelConfigId = target.modelConfigId || null;
    if (
      modelConfigId === selection.selectedModelConfigId &&
      (target.model ?? null) === (selectedModel ?? null)
    ) {
      return;
    }
    const option = selection.options.find((item) => item.id === modelConfigId);
    if (!option?.codex) {
      // Exactly the request older servers understand.
      void save({ modelConfigId }, (next) => {
        const picked = next.options.find((item) => item.id === modelConfigId);
        return picked
          ? `已切换到「${picked.name}」，从下一条消息开始生效`
          : '已恢复默认模型，从下一条消息开始生效';
      });
      return;
    }
    // A model keeps the effort picked before only if it has that level;
    // otherwise the conversation returns to the model's default.
    const modelInUse = target.model ?? option.codex.defaultModel;
    const choice = option.codex.models.find(
      (item) => item.value === modelInUse,
    );
    const keptEffort =
      modelConfigId === selection.selectedModelConfigId
        ? (selection.selectedEffort ?? null)
        : null;
    const effort =
      keptEffort && choice?.efforts.includes(keptEffort) ? keptEffort : null;
    void save(
      {
        modelConfigId,
        model: target.model,
        effort,
      },
      () => {
        const base = `已切换到「${option.name} · ${modelInUse}」，从下一条消息开始生效`;
        return keptEffort && !effort && choice
          ? `${base}；该模型不支持 ${keptEffort}，档位已恢复为默认（${choice.defaultEffort}）`
          : base;
      },
    );
  };

  const handleEffort = (value: string) => {
    if (!effortContext || saving) return;
    const effort = value === DEFAULT_VALUE ? null : value;
    if (effort === effortContext.effort) return;
    void save(
      {
        modelConfigId: effortContext.option.id,
        model: effortContext.pinnedModel,
        effort,
      },
      () =>
        effort
          ? `推理档位已设为 ${effort}，从下一个请求开始生效`
          : '已恢复默认推理档位，从下一个请求开始生效',
    );
  };

  return (
    <>
      <DropdownMenu onOpenChange={refreshCatalog}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={!canChange || saving}
            aria-label={`模型：${triggerLabel}`}
            title={canChange ? '选择本会话使用的模型' : `模型：${triggerLabel}`}
            className={cn(
              'ml-0.5 max-w-[min(46vw,220px)]',
              hasCodex && 'max-sm:max-w-[min(30vw,160px)]',
              TRIGGER_CLASS,
              selected && 'text-foreground',
            )}
          >
            {saving ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <Cpu className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{triggerLabel}</span>
            {canChange && (
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          collisionPadding={8}
          className="w-72 max-w-[calc(100vw-2rem)]"
        >
          <DropdownMenuLabel>本会话使用的模型</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={radioValue}
            onValueChange={handleChange}
          >
            <DropdownMenuRadioItem value={DEFAULT_VALUE}>
              <span className="min-w-0">
                <span className="block truncate">
                  默认 · {describeDefaultModel(selection)}
                </span>
                <span className="block truncate text-micro text-muted-foreground">
                  {defaultHint(selection)}
                </span>
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {selection.options.map((option, index) => {
              const group = hasModelList(option);
              // A ChatGPT login's models form a group of their own; plain
              // configurations stay one row each without dividers.
              const divided =
                index > 0 &&
                (group || hasModelList(selection.options[index - 1]));
              return (
                <Fragment key={option.id}>
                  {divided && <DropdownMenuSeparator />}
                  {group && option.codex ? (
                    <>
                      <DropdownMenuLabel className="flex items-center gap-1">
                        <span className="min-w-0 truncate">{option.name}</span>
                        {codexStatus(option) && (
                          <span className="shrink-0 font-normal">
                            · {codexStatus(option)}
                          </span>
                        )}
                      </DropdownMenuLabel>
                      {option.id === selected?.id &&
                        selectedModel &&
                        selectedModel !== option.codex.defaultModel &&
                        !option.codex.models.some(
                          (model) => model.value === selectedModel,
                        ) && (
                          // Kept so the menu shows what is really selected.
                          <DropdownMenuRadioItem
                            value={modelValue(option.id, selectedModel)}
                          >
                            <span className="flex min-w-0 items-baseline gap-2">
                              <span className="shrink-0 font-mono text-caption">
                                {selectedModel}
                              </span>
                              <span className="truncate text-micro text-muted-foreground">
                                不在账号的模型列表里
                              </span>
                            </span>
                          </DropdownMenuRadioItem>
                        )}
                      {option.codex.models.map((model) => {
                        const isDefault =
                          model.value === option.codex?.defaultModel;
                        return (
                          <DropdownMenuRadioItem
                            key={model.value}
                            value={
                              isDefault
                                ? configValue(option.id)
                                : modelValue(option.id, model.value)
                            }
                            disabled={!codexUsable(option)}
                          >
                            <span className="flex min-w-0 items-baseline gap-2">
                              <span className="shrink-0 font-mono text-caption">
                                {model.value}
                              </span>
                            </span>
                          </DropdownMenuRadioItem>
                        );
                      })}
                    </>
                  ) : (
                    <DropdownMenuRadioItem
                      value={configValue(option.id)}
                      disabled={option.usable === false}
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{option.name}</span>
                        <span className="block truncate text-micro text-muted-foreground">
                          {KIND_LABELS[option.kind]}
                          {option.model ? ` · ${option.model}` : ''}
                          {option.usable === false
                            ? ' · 缺少凭据'
                            : option.enabled
                              ? ''
                              : ' · 未启用'}
                        </span>
                      </span>
                    </DropdownMenuRadioItem>
                  )}
                </Fragment>
              );
            })}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <p className="px-2 py-1 text-micro leading-4 text-muted-foreground">
            {hasCodex
              ? '切换模型配置或 ChatGPT 模型会开启新的底层会话，并自动带上最近的对话记录；只调整推理档位不会。'
              : '切换到不同的模型配置会开启新的底层会话，并自动带上最近的对话记录。'}
          </p>
          {canManageModels && (
            <DropdownMenuItem onClick={() => navigate('/settings?tab=claude')}>
              <Settings2 />
              管理模型配置
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {hasCodex && (
        <EffortMenu
          context={effortContext}
          disabled={!canChange || saving}
          onPick={handleEffort}
        />
      )}
    </>
  );
}

interface EffortMenuProps {
  context: ReturnType<typeof resolveEffortContext>;
  disabled: boolean;
  onPick: (value: string) => void;
}

/** The reasoning effort button, next to the model button. */
function EffortMenu({ context, disabled, onPick }: EffortMenuProps) {
  const choice = context?.model ?? null;
  const unavailable =
    !context || !choice || !codexUsable(context.option) || disabled;
  const effective = context?.effort ?? choice?.defaultEffort ?? null;
  const following = !!context && !context.effort;
  const label = effective
    ? following
      ? `默认 · ${effective}`
      : effective
    : '档位';
  const title = !context
    ? '自动选择模型配置时无法设置推理档位，请先选择一个 ChatGPT 模型'
    : !choice
      ? '当前模型不在账号的模型列表里，无法设置推理档位'
      : `推理档位：${effective}${following ? '（默认）' : ''}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={unavailable}
          aria-label={`推理档位：${effective ?? '不可用'}${following ? '（默认）' : ''}`}
          title={title}
          className={cn(
            TRIGGER_CLASS,
            'shrink-0',
            context?.effort && 'text-foreground',
          )}
        >
          <Gauge className="size-3.5 shrink-0" />
          <span className="font-mono max-sm:sr-only">{label}</span>
          {!unavailable && (
            <ChevronDown className="size-3 shrink-0 opacity-60 max-sm:hidden" />
          )}
        </button>
      </DropdownMenuTrigger>
      {choice && (
        <DropdownMenuContent
          align="start"
          side="top"
          collisionPadding={8}
          className="w-56 max-w-[calc(100vw-2rem)]"
        >
          <DropdownMenuLabel>推理档位</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={context?.effort ?? DEFAULT_VALUE}
            onValueChange={onPick}
          >
            <DropdownMenuRadioItem value={DEFAULT_VALUE}>
              <span className="min-w-0">
                <span className="block truncate">
                  默认 ·{' '}
                  <span className="font-mono">{choice.defaultEffort}</span>
                </span>
                <span className="block truncate text-micro text-muted-foreground">
                  跟随智能体或模型配置
                </span>
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuSeparator />
            {choice.efforts.map((effort) => (
              <DropdownMenuRadioItem key={effort} value={effort}>
                <span className="font-mono">{effort}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <p className="px-2 py-1 text-micro leading-4 text-muted-foreground">
            只影响推理深度，从下一个请求开始生效，不会重置会话。后台小任务固定使用
            low。
          </p>
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
