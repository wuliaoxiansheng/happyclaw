import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadErrorNotice } from '@/components/common/LoadErrorNotice';
import { useMediaQuery } from '../hooks/useMediaQuery';
import {
  matchesAutomationFilter,
  type AutomationFilter,
} from '../lib/automation-presentation';
import { useAutomationsStore } from '../stores/automations';
import { useIsGuest } from '../stores/auth';
import { AutomationList } from '../components/automations/AutomationList';
import { AutomationDetail } from '../components/automations/AutomationDetail';
import { automationHref } from '../components/automations/automation-actions';
import {
  PhonePageHeader,
  PhoneBarButton,
} from '../components/layout/PhonePageHeader';

/**
 * 自动化: the list on the left and the selected automation's detail on the
 * right. Below the desktop width the list and the detail are two screens
 * (`/automations` and `/automations/:id`).
 */
export function AutomationsPage() {
  const navigate = useNavigate();
  const { automationId } = useParams();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const automations = useAutomationsStore((s) => s.automations);
  const loaded = useAutomationsStore((s) => s.loaded);
  const loading = useAutomationsStore((s) => s.loading);
  const error = useAutomationsStore((s) => s.error);
  const loadAutomations = useAutomationsStore((s) => s.loadAutomations);
  const openCreateForm = useAutomationsStore((s) => s.openCreateForm);
  const [filter, setFilter] = useState<AutomationFilter>('all');
  // Read-only guests see the automations of granted workspaces, nothing more.
  const isGuest = useIsGuest();

  const routed = automationId
    ? automations.find((item) => item.id === automationId)
    : undefined;
  // A desktop opens on the first automation listed.
  const selected =
    routed ??
    (isDesktop && !automationId
      ? automations.find((item) => matchesAutomationFilter(item, filter))
      : undefined);
  const select = (id: string) => navigate(automationHref(id));
  const create = isGuest ? undefined : () => openCreateForm();

  // A phone names the page in its top bar, with 新建 as the one action.
  const header = (
    <div className="flex items-center justify-between gap-2 px-4 pt-5 pb-3 lg:pt-6 phone:hidden">
      <h1 className="text-title-lg text-foreground">自动化</h1>
      {create && (
        <Button size="sm" onClick={create}>
          <Plus />
          新建
        </Button>
      )}
    </div>
  );
  const list = (
    <AutomationList
      automations={automations}
      filter={filter}
      onFilterChange={setFilter}
      selectedId={selected?.id ?? null}
      onSelect={select}
      onCreate={create}
      loading={loading && !loaded}
    />
  );
  const notFound = (
    <EmptyState
      icon={Timer}
      title="找不到这个自动化"
      description="它可能已被删除。"
      action={
        <Button variant="outline" onClick={() => navigate('/automations')}>
          返回列表
        </Button>
      }
    />
  );
  const errorNotice = error && !loaded && (
    <div className="p-4">
      <LoadErrorNotice
        title="自动化加载失败"
        message={error}
        onRetry={() => void loadAutomations()}
      />
    </div>
  );

  if (!isDesktop) {
    if (automationId) {
      if (routed)
        return (
          <AutomationDetail
            automation={routed}
            onBack={() => navigate('/automations')}
          />
        );
      return (
        <>
          <PhonePageHeader
            title="自动化"
            onBack={() => navigate('/automations')}
          />
          {loaded ? notFound : null}
        </>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PhonePageHeader
          title="自动化"
          action={
            create && (
              <PhoneBarButton
                label="新建自动化"
                icon={<Plus className="size-5" />}
                onClick={create}
              />
            )
          }
        />
        {header}
        {errorNotice || list}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <aside
        aria-label="自动化列表"
        className="flex w-80 shrink-0 flex-col border-r border-surface-border"
      >
        {header}
        {errorNotice || list}
      </aside>
      <main className="min-w-0 flex-1">
        {selected ? (
          <AutomationDetail key={selected.id} automation={selected} />
        ) : (
          loaded &&
          (automationId
            ? notFound
            : automations.length > 0 && (
                <EmptyState
                  icon={Timer}
                  title="选择一个自动化"
                  description="在左侧选择以查看详情和运行记录。"
                />
              ))
        )}
      </main>
    </div>
  );
}
