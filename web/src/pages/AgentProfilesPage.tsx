import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useBeforeUnload,
  useBlocker,
  useLocation,
  useNavigate,
  useSearchParams,
  type BlockerFunction,
} from 'react-router-dom';
import {
  ArrowRight,
  Bot,
  Copy,
  Download,
  FileUp,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { PageContainer } from '@/components/common/PageContainer';
import { SearchInput } from '@/components/common/SearchInput';
import { sidebarRowClass } from '@/components/layout/sidebar/SidebarItem';
import {
  SettingsField,
  SettingsGroup,
  SettingsRow,
} from '@/components/settings/SettingsLayout';
import { modelBindingErrorMessage } from '@/components/settings/model-connections';
import { getErrorMessage } from '@/components/settings/types';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirm';
import { AgentSection } from '../components/agents/AgentSection';
import { AgentPromptAssistant } from '../components/agents/AgentPromptAssistant';
import { AgentPromptEditor } from '../components/agents/AgentPromptEditor';
import { EffectiveCapabilitiesPreview } from '../components/agents/EffectiveCapabilitiesPreview';
import { AgentGovernanceSection } from '../components/agents/AgentGovernanceSection';
import {
  AgentCapabilityForm,
  capabilityFormError,
  capabilityFormFromProfile,
  capabilityFormBinding,
  capabilityFormModelChanges,
  capabilityFormPolicy,
  type AgentCapabilityFormValue,
} from '../components/agents/AgentCapabilityForm';
import { CreateAgentDialog } from '../components/agents/CreateAgentDialog';
import {
  describeReferences,
  ImportAgentDialog,
} from '../components/agents/ImportAgentDialog';
import { EmojiAvatar } from '../components/common/EmojiAvatar';
import { ListGroup, ListRow } from '../components/common/ListRow';
import {
  PhonePageHeader,
  PhoneBarButton,
} from '../components/layout/PhonePageHeader';
import { useIsPhone } from '../components/layout/phone';
import { EmojiPicker } from '../components/common/EmojiPicker';
import { ColorPicker } from '../components/common/ColorPicker';
import { ErrorBoundary } from '../components/common/ErrorBoundary';
import {
  useAgentProfilesStore,
  type AgentHostGrant,
} from '../stores/agent-profiles';
import { useAuthStore, type AppearanceConfig } from '../stores/auth';
import { useSkillsStore } from '../stores/skills';
import { useMcpServersStore } from '../stores/mcp-servers';
import {
  getAgentContextSource,
  type AgentProfile,
  type AgentProfilePromptMode,
  type AgentContextSource,
  type AgentProfileRuntimePolicy,
} from '../types';
import { getCustomAgentProfiles } from '../utils/agent-product';
import {
  buildAgentPromptPatch,
  promptLengthError,
  type AgentPromptParts,
  type AgentPromptSection,
} from '../utils/agent-prompts';
import { countActiveConversations } from '../utils/agent-runtime-policy';
import { confirmRunnerRestart } from '../utils/agent-save-confirm';
import { createUnsavedNavigationGuard } from '../utils/unsaved-navigation';
import { downloadTextFile } from '../utils/download';
import { apiErrorBody } from '../utils/error';

const EMPTY_PROMPTS: AgentPromptParts = {
  identity_prompt: '',
  soul_prompt: '',
  agents_prompt: '',
  tools_prompt: '',
};

function promptsOf(profile: AgentProfile): AgentPromptParts {
  return {
    identity_prompt: profile.identity_prompt,
    soul_prompt: profile.soul_prompt,
    agents_prompt: profile.agents_prompt,
    tools_prompt: profile.tools_prompt,
  };
}

/** A profile's own avatar, falling back to the main HappyClaw appearance. */
function resolveAgentAvatar(
  avatar: {
    url: string | null;
    emoji: string | null;
    color: string | null;
  },
  main: AppearanceConfig | null,
) {
  const inherits = !avatar.url && !avatar.emoji && !avatar.color;
  return {
    imageUrl:
      avatar.url ||
      (inherits
        ? main?.aiAvatarUrl ||
          (main?.aiAvatarMode !== 'emoji'
            ? `${import.meta.env.BASE_URL}icons/icon-192.png`
            : undefined)
        : undefined),
    emoji:
      avatar.emoji ||
      (!avatar.url && !avatar.color && main?.aiAvatarMode === 'emoji'
        ? main.aiAvatarEmoji
        : undefined),
    color:
      avatar.color ||
      (!avatar.url && !avatar.emoji && main?.aiAvatarMode === 'emoji'
        ? main.aiAvatarColor
        : undefined),
  };
}

/** The saved policy in the shape the editor produces, for comparison. */
function comparablePolicy(profile: AgentProfile): AgentProfileRuntimePolicy {
  const policy = profile.runtime_policy;
  return {
    ...capabilityFormPolicy(capabilityFormFromProfile(profile)),
    context: {
      source: getAgentContextSource(policy),
      auto_compact_window: policy.context?.auto_compact_window ?? 0,
      auto_compact_percentage: policy.context?.auto_compact_percentage ?? 0,
    },
  };
}

function errorText(err: unknown, fallback: string): string {
  return modelBindingErrorMessage(err) ?? getErrorMessage(err, fallback);
}

function strippedHostNotice(stripped: AgentHostGrant[]): string | null {
  if (stripped.length === 0) return null;
  const parts = stripped.map((grant) =>
    grant === 'host_context' ? '宿主机 Claude Code 配置' : '宿主机 Skills',
  );
  return `只有管理员能使用${parts.join('和')}，新智能体已去掉这些设置`;
}

/** History state of a phone's step from the Agent list to one Agent. */
const FROM_AGENT_LIST = { agentList: true };

export function AgentProfilesPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigationGuardRef = useRef(createUnsavedNavigationGuard());
  const setAllowedSearchParams = useCallback(
    (
      next: URLSearchParams | Record<string, string>,
      options: { replace?: boolean; state?: unknown } = {},
    ) => {
      const normalized =
        next instanceof URLSearchParams ? next : new URLSearchParams(next);
      const serialized = normalized.toString();
      const token = navigationGuardRef.current.allowNext({
        pathname: location.pathname,
        search: serialized ? `?${serialized}` : '',
        hash: '',
      });
      setSearchParams(next, options);
      queueMicrotask(() => navigationGuardRef.current.cancelAllowance(token));
    },
    [location.pathname, setSearchParams],
  );
  const requestedProfileId = searchParams.get('agent');
  const {
    profiles,
    modelConfigs = [],
    inheritedModel = null,
    loading,
    profilesError,
    loadProfiles,
    loadProfileGovernance,
    retryRuntimeCleanup,
    governanceByProfile,
    governanceLoading,
    governanceErrors,
    updateProfile,
    uploadProfileAvatar,
    removeProfileAvatar,
    deleteProfile,
    migrateAndDeleteProfile,
    duplicateProfile,
    exportProfile,
    setWorkspaceAgentProfile,
  } = useAgentProfilesStore();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [currentPrompts, setCurrentPrompts] =
    useState<AgentPromptParts>(EMPTY_PROMPTS);
  const [promptMode, setPromptMode] =
    useState<AgentProfilePromptMode>('append');
  const [assistantSection, setAssistantSection] =
    useState<AgentPromptSection>('identity');
  const [avatarEmoji, setAvatarEmoji] = useState<string | null>(null);
  const [avatarColor, setAvatarColor] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarStyleOpen, setAvatarStyleOpen] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [capabilities, setCapabilities] =
    useState<AgentCapabilityFormValue | null>(null);
  const [contextSource, setContextSource] =
    useState<AgentContextSource>('managed');
  const [useSdkCompactDefault, setUseSdkCompactDefault] = useState(true);
  const [autoCompactPercentage, setAutoCompactPercentage] = useState('80');
  const [legacyAutoCompactWindow, setLegacyAutoCompactWindow] = useState(0);
  const [runtimeCleanupRepairing, setRuntimeCleanupRepairing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [movingWorkspaceJid, setMovingWorkspaceJid] = useState<string | null>(
    null,
  );
  const [workspaceMoveTargets, setWorkspaceMoveTargets] = useState<
    Record<string, string>
  >({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [listQuery, setListQuery] = useState('');
  const isAdmin = useAuthStore((state) => state.user?.role === 'admin');
  const mainAppearance = useAuthStore((state) => state.appearance);

  const customProfiles = useMemo(
    () => getCustomAgentProfiles(profiles),
    [profiles],
  );
  const visibleProfiles = useMemo(() => {
    const query = listQuery.trim().toLowerCase();
    if (!query) return customProfiles;
    return customProfiles.filter(
      (profile) =>
        profile.name.toLowerCase().includes(query) ||
        profile.identity_prompt.toLowerCase().includes(query),
    );
  }, [customProfiles, listQuery]);

  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const loadMcpServers = useMcpServersStore((state) => state.loadServers);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    void loadSkills();
    void loadMcpServers();
  }, [loadMcpServers, loadSkills]);

  useEffect(() => {
    if (
      requestedProfileId &&
      customProfiles.some((profile) => profile.id === requestedProfileId)
    ) {
      if (selectedId !== requestedProfileId) {
        setSelectedId(requestedProfileId);
      }
      return;
    }
    if (isPhone && !requestedProfileId) {
      // A phone lists the Agents until one is opened (`?agent=`).
      if (selectedId) setSelectedId(null);
      return;
    }
    if (
      selectedId &&
      customProfiles.some((profile) => profile.id === selectedId)
    ) {
      if (requestedProfileId && requestedProfileId !== selectedId) {
        setAllowedSearchParams({ agent: selectedId }, { replace: true });
      }
      return;
    }
    const fallbackId = customProfiles[0]?.id ?? null;
    if (!fallbackId) {
      // Nothing listed (yet): a deep link keeps its Agent for when the list
      // arrives instead of being rewritten to an empty selection.
      if (selectedId) setSelectedId(null);
      return;
    }
    setSelectedId(fallbackId);
    if (requestedProfileId) {
      setAllowedSearchParams({ agent: fallbackId }, { replace: true });
    }
  }, [
    customProfiles,
    isPhone,
    requestedProfileId,
    selectedId,
    setAllowedSearchParams,
  ]);

  const selected = useMemo(
    () => customProfiles.find((profile) => profile.id === selectedId) ?? null,
    [customProfiles, selectedId],
  );

  useEffect(() => {
    if (!selected || location.hash !== '#agent-capabilities') return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById('agent-capabilities')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.hash, selected]);

  // Load the editor from the selected profile; switching Agents discards the
  // previous one's edits (the navigation guard asked first).
  useEffect(() => {
    if (!selected) {
      setCapabilities(null);
      return;
    }
    setName(selected.name);
    setCurrentPrompts(promptsOf(selected));
    setPromptMode(selected.prompt_mode);
    setAvatarEmoji(selected.avatar_emoji);
    setAvatarColor(selected.avatar_color);
    setAvatarUrl(selected.avatar_url);
    setAvatarStyleOpen(!!(selected.avatar_emoji || selected.avatar_color));
    setCapabilities(capabilityFormFromProfile(selected));
    const policy = selected.runtime_policy;
    setContextSource(getAgentContextSource(policy));
    const compactWindow = policy.context?.auto_compact_window ?? 0;
    const compactPercentage = policy.context?.auto_compact_percentage ?? 0;
    setUseSdkCompactDefault(compactWindow === 0 && compactPercentage === 0);
    setAutoCompactPercentage(
      compactPercentage > 0
        ? String(compactPercentage)
        : compactWindow > 0
          ? 'legacy'
          : '80',
    );
    setLegacyAutoCompactWindow(compactWindow);
  }, [selected?.id]);

  useEffect(() => {
    if (!selected) return;
    void loadProfileGovernance(selected.id).catch((err) => {
      toast.error(errorText(err, '加载智能体治理数据失败'));
    });
  }, [loadProfileGovernance, selected?.id]);

  const autoCompactError = useMemo(() => {
    if (useSdkCompactDefault) return null;
    if (autoCompactPercentage === 'legacy') return null;
    if (!autoCompactPercentage.trim()) return '请输入压缩比例。';
    const value = Number(autoCompactPercentage);
    if (!Number.isInteger(value) || value < 50 || value > 90) {
      return '请输入 50–90 之间的整数。';
    }
    return null;
  }, [autoCompactPercentage, useSdkCompactDefault]);

  const currentRuntimePolicy = useMemo<AgentProfileRuntimePolicy | null>(
    () =>
      capabilities
        ? {
            ...capabilityFormPolicy(capabilities),
            context: {
              source: contextSource,
              auto_compact_window:
                !useSdkCompactDefault && autoCompactPercentage === 'legacy'
                  ? legacyAutoCompactWindow
                  : 0,
              auto_compact_percentage:
                useSdkCompactDefault || autoCompactPercentage === 'legacy'
                  ? 0
                  : Number(autoCompactPercentage),
            },
          }
        : null,
    [
      autoCompactPercentage,
      capabilities,
      contextSource,
      legacyAutoCompactWindow,
      useSdkCompactDefault,
    ],
  );

  // The preview resolves the unsaved binding and refetches when it changes.
  const bindingConfigId = capabilities?.modelConfigId;
  const bindingModel = capabilities?.model ?? null;
  const previewBinding = useMemo(
    () =>
      bindingConfigId === undefined
        ? undefined
        : capabilityFormBinding({
            modelConfigId: bindingConfigId,
            model: bindingModel,
          }),
    [bindingConfigId, bindingModel],
  );
  // What a save would send; the editor is dirty exactly when it is not empty.
  const pendingSave = useMemo(() => {
    if (!selected || !capabilities || !currentRuntimePolicy) return null;
    const changes: Parameters<typeof updateProfile>[1] = {};
    if (name.trim() !== selected.name) changes.name = name.trim();
    const promptPatch = buildAgentPromptPatch(currentPrompts, promptMode, {
      ...promptsOf(selected),
      prompt_mode: selected.prompt_mode,
    });
    if (promptPatch) Object.assign(changes, promptPatch);
    Object.assign(changes, capabilityFormModelChanges(selected, capabilities));
    if (
      JSON.stringify(currentRuntimePolicy) !==
      JSON.stringify(comparablePolicy(selected))
    ) {
      changes.runtime_policy = currentRuntimePolicy;
    }
    // Anything but the avatar restarts the Agent's runners.
    const restartsRunners = Object.keys(changes).length > 0;
    if (avatarEmoji !== selected.avatar_emoji) {
      changes.avatar_emoji = avatarEmoji;
    }
    if (avatarColor !== selected.avatar_color) {
      changes.avatar_color = avatarColor;
    }
    return { changes, restartsRunners };
  }, [
    avatarColor,
    avatarEmoji,
    capabilities,
    currentPrompts,
    currentRuntimePolicy,
    name,
    promptMode,
    selected,
  ]);
  const dirty = !!pendingSave && Object.keys(pendingSave.changes).length > 0;
  const formError =
    promptLengthError(currentPrompts) ??
    (capabilities ? capabilityFormError(capabilities) : null) ??
    autoCompactError;

  const shouldBlockNavigation = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      navigationGuardRef.current.shouldBlock(
        dirty,
        currentLocation,
        nextLocation,
      ),
    [dirty],
  );
  const navigationBlocker = useBlocker(shouldBlockNavigation);

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!dirty) return;
        event.preventDefault();
        event.returnValue = '';
      },
      [dirty],
    ),
  );

  useEffect(() => {
    if (navigationBlocker.state !== 'blocked') return;
    if (confirm('当前智能体有未保存修改，离开页面会丢失。是否继续？')) {
      navigationBlocker.proceed();
    } else {
      navigationBlocker.reset();
    }
  }, [navigationBlocker]);

  useEffect(() => {
    if (searchParams.get('create') !== '1') return;
    const next = new URLSearchParams(searchParams);
    next.delete('create');
    setCreateOpen(true);
    setAllowedSearchParams(next, { replace: true });
  }, [searchParams, setAllowedSearchParams]);

  const governance = selected ? governanceByProfile[selected.id] : undefined;
  const governanceBusy = selected ? !!governanceLoading[selected.id] : false;
  const governanceError = selected ? governanceErrors[selected.id] : undefined;

  const confirmDiscardUnsavedChanges = () =>
    !dirty || confirm('当前智能体有未保存修改，继续会丢失。是否继续？');

  const selectProfile = (profileId: string) => {
    setSelectedId(profileId);
    // A phone's list → detail is a step the system back returns from.
    setAllowedSearchParams(
      { agent: profileId },
      isPhone && !requestedProfileId
        ? { state: FROM_AGENT_LIST }
        : { replace: true },
    );
  };

  const openedFromList =
    (location.state as typeof FROM_AGENT_LIST | null)?.agentList === true;
  /** Phone: from one Agent back to the list, popping the step it pushed. */
  const leaveDetail = () => {
    if (openedFromList) navigate(-1);
    else setAllowedSearchParams({}, { replace: true });
  };
  const backToList = () => {
    // Popping asks through the unsaved-changes blocker instead.
    if (!openedFromList && !confirmDiscardUnsavedChanges()) return;
    leaveDetail();
  };

  const handleSelectProfile = (profileId: string) => {
    if (profileId === selectedId) return;
    if (!confirmDiscardUnsavedChanges()) return;
    selectProfile(profileId);
  };

  const handleRefreshProfiles = () => {
    if (!confirmDiscardUnsavedChanges()) return;
    void loadProfiles();
  };

  const handleOpenCreate = () => {
    if (!confirmDiscardUnsavedChanges()) return;
    setCreateOpen(true);
  };

  const handleOpenImport = () => {
    if (!confirmDiscardUnsavedChanges()) return;
    setImportOpen(true);
  };

  const handleCreated = (profile: AgentProfile) => {
    setCreateOpen(false);
    selectProfile(profile.id);
    toast.success(
      '已创建智能体；当前未绑定工作区，Session 与 Memory 均和 HappyClaw 隔离',
    );
  };

  const handleSave = async () => {
    if (!selected || !pendingSave || !dirty || !name.trim() || formError) {
      return;
    }
    const { changes, restartsRunners } = pendingSave;
    if (
      restartsRunners &&
      !(await confirmRunnerRestart(selected.id, loadProfileGovernance))
    ) {
      return;
    }
    setSaving(true);
    try {
      const profile = await updateProfile(selected.id, changes);
      setCapabilities(capabilityFormFromProfile(profile));
      toast.success('已保存');
    } catch (err) {
      if (apiErrorBody(err)?.persisted === true) {
        void loadProfileGovernance(selected.id).catch(() => undefined);
      }
      toast.error(errorText(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleRetryProfileRuntimeCleanup = async () => {
    if (!selected || runtimeCleanupRepairing) return;
    setRuntimeCleanupRepairing(true);
    try {
      await retryRuntimeCleanup(selected.id);
      toast.success('工作区运行时清理已完成');
    } catch (err) {
      toast.error(errorText(err, '工作区运行时清理失败'));
    } finally {
      setRuntimeCleanupRepairing(false);
    }
  };

  const handleAvatarUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !selected) return;
    if (file.size > 3 * 1024 * 1024) {
      toast.error('图片文件不能超过 3MB');
      return;
    }
    if (
      !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(
        file.type,
      )
    ) {
      toast.error('仅支持 jpg、png、gif、webp 格式');
      return;
    }
    setUploadingAvatar(true);
    try {
      const profile = await uploadProfileAvatar(selected.id, file);
      setAvatarUrl(profile.avatar_url);
      toast.success('智能体头像已更新');
    } catch (error) {
      toast.error(errorText(error, '上传头像失败'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleInheritMainAvatar = async () => {
    if (!selected) return;
    setUploadingAvatar(true);
    try {
      if (selected.avatar_url) await removeProfileAvatar(selected.id);
      const profile = await updateProfile(selected.id, {
        avatar_emoji: null,
        avatar_color: null,
      });
      setAvatarEmoji(profile.avatar_emoji);
      setAvatarColor(profile.avatar_color);
      setAvatarUrl(profile.avatar_url);
      setAvatarStyleOpen(false);
      toast.success('已改为继承主 HappyClaw 头像');
    } catch (error) {
      toast.error(errorText(error, '恢复主头像失败'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleDuplicate = async () => {
    if (!selected || duplicating) return;
    if (!confirmDiscardUnsavedChanges()) return;
    setDuplicating(true);
    try {
      const { profile, stripped } = await duplicateProfile(selected.id);
      selectProfile(profile.id);
      toast.success(`已复制为「${profile.name}」，工作区和渠道没有复制`);
      const notice = strippedHostNotice(stripped);
      if (notice) toast.warning(notice);
    } catch (err) {
      toast.error(errorText(err, '复制失败'));
    } finally {
      setDuplicating(false);
    }
  };

  const handleExport = async () => {
    if (!selected) return;
    try {
      const exported = await exportProfile(selected.id);
      const fileName = `${selected.name.replace(/[\\/:*?"<>|\s]+/g, '-')}.happyclaw-agent.json`;
      downloadTextFile(
        `${JSON.stringify(exported, null, 2)}\n`,
        fileName,
        'application/json',
      );
      toast.success(
        dirty
          ? '已导出已保存的配置；未保存的修改不在文件里'
          : '已导出；模型配置不随文件导出',
      );
    } catch (err) {
      toast.error(errorText(err, '导出失败'));
    }
  };

  const handleMoveWorkspace = async (
    workspaceJid: string,
    targetProfileId: string,
  ) => {
    if (!selected || targetProfileId === selected.id) return;
    const workspace = governance?.workspaces.find(
      (candidate) => candidate.jid === workspaceJid,
    );
    if (workspace?.is_home) {
      toast.error('Home Workspace 固定归属内置 HappyClaw，不能迁移');
      return;
    }
    const target = profiles.find((profile) => profile.id === targetProfileId);
    const confirmed = await confirmDialog({
      title: '迁移工作区',
      message: `确认将工作区「${workspace?.name ?? workspaceJid}」迁移到「${target?.name ?? '目标智能体'}」？工作区文件、Session、渠道绑定和 Workspace Memory 都会随工作区保留，并对目标智能体可用。`,
      confirmText: '迁移',
      variant: 'primary',
    });
    if (!confirmed) return;
    setMovingWorkspaceJid(workspaceJid);
    try {
      await setWorkspaceAgentProfile(workspaceJid, targetProfileId);
      toast.success(`工作区已迁移到「${target?.name ?? '目标智能体'}」`);
      await Promise.allSettled([
        loadProfileGovernance(selected.id),
        loadProfileGovernance(targetProfileId),
      ]);
      setWorkspaceMoveTargets((current) => {
        const next = { ...current };
        delete next[workspaceJid];
        return next;
      });
    } catch (err) {
      toast.error(errorText(err, '迁移工作区失败'));
    } finally {
      setMovingWorkspaceJid(null);
    }
  };

  const selectAfterDelete = (deletedId: string) => {
    if (isPhone) {
      setSelectedId(null);
      leaveDetail();
      return;
    }
    const fallback = customProfiles.find((profile) => profile.id !== deletedId);
    setSelectedId(fallback?.id ?? null);
    setAllowedSearchParams(fallback ? { agent: fallback.id } : {}, {
      replace: true,
    });
  };

  const handleDelete = async () => {
    if (!selected || selected.is_default) return;
    if (!confirmDiscardUnsavedChanges()) return;
    setDeleting(true);
    try {
      const latestGovernance = await loadProfileGovernance(selected.id);
      if (latestGovernance.workspaces.length > 0) {
        const fallback =
          customProfiles.find((profile) => profile.id !== selected.id) ??
          profiles.find(
            (profile) => profile.id !== selected.id && profile.is_default,
          );
        if (!fallback) {
          toast.error('没有可迁移工作区的目标智能体');
          return;
        }
        setDeleteTargetId(fallback.id);
        setDeleteDialogOpen(true);
        return;
      }
      if (latestGovernance.channel_mounts.length > 0) {
        toast.error('该智能体仍有渠道绑定，请先在“渠道绑定”页面解绑或换绑');
        return;
      }
      const confirmed = await confirmDialog({
        title: '删除智能体',
        message: `确认删除智能体「${selected.name}」？`,
        confirmText: '删除',
        variant: 'danger',
      });
      if (!confirmed) return;
      await deleteProfile(selected.id);
      selectAfterDelete(selected.id);
      toast.success('已删除');
    } catch (err) {
      toast.error(errorText(err, '删除失败'));
    } finally {
      setDeleting(false);
    }
  };

  const handleMigrateAndDelete = async () => {
    if (!selected || !deleteTargetId) return;
    setDeleting(true);
    try {
      await migrateAndDeleteProfile(selected.id, deleteTargetId);
      setDeleteDialogOpen(false);
      selectAfterDelete(selected.id);
      toast.success('工作区已迁移，智能体已删除');
    } catch (err) {
      // The server moved nothing unless it says it persisted.
      toast.error(errorText(err, '迁移并删除失败，没有工作区被迁移'));
    } finally {
      setDeleting(false);
    }
  };

  const saveDisabled =
    !dirty || saving || runtimeCleanupRepairing || !name.trim() || !!formError;

  const editorAvatar = resolveAgentAvatar(
    { url: avatarUrl, emoji: avatarEmoji, color: avatarColor },
    mainAppearance,
  );
  const deleteActiveConversations = countActiveConversations(
    governance?.workspaces,
  );

  const phoneList = isPhone && !requestedProfileId && (
    <PageContainer className="space-y-3 pt-1">
      <PhonePageHeader
        title="智能体"
        action={
          <PhoneBarButton
            label="新建智能体"
            icon={<Plus className="size-5" />}
            onClick={handleOpenCreate}
          />
        }
        menu={{
          title: '智能体',
          groups: [
            [
              { label: '导入智能体', icon: FileUp, onSelect: handleOpenImport },
              {
                label: '刷新列表',
                icon: RefreshCw,
                onSelect: handleRefreshProfiles,
                disabled: loading,
              },
            ],
          ],
        }}
      />
      {customProfiles.length > 0 && (
        <SearchInput
          value={listQuery}
          onChange={setListQuery}
          placeholder="搜索智能体"
          debounce={0}
        />
      )}
      {loading && customProfiles.length === 0 ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : profilesError ? (
        <div className="space-y-2 py-6 text-center">
          <div className="text-caption text-error">{profilesError}</div>
          <Button variant="outline" size="sm" onClick={handleRefreshProfiles}>
            重试
          </Button>
        </div>
      ) : customProfiles.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="还没有自定义智能体"
          description="创建一个专门处理特定任务的智能体，或导入其他实例导出的智能体。"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={handleOpenCreate}>
                <Plus />
                新建智能体
              </Button>
              <Button variant="outline" onClick={handleOpenImport}>
                <FileUp />
                导入
              </Button>
            </div>
          }
        />
      ) : visibleProfiles.length === 0 ? (
        <p className="py-6 text-center text-caption text-muted-foreground">
          没有匹配的智能体
        </p>
      ) : (
        <ListGroup aria-label="自定义智能体列表">
          {visibleProfiles.map((profile) => (
            <ListRow
              key={profile.id}
              media={
                <EmojiAvatar
                  {...resolveAgentAvatar(
                    {
                      url: profile.avatar_url,
                      emoji: profile.avatar_emoji,
                      color: profile.avatar_color,
                    },
                    mainAppearance,
                  )}
                  fallbackChar={profile.name || 'A'}
                />
              }
              title={profile.name}
              description={
                profile.identity_prompt.replace(/\s+/g, ' ').trim() ||
                '尚未设置身份描述'
              }
              onClick={() => handleSelectProfile(profile.id)}
            />
          ))}
        </ListGroup>
      )}
    </PageContainer>
  );

  return (
    <div className="min-h-full bg-background lg:flex">
      {phoneList}
      <aside className="border-b border-surface-border phone:hidden lg:sticky lg:top-0 lg:flex lg:h-(--app-canvas-h) lg:w-64 lg:flex-none lg:flex-col lg:border-r lg:border-b-0">
        <div className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-4 lg:border-b lg:border-surface-border">
          <h2 className="min-w-0 flex-1 truncate text-title-sm text-foreground">
            智能体
            <span className="ml-1.5 text-caption font-normal text-muted-foreground tabular-nums">
              {customProfiles.length}
            </span>
          </h2>
          <IconButton
            label="刷新智能体列表"
            onClick={handleRefreshProfiles}
            disabled={loading}
            icon={<RefreshCw className={cn(loading && 'animate-spin')} />}
          />
          <IconButton
            label="导入智能体"
            onClick={handleOpenImport}
            icon={<FileUp />}
          />
          <Button size="sm" variant="ghost" onClick={handleOpenCreate}>
            <Plus />
            新建
          </Button>
        </div>

        {customProfiles.length > 0 && (
          <div className="hidden px-3 py-2 lg:block">
            <SearchInput
              value={listQuery}
              onChange={setListQuery}
              placeholder="搜索智能体"
              debounce={0}
            />
          </div>
        )}

        <nav
          aria-label="自定义智能体列表"
          className="flex gap-1 overflow-x-auto px-3 pb-3 lg:block lg:min-h-0 lg:flex-1 lg:space-y-px lg:overflow-y-auto lg:px-2 lg:pb-4"
        >
          {loading && customProfiles.length === 0 ? (
            <div className="flex min-w-48 justify-center py-6 lg:min-w-0">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : profilesError ? (
            <div className="min-w-56 space-y-2 px-2 py-4 text-center lg:min-w-0">
              <div className="text-caption text-error">{profilesError}</div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshProfiles}
              >
                重试
              </Button>
            </div>
          ) : visibleProfiles.length === 0 && listQuery.trim() ? (
            <p className="px-2 py-3 text-caption text-muted-foreground">
              没有匹配的智能体
            </p>
          ) : (
            visibleProfiles.map((profile) => {
              const active = profile.id === selectedId;
              const identity = profile.identity_prompt
                .replace(/\s+/g, ' ')
                .trim();
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => handleSelectProfile(profile.id)}
                  data-active={active || undefined}
                  aria-current={active ? 'page' : undefined}
                  title={identity || '尚未设置身份描述'}
                  className={cn(sidebarRowClass, 'w-auto max-w-56 lg:w-full')}
                >
                  <EmojiAvatar
                    {...resolveAgentAvatar(
                      {
                        url: profile.avatar_url,
                        emoji: profile.avatar_emoji,
                        color: profile.avatar_color,
                      },
                      mainAppearance,
                    )}
                    fallbackChar={profile.name || 'A'}
                    size="sm"
                    className="size-5 text-micro"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {profile.name}
                  </span>
                </button>
              );
            })
          )}
        </nav>
      </aside>

      <main className={cn('min-w-0 flex-1', phoneList && 'hidden')}>
        {isPhone && selected && capabilities && currentRuntimePolicy && (
          <PhonePageHeader
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{name.trim() || selected.name}</span>
                {dirty && (
                  <Badge variant="outline" dot="warning">
                    未保存
                  </Badge>
                )}
              </span>
            }
            onBack={backToList}
            action={
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={saveDisabled}
                className="mr-1"
              >
                {saving ? <Loader2 className="animate-spin" /> : <Save />}
                保存
              </Button>
            }
            menu={{
              title: name.trim() || selected.name,
              groups: [
                [
                  {
                    label: '复制智能体',
                    icon: Copy,
                    onSelect: () => void handleDuplicate(),
                    disabled: duplicating,
                  },
                  {
                    label: '导出智能体',
                    icon: Download,
                    onSelect: () => void handleExport(),
                  },
                ],
                [
                  {
                    label: '删除智能体',
                    icon: Trash2,
                    destructive: true,
                    onSelect: () => void handleDelete(),
                    disabled: deleting,
                  },
                ],
              ],
            }}
          />
        )}
        {isPhone && !selected && requestedProfileId && (
          <PhonePageHeader title="智能体" onBack={backToList} />
        )}
        {!selected ? (
          <PageContainer className="max-w-4xl">
            <EmptyState
              icon={Bot}
              title={
                customProfiles.length === 0
                  ? '还没有自定义智能体'
                  : '选择一个智能体'
              }
              description={
                customProfiles.length === 0
                  ? '创建一个专门处理特定任务的智能体，或导入其他实例导出的智能体。'
                  : '从左侧选择智能体查看配置，或创建一个新的智能体。'
              }
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button size="sm" onClick={handleOpenCreate}>
                    <Plus />
                    新建智能体
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleOpenImport}
                  >
                    <FileUp />
                    导入
                  </Button>
                </div>
              }
              className="min-h-[420px] rounded-xl border border-dashed border-surface-border"
            />
          </PageContainer>
        ) : !capabilities || !currentRuntimePolicy ? null : (
          <>
            <header className="sticky top-0 z-10 h-12 border-b border-surface-border bg-background phone:hidden">
              <div className="mx-auto flex h-full w-full max-w-4xl items-center gap-2.5 px-4 sm:px-6 lg:px-8">
                <EmojiAvatar
                  {...editorAvatar}
                  fallbackChar={name || 'A'}
                  size="sm"
                />
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <h1 className="truncate text-title-sm text-foreground">
                    {name.trim() || selected.name}
                  </h1>
                  {dirty && (
                    <Badge variant="outline" dot="warning">
                      <span className="max-sm:hidden">有未保存修改</span>
                      <span className="sm:hidden">未保存</span>
                    </Badge>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDuplicate()}
                    disabled={duplicating}
                    aria-label="复制智能体"
                    className="pointer-coarse:min-h-10"
                  >
                    {duplicating ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Copy />
                    )}
                    <span className="max-md:hidden">复制</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleExport()}
                    aria-label="导出智能体"
                    className="pointer-coarse:min-h-10"
                  >
                    <Download />
                    <span className="max-md:hidden">导出</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDelete()}
                    disabled={deleting}
                    aria-label="删除智能体"
                    className="text-error hover:bg-error/10 hover:text-error pointer-coarse:min-h-10"
                  >
                    <Trash2 />
                    <span className="max-md:hidden">删除</span>
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void handleSave()}
                    disabled={saveDisabled}
                    title={formError ?? undefined}
                    className="ml-1 pointer-coarse:min-h-10"
                  >
                    {saving ? <Loader2 className="animate-spin" /> : <Save />}
                    保存
                  </Button>
                </div>
              </div>
            </header>

            <PageContainer className="max-w-4xl space-y-8 pb-24 lg:pt-6">
              <p className="text-body text-muted-foreground">
                管理智能体的身份和能力，以及所属工作区和消息渠道。修改在点击“保存”后生效。
              </p>

              {governance?.runtime_cleanup_pending && (
                <div
                  role="status"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-warning/10 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="text-label text-foreground">
                      智能体配置已保存，但工作区运行时清理未完成
                    </div>
                    <p className="mt-0.5 text-caption text-muted-foreground">
                      为避免旧配置继续运行，相关工作区已暂停；清理成功后会自动恢复。
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={runtimeCleanupRepairing}
                    onClick={() => void handleRetryProfileRuntimeCleanup()}
                  >
                    {runtimeCleanupRepairing ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                    重试清理
                  </Button>
                </div>
              )}

              <AgentSection
                title="身份"
                description="定义这个智能体如何称呼自己，以及它在列表和对话中的头像。"
              >
                <SettingsGroup>
                  <div className="px-4 py-3">
                    <SettingsField label="名称" htmlFor="agent-profile-name">
                      <Input
                        id="agent-profile-name"
                        value={name}
                        maxLength={80}
                        onChange={(event) => setName(event.target.value)}
                        className="sm:max-w-sm"
                      />
                    </SettingsField>
                  </div>
                  <div className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <EmojiAvatar
                        {...editorAvatar}
                        fallbackChar={name || 'A'}
                        size="lg"
                      />
                      <div className="min-w-0 flex-1 basis-48">
                        <div className="text-body font-medium text-foreground">
                          智能体头像
                        </div>
                        <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
                          {avatarUrl || avatarEmoji || avatarColor
                            ? '当前使用这个智能体的自定义头像。'
                            : '未单独设置，自动继承主 HappyClaw 头像。'}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <input
                          ref={avatarInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/gif,image/webp"
                          className="hidden"
                          onChange={handleAvatarUpload}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={uploadingAvatar}
                          onClick={() => avatarInputRef.current?.click()}
                        >
                          {uploadingAvatar ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Upload />
                          )}
                          上传图片
                        </Button>
                        {!avatarStyleOpen && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setAvatarStyleOpen(true)}
                          >
                            使用 Emoji
                          </Button>
                        )}
                        {(avatarUrl || avatarEmoji || avatarColor) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={uploadingAvatar}
                            onClick={handleInheritMainAvatar}
                          >
                            <RotateCcw />
                            使用主头像
                          </Button>
                        )}
                      </div>
                    </div>
                    {avatarStyleOpen && (
                      <div className="mt-3 grid gap-3 border-t border-surface-border pt-3 sm:grid-cols-2">
                        <div>
                          <span className="mb-1.5 block text-caption text-muted-foreground">
                            Emoji（可选）
                          </span>
                          <EmojiPicker
                            value={avatarEmoji ?? undefined}
                            onChange={setAvatarEmoji}
                          />
                        </div>
                        <div>
                          <span className="mb-1.5 block text-caption text-muted-foreground">
                            背景色（可选）
                          </span>
                          <ColorPicker
                            value={avatarColor ?? undefined}
                            onChange={setAvatarColor}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </SettingsGroup>
              </AgentSection>

              <div className="space-y-8">
                <AgentPromptEditor
                  value={currentPrompts}
                  mode={promptMode}
                  onChange={setCurrentPrompts}
                  onModeChange={setPromptMode}
                  onOpenAssistant={setAssistantSection}
                />
                <AgentPromptAssistant
                  key={selected.id}
                  profileId={selected.id}
                  agentName={name.trim() || selected.name}
                  currentPrompts={currentPrompts}
                  activeSection={assistantSection}
                  onApply={setCurrentPrompts}
                />
              </div>

              <AgentSection
                id="agent-capabilities"
                className="scroll-mt-20"
                title="能力配置"
                description="模型、推理等级和按来源配置的 Skills 与 MCP。HappyClaw、宿主机与工作区能力会在运行时叠加；同名项以“最终生效能力”中的结果为准。"
              >
                <AgentCapabilityForm
                  value={capabilities}
                  onChange={setCapabilities}
                  modelConfigs={modelConfigs}
                  inheritedModel={inheritedModel}
                  profile={selected}
                  hostAvailable={isAdmin}
                  labelPrefix="智能体"
                  modelConfigDescription="该智能体所属的所有工作区、会话和自动化都会使用这里解析出的完整模型网关环境。"
                />
                <SettingsGroup>
                  {isAdmin && (
                    <SettingsRow
                      label="加载完整宿主机 Claude Code 配置"
                      description="将 ~/.claude 作为用户配置层叠加，包含提示词、Rules、Agents、Commands、Hooks、Workflows、Output Styles、Plugins 与设置（含宿主机 MCP）。工作区仍是运行目录；HappyClaw MCP 与宿主机 Skills 由上面的设置独立控制。"
                      control={
                        <Switch
                          checked={contextSource === 'host_claude'}
                          onCheckedChange={(checked) =>
                            setContextSource(
                              checked ? 'host_claude' : 'managed',
                            )
                          }
                          aria-label="加载完整宿主机 Claude Code 配置"
                        />
                      }
                    />
                  )}
                  <SettingsRow
                    label="SDK 自动压缩（推荐）"
                    htmlFor="agent-auto-compact-default"
                    description={
                      <span id="agent-auto-compact-default-description">
                        根据当前模型自动决定压缩时机。普通模型通常为 200K
                        上下文；模型名带 [1m] 时按 1M 处理。
                      </span>
                    }
                    control={
                      <Switch
                        id="agent-auto-compact-default"
                        checked={useSdkCompactDefault}
                        onCheckedChange={setUseSdkCompactDefault}
                        aria-describedby="agent-auto-compact-default-description"
                      />
                    }
                  >
                    {!useSdkCompactDefault && (
                      <div className="max-w-sm">
                        {autoCompactPercentage === 'legacy' ? (
                          <div className="rounded-lg bg-warning/10 px-3 py-2.5">
                            <p className="text-caption leading-5 text-warning">
                              当前保留旧版固定阈值{' '}
                              {Math.round(legacyAutoCompactWindow / 1000)}
                              K。 固定值无法同时适配 200K 与 1M 模型。
                            </p>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="mt-2"
                              onClick={() => {
                                setAutoCompactPercentage('80');
                                setLegacyAutoCompactWindow(0);
                              }}
                            >
                              改用 80% 模型比例
                            </Button>
                          </div>
                        ) : (
                          <>
                            <label
                              htmlFor="agent-auto-compact-percentage"
                              className="mb-1.5 block text-caption font-medium text-muted-foreground"
                            >
                              上下文使用比例
                            </label>
                            <div className="flex items-center gap-2">
                              <Input
                                id="agent-auto-compact-percentage"
                                type="number"
                                inputMode="numeric"
                                min={50}
                                max={90}
                                step={5}
                                value={autoCompactPercentage}
                                onChange={(event) => {
                                  setAutoCompactPercentage(event.target.value);
                                  setLegacyAutoCompactWindow(0);
                                }}
                                aria-invalid={!!autoCompactError}
                                aria-describedby={`agent-auto-compact-percentage-description${autoCompactError ? ' agent-auto-compact-percentage-error' : ''}`}
                                className="w-24 pointer-coarse:min-h-11"
                              />
                              <span className="shrink-0 text-caption text-muted-foreground">
                                %
                              </span>
                            </div>
                            <p
                              id="agent-auto-compact-percentage-description"
                              className="mt-1.5 text-caption leading-5 text-muted-foreground"
                            >
                              可设置 50–90%。例如 80% 在普通模型下为 160K，在
                              [1m] 模型下为 800K。
                            </p>
                          </>
                        )}
                        {autoCompactError && (
                          <p
                            id="agent-auto-compact-percentage-error"
                            role="alert"
                            className="mt-1 text-caption text-error"
                          >
                            {autoCompactError}
                          </p>
                        )}
                      </div>
                    )}
                  </SettingsRow>
                </SettingsGroup>
              </AgentSection>

              <ErrorBoundary resetKeys={[selected.id]}>
                <EffectiveCapabilitiesPreview
                  profileId={selected.id}
                  runtimePolicy={currentRuntimePolicy}
                  modelBinding={previewBinding}
                  workspaces={governance?.workspaces ?? []}
                />
              </ErrorBoundary>
              <AgentGovernanceSection
                selected={selected}
                profiles={profiles}
                governance={governance}
                busy={governanceBusy}
                error={governanceError}
                workspaceMoveTargets={workspaceMoveTargets}
                movingWorkspaceJid={movingWorkspaceJid}
                onRefresh={() => void loadProfileGovernance(selected.id)}
                onMoveTargetChange={(workspaceJid, targetProfileId) =>
                  setWorkspaceMoveTargets((current) => ({
                    ...current,
                    [workspaceJid]: targetProfileId,
                  }))
                }
                onMoveWorkspace={(workspaceJid, targetProfileId) =>
                  void handleMoveWorkspace(workspaceJid, targetProfileId)
                }
              />
            </PageContainer>
          </>
        )}
      </main>

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />
      <ImportAgentDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={({ profile, stripped, dropped }) => {
          setImportOpen(false);
          selectProfile(profile.id);
          toast.success(`已导入「${profile.name}」，模型配置跟随默认`);
          const notice = strippedHostNotice(stripped);
          if (notice) toast.warning(notice);
          const droppedText = describeReferences(dropped);
          if (droppedText) toast.warning(`未导入：${droppedText}`);
        }}
      />

      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => !deleting && setDeleteDialogOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>迁移工作区后删除智能体</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-body leading-6 text-muted-foreground">
              「{selected?.name}」仍归属 {governance?.workspaces.length ?? 0}{' '}
              个工作区。它们会一起迁移到目标智能体，渠道绑定随工作区归属更新；任一步失败都不会迁移任何工作区。
            </p>
            {deleteActiveConversations > 0 && (
              <p
                role="alert"
                className="rounded-lg bg-warning/10 px-3 py-2 text-caption text-warning"
              >
                其中 {deleteActiveConversations}{' '}
                个对话正在进行，迁移会中断它们；排队的消息保留，并由目标智能体继续处理。
              </p>
            )}
            <div className="space-y-1.5">
              <label className="block text-caption font-medium text-muted-foreground">
                目标智能体
              </label>
              <Select
                value={deleteTargetId}
                onValueChange={setDeleteTargetId}
                disabled={deleting}
              >
                <SelectTrigger className="w-full" aria-label="目标智能体">
                  <SelectValue placeholder="选择目标智能体" />
                </SelectTrigger>
                <SelectContent>
                  {profiles
                    .filter((profile) => profile.id !== selected?.id)
                    .map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.is_default ? '主智能体' : profile.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="max-h-40 overflow-auto rounded-lg bg-muted/50 p-2">
              {governance?.workspaces.map((workspace) => (
                <div
                  key={workspace.jid}
                  className="truncate px-1 py-1 text-caption text-muted-foreground"
                >
                  {workspace.name} · {workspace.folder}
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleMigrateAndDelete()}
              disabled={deleting || !deleteTargetId}
            >
              {deleting ? <Loader2 className="animate-spin" /> : <ArrowRight />}
              迁移并删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
