import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import { confirmDialog } from '../../stores/confirm';
import type { AgentProfile } from '../../types';
import { getAgentProfileDisplayName } from '../../utils/agent-product';
import type { ProvidersListResponse, UnifiedProviderPublic } from './types';
import { getErrorMessage } from './types';
import { ProviderList } from './ProviderList';
import { AddModelWizardDialog } from './AddModelWizard';
import {
  ConnectionDetailDialog,
  type ConnectionUpdate,
} from './ConnectionDetailDialog';
import {
  PROVIDERS_API,
  errorCopy,
  testConnection,
  testOutcome,
} from './model-connections';
import { SettingsSection } from './SettingsLayout';

interface ClaudeProviderSectionProps {
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

/**
 * The caller's Agents bound to a connection, by name. Best effort: the
 * server refuses the delete either way while any Agent is bound.
 */
async function boundAgentNames(connectionId: string): Promise<string[]> {
  try {
    const data = await api.get<{ profiles: AgentProfile[] }>(
      '/api/agent-profiles',
    );
    return data.profiles
      .filter((profile) => profile.model_config_id === connectionId)
      .map((profile) =>
        profile.is_default
          ? getAgentProfileDisplayName(profile.name)
          : profile.name,
      );
  } catch {
    return [];
  }
}

/** Settings › 模型连接: add connections and keep them working. */
export function ClaudeProviderSection({
  setNotice,
  setError,
}: ClaudeProviderSectionProps) {
  const [providers, setProviders] = useState<UnifiedProviderPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  // 添加向导与连接详情；详情跟随列表刷新，按 id 取最新数据
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing =
    providers.find((provider) => provider.id === editingId) ?? null;

  const loadProviders = useCallback(async () => {
    try {
      const data = await api.get<ProvidersListResponse>(PROVIDERS_API);
      setProviders(data.providers);
    } catch (err) {
      setError(getErrorMessage(err, '加载模型连接失败'));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const handleDelete = useCallback(
    async (provider: UnifiedProviderPublic) => {
      const agents = await boundAgentNames(provider.id);
      if (agents.length > 0) {
        setError(
          `智能体「${agents.join('」「')}」绑定了「${provider.name}」，先在智能体设置里改选其他连接再删除`,
        );
        return;
      }
      const confirmed = await confirmDialog({
        title: '删除模型连接',
        message: `确认删除模型连接「${provider.name}」？对话里选了它的会改回智能体的默认模型。`,
        confirmText: '确认删除',
        variant: 'danger',
      });
      if (!confirmed) return;
      setDeletingId(provider.id);
      try {
        await api.delete(`${PROVIDERS_API}/${encodeURIComponent(provider.id)}`);
        setNotice(`已删除模型连接「${provider.name}」`);
        await loadProviders();
      } catch (err) {
        setError(getErrorMessage(err, '删除模型连接失败'));
      } finally {
        setDeletingId(null);
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 单个连接的变更：带字段时就地更新该行，否则整体重新加载 ─────
  const handleConnectionChanged = useCallback(
    (update?: ConnectionUpdate) => {
      if (!update) {
        void loadProviders();
        return;
      }
      setProviders((prev) =>
        prev.map((provider) =>
          provider.id === update.id ? { ...provider, ...update } : provider,
        ),
      );
    },
    [loadProviders],
  );

  // ─── 测试连接（服务端记录 lastTest）────────────────────────────
  const handleTest = useCallback(
    async (provider: UnifiedProviderPublic) => {
      setTestingId(provider.id);
      try {
        const result = await testConnection({ providerId: provider.id });
        const outcome = testOutcome(result);
        if (outcome.ok) {
          setNotice(`「${provider.name}」连接成功`);
        } else {
          const copy = errorCopy(outcome.code);
          setError(`「${provider.name}」${copy.title}：${copy.hint}`);
        }
        // The server stored the result, and may have stored the header the
        // test proved; read the list again.
        await loadProviders().catch(() => {});
      } catch (err) {
        setError(getErrorMessage(err, '测试连接失败'));
      } finally {
        setTestingId(null);
      }
    },
    [loadProviders, setNotice, setError],
  );

  const handleAdd = useCallback(() => setWizardOpen(true), []);
  const busy = loading || deletingId !== null;

  if (loading && providers.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="模型连接"
        description={`${providers.length} 个连接；每个连接可以提供多个模型，聊天和智能体都可以选用。`}
        actions={
          providers.length > 0 && (
            <Button onClick={handleAdd} disabled={busy}>
              <Plus />
              添加模型连接
            </Button>
          )
        }
      >
        <ProviderList
          providers={providers}
          onEdit={(provider) => setEditingId(provider.id)}
          onTest={(provider) => void handleTest(provider)}
          testingId={testingId}
          onDelete={(provider) => void handleDelete(provider)}
          onAdd={handleAdd}
          deletingId={deletingId}
          disabled={busy}
        />
      </SettingsSection>

      <AddModelWizardDialog
        open={wizardOpen}
        onClose={({ saved, verified, created }) => {
          setWizardOpen(false);
          if (saved) {
            setNotice(
              verified
                ? `已添加模型连接「${saved.name}」`
                : `已添加模型连接「${saved.name}」，尚未验证`,
            );
          } else if (created) {
            setNotice(
              `已创建模型连接「${created.name}」，可以在列表里继续配置`,
            );
          }
          if (saved || created) void loadProviders();
        }}
      />

      <ConnectionDetailDialog
        provider={editing}
        onClose={() => setEditingId(null)}
        onChanged={handleConnectionChanged}
        setNotice={setNotice}
        setError={setError}
      />
    </div>
  );
}
