import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/common/IconButton';
import {
  effectiveProviderModels,
  getModelPreset,
  mergeDiscoveredModels,
  normalizeConnectionModelRoles,
  normalizeProviderModels,
  type ConnectionModelRoles,
  type ProviderModelEntry,
} from '@/lib/model-providers';
import {
  confirmProtocolChange,
  connectionKind,
  discoverModels,
  discoveredModelsFor,
  errorCopy,
  modelInUseAgents,
  presetModelName,
  updateConnection,
} from './model-connections';
import {
  ModelCapabilityFields,
  ModelRolesFields,
  withAddDefaults,
} from './ModelCapabilityFields';
import { ManualModelInput } from './ModelPicker';
import { getErrorMessage, type UnifiedProviderPublic } from './types';

interface ConnectionModelListProps {
  provider: UnifiedProviderPublic;
  /**
   * Third-party: roles for sub-agents and background calls, and added models
   * declare the registry's window.
   */
  thirdParty: boolean;
  onSaved: (provider: UnifiedProviderPublic) => void;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
}

/**
 * The models a connection offers, each with its context window and efforts,
 * and the connection's 后台与子代理 roles. Edits save at once and apply from
 * the next launch; removing a model stops the runners that may be on it, so
 * it asks first.
 */
export function ConnectionModelList({
  provider,
  thirdParty,
  onSaved,
  setNotice,
  setError,
}: ConnectionModelListProps) {
  const [models, setModels] = useState<ProviderModelEntry[]>(() =>
    effectiveProviderModels(provider),
  );
  const [roles, setRoles] = useState<ConnectionModelRoles>(
    provider.roles ?? {},
  );
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const preset = getModelPreset(provider.presetId);

  useEffect(() => {
    setModels(effectiveProviderModels(provider));
    setRoles(provider.roles ?? {});
    // The stored list changes only with the provider record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, provider.updatedAt]);

  const save = async (
    patch: {
      models?: ProviderModelEntry[];
      roles?: ConnectionModelRoles;
      anthropicModel?: string;
    },
    failure: string,
  ): Promise<boolean> => {
    const previous = { models, roles };
    if (patch.models) setModels(patch.models);
    if (patch.roles) setRoles(patch.roles);
    setBusy(true);
    try {
      const saved = await updateConnection(provider.id, patch);
      setModels(effectiveProviderModels(saved));
      setRoles(saved.roles ?? {});
      onSaved(saved);
      return true;
    } catch (err) {
      setModels(previous.models);
      setRoles(previous.roles);
      const agents = modelInUseAgents(err);
      setError(
        agents
          ? `这个模型正被智能体「${agents.join('」「')}」使用。先在智能体设置里改用其他模型，再删除。`
          : getErrorMessage(err, failure),
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveModels = (next: ProviderModelEntry[]) =>
    save({ models: next }, '保存模型列表失败');

  const remove = async (id: string) => {
    if (!(await confirmProtocolChange(provider))) return;
    const next = models.filter((entry) => entry.id !== id);
    await save(
      {
        models: next,
        // The connection's own model is always in its list: hand it on.
        ...(id === provider.anthropicModel
          ? { anthropicModel: next[0]?.id ?? '' }
          : {}),
        roles: normalizeConnectionModelRoles(roles, next),
      },
      '删除模型失败',
    );
  };

  const addManual = async (raw: string) => {
    const typed = normalizeProviderModels([raw])?.[0];
    if (!typed) return false;
    const { entry } = withAddDefaults(typed, thirdParty);
    if (models.some((other) => other.id === entry.id)) {
      setError(`列表里已经有 ${entry.id}`);
      return false;
    }
    const added = await saveModels([...models, entry]);
    if (added) setNotice(`已添加模型 ${entry.id}`);
    return added;
  };

  /** Adds what the vendor lists now; nothing already here is touched. */
  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await discoverModels({ providerId: provider.id });
      if (!result.ok) {
        const copy = errorCopy(result.code);
        setError(`没能获取模型列表：${copy.title}。${copy.hint}`);
        return;
      }
      const merged = mergeDiscoveredModels(
        models,
        discoveredModelsFor(connectionKind(provider), result.models),
      );
      // New models start the way the add flow starts them.
      const added = new Set(merged.added);
      merged.models = merged.models.map((entry) =>
        added.has(entry.id) ? withAddDefaults(entry, thirdParty).entry : entry,
      );
      if (merged.added.length === 0) {
        setNotice('没有发现新模型');
        return;
      }
      if (await saveModels(merged.models)) {
        setNotice(`新增 ${merged.added.length} 个模型`);
      }
    } catch (err) {
      setError(getErrorMessage(err, '获取模型列表失败'));
    } finally {
      setRefreshing(false);
    }
  };

  const disabled = busy || refreshing;

  return (
    <div className="space-y-3">
      {models.length === 0 ? (
        <p className="rounded-lg px-3 py-4 text-caption text-muted-foreground ring-1 ring-surface-border">
          还没有模型。获取模型列表或手动添加。
        </p>
      ) : (
        <ul
          aria-label="连接的模型"
          className="divide-y divide-surface-border overflow-hidden rounded-lg ring-1 ring-surface-border"
        >
          {models.map((entry) => {
            const name = presetModelName(preset, entry.id);
            return (
              <li key={entry.id} className="min-w-0 space-y-2 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-caption text-foreground">
                      {entry.id}
                    </div>
                    {name && (
                      <div className="truncate text-micro text-muted-foreground">
                        {name}
                      </div>
                    )}
                  </div>
                  <IconButton
                    label={
                      models.length > 1
                        ? `从连接中删除 ${entry.id}`
                        : '连接至少保留一个模型'
                    }
                    icon={<Trash2 />}
                    onClick={() => void remove(entry.id)}
                    disabled={disabled || models.length <= 1}
                    className="hover:text-destructive"
                  />
                </div>
                <ModelCapabilityFields
                  entry={entry}
                  showDefaultEffort
                  disabled={disabled}
                  onChange={(next) =>
                    void saveModels(
                      models.map((other) =>
                        other.id === entry.id ? next : other,
                      ),
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      {models.length > 0 && (
        <p className="text-caption text-muted-foreground">
          上下文和推理等级从下次启动会话时生效；智能体或对话选了推理等级时以它们为准。
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <ManualModelInput
          placeholder="手动添加模型名"
          onAdd={addManual}
          disabled={disabled}
        />
        <Button
          variant="ghost"
          onClick={() => void refresh()}
          disabled={disabled}
          title="从服务商获取模型列表：只添加新模型，不删除已有的"
        >
          {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          获取模型列表
        </Button>
      </div>

      {thirdParty && (
        <ModelRolesFields
          models={models.map((entry) => entry.id)}
          roles={roles}
          onChange={(next) =>
            void save({ roles: next }, '保存后台与子代理失败')
          }
          disabled={disabled}
        />
      )}
    </div>
  );
}
