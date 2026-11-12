import { Link } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { useAuthStore } from '@/stores/auth';
import type { AgentModelResolution } from '@/types';

const SOURCE_LABELS: Record<AgentModelResolution['source'], string> = {
  session: '会话手选',
  agent: '智能体绑定',
  owner_main: '跟随主智能体',
  system_main: '跟随主 HappyClaw',
  workspace_env: '工作区环境变量',
  none: '未选择模型',
};

/**
 * An unsaved model binding to resolve instead of the saved one. Callers keep
 * it referentially stable (useMemo): the preview refetches when it changes.
 */
export interface ModelBinding {
  model_config_id: string | null;
  model: string | null;
}

/** The resolution from an effective-capabilities response, if it has one. */
export function readModelResolution(
  response: unknown,
): AgentModelResolution | null {
  const value = (response as { model_resolution?: AgentModelResolution })
    ?.model_resolution;
  return value && typeof value.source === 'string' ? value : null;
}

function describe(resolution: AgentModelResolution): string {
  if (resolution.connection_missing) {
    return '连接不可用，绑定的连接已删除或缺少凭据，运行会失败';
  }
  if (resolution.model_config_id) {
    return [resolution.model_config_name, resolution.model]
      .filter(Boolean)
      .join(' · ');
  }
  if (resolution.source === 'workspace_env') {
    return '使用工作区自带的 Provider 环境变量';
  }
  return '未选择模型';
}

/**
 * The connection and model a run of this Agent uses and which step of the
 * order chose it: conversation pick, the Agent's own binding, the workspace
 * env, the owner's main Agent or the system main HappyClaw. A binding whose
 * connection is gone or has no credential fails; it never falls back.
 */
export function ModelResolutionRow({
  resolution,
}: {
  resolution: AgentModelResolution | null;
}) {
  const canAddModel = useAuthStore((s) =>
    s.hasPermission('manage_system_config'),
  );
  if (!resolution) return null;
  const unset = resolution.source === 'none' && !resolution.connection_missing;
  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[120px_1fr] sm:items-start">
      <div className="text-caption font-medium text-muted-foreground">模型</div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span
          className={
            resolution.connection_missing
              ? 'text-caption text-warning'
              : unset
                ? 'text-caption text-error'
                : 'min-w-0 text-label break-all text-foreground'
          }
        >
          {describe(resolution)}
        </span>
        {unset ? (
          canAddModel ? (
            <Link
              to="/settings?tab=claude"
              className="text-caption text-primary-text hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              添加模型
            </Link>
          ) : (
            <span className="text-caption text-muted-foreground">
              请联系管理员添加模型
            </span>
          )
        ) : (
          <Badge variant="neutral">{SOURCE_LABELS[resolution.source]}</Badge>
        )}
      </div>
    </div>
  );
}
