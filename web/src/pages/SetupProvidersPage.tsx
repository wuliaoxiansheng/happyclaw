import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  Loader2,
  ShieldCheck,
  SkipForward,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { PageContainer } from '@/components/common';
import { AddModelWizard } from '@/components/settings/AddModelWizard';
import {
  SettingsField,
  SettingsGroup,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../api/client';
import type { UnifiedProviderPublic } from '../components/settings/types';
import { getErrorMessage } from '../components/settings/types';
import { useAuthStore } from '../stores/auth';

export function SetupProvidersPage() {
  const navigate = useNavigate();
  const { user, setupStatus, checkAuth, initialized } = useAuthStore();

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The connection the wizard saved, or one an OAuth login already created.
  const [connection, setConnection] = useState<{
    provider: UnifiedProviderPublic;
    finished: boolean;
    verified: boolean;
  } | null>(null);

  // Feishu (no prefilled defaults)
  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');

  useEffect(() => {
    if (user === null && initialized === true) {
      navigate('/login', { replace: true });
    } else if (user && user.role !== 'admin') {
      navigate('/chat', { replace: true });
    }
  }, [user, initialized, navigate]);

  useEffect(() => {
    if (setupStatus && !setupStatus.needsSetup) {
      navigate('/settings?tab=claude', { replace: true });
    }
  }, [setupStatus, navigate]);

  const handleFinish = async () => {
    setError(null);

    if (feishuAppSecret.trim() && !feishuAppId.trim()) {
      setError('填写飞书 Secret 时，App ID 也必须填写');
      return;
    }
    if (feishuAppId.trim() && !feishuAppSecret.trim()) {
      setError('填写飞书 App ID 时，App Secret 也必须填写');
      return;
    }

    setSaving(true);
    try {
      // Feishu is optional. Only save when user entered anything.
      if (feishuAppId.trim() || feishuAppSecret.trim()) {
        await api.post('/api/channel-accounts', {
          provider: 'feishu',
          name: '默认飞书',
          enabled: true,
          is_default: true,
          credentials: {
            appId: feishuAppId.trim(),
            appSecret: feishuAppSecret.trim(),
          },
        });
      }

      await checkAuth();
      // 保存后确认初始化状态已生效，再进入后台
      const { setupStatus: latestStatus } = useAuthStore.getState();
      if (latestStatus?.needsSetup) {
        setError('模型连接已保存，但初始化状态还没有更新，请刷新页面后再试');
        return;
      }
      navigate('/settings?tab=claude', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err, '保存初始化配置失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="safe-area-top h-dvh overflow-y-auto bg-background">
      <PageContainer size="narrow" className="space-y-6">
        <header>
          <p className="text-caption text-muted-foreground">步骤 2/2</p>
          <h1 className="mt-1 text-title-lg text-foreground">系统接入初始化</h1>
          <p className="mt-1 text-body text-muted-foreground">
            添加一个模型连接即可开始对话；也可以暂时跳过，稍后在设置里添加。
          </p>
        </header>

        {error && (
          <div
            role="alert"
            className="rounded-lg bg-error/10 px-3 py-2 text-body text-error"
          >
            {error}
          </div>
        )}

        <SettingsSection
          title="模型连接"
          description="Claude / ChatGPT 订阅、Anthropic API Key、国内外厂商预设或任意兼容地址。"
        >
          <SettingsGroup>
            {connection?.finished ? (
              <div
                role="status"
                className="flex items-start gap-2 p-4 text-body"
              >
                <Check
                  className="mt-0.5 size-4 shrink-0 text-success"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <div className="text-foreground">
                    已添加模型连接「{connection.provider.name}」
                  </div>
                  <div className="text-caption text-muted-foreground">
                    {connection.verified
                      ? '连接测试通过。'
                      : '连接尚未验证，进入后台后可以在模型配置里重新测试。'}
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4">
                <AddModelWizard
                  layout="page"
                  onConnectionCreated={(provider) =>
                    setConnection({
                      provider,
                      finished: false,
                      verified: false,
                    })
                  }
                  onDone={(provider, verified) =>
                    setConnection({ provider, finished: true, verified })
                  }
                />
              </div>
            )}
          </SettingsGroup>
        </SettingsSection>

        <SettingsSection
          title="飞书配置（可选）"
          description="首装不预填任何默认值，全部由你手动输入。"
        >
          <SettingsGroup>
            <div className="grid gap-3 p-4 md:grid-cols-2">
              <SettingsField label="App ID" htmlFor="setup-feishu-app-id">
                <Input
                  id="setup-feishu-app-id"
                  type="text"
                  value={feishuAppId}
                  onChange={(e) => setFeishuAppId(e.target.value)}
                  placeholder="输入飞书 App ID"
                />
              </SettingsField>
              <SettingsField
                label="App Secret"
                htmlFor="setup-feishu-app-secret"
              >
                <Input
                  id="setup-feishu-app-secret"
                  type="password"
                  value={feishuAppSecret}
                  onChange={(e) => setFeishuAppSecret(e.target.value)}
                  placeholder="输入飞书 App Secret"
                />
              </SettingsField>
            </div>
          </SettingsGroup>
        </SettingsSection>

        <div className="flex flex-col gap-3 rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-2 text-caption text-muted-foreground">
            <ShieldCheck className="mt-px size-3.5 shrink-0" />
            {connection
              ? '模型连接已保存，后续可在设置 → 模型配置里继续管理。'
              : '先在上方添加一个模型连接，或暂不配置直接进入后台。'}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => navigate('/chat', { replace: true })}
            >
              <SkipForward />
              暂不配置，进入后台
            </Button>
            <Button
              type="button"
              onClick={handleFinish}
              disabled={saving || !connection}
            >
              {saving && <Loader2 className="animate-spin" />}
              完成并进入后台
              <ArrowRight />
            </Button>
          </div>
        </div>
      </PageContainer>
    </div>
  );
}
