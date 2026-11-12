import { useEffect } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAgentProfilesStore } from '@/stores/agent-profiles';
import { useChatStore } from '@/stores/chat';
import { getAgentProfileDisplayName } from '@/utils/agent-product';

/** The Agent a Workspace belongs to now, or '' while that is unknown. */
export function useWorkspaceAgentId(groupJid: string | undefined): string {
  const group = useChatStore((state) =>
    groupJid ? state.groups[groupJid] : undefined,
  );
  const profiles = useAgentProfilesStore((state) => state.profiles);
  return (
    group?.agent_profile_id ??
    profiles.find((profile) => profile.is_default)?.id ??
    ''
  );
}

/**
 * Pick which Agent a Workspace belongs to. The Home Workspace always belongs
 * to the built-in HappyClaw. The caller applies the change on save through
 * PATCH /api/groups/:jid/agent-profile.
 */
export function WorkspaceAgentField({
  groupJid,
  value,
  onChange,
  disabled,
}: {
  groupJid: string;
  value: string;
  onChange: (profileId: string) => void;
  disabled?: boolean;
}) {
  const group = useChatStore((state) => state.groups[groupJid]);
  const profiles = useAgentProfilesStore((state) => state.profiles);
  const loadProfiles = useAgentProfilesStore((state) => state.loadProfiles);
  const currentId = useWorkspaceAgentId(groupJid);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const home = !!(group?.is_home || group?.is_my_home);
  const changed = !!value && value !== currentId;

  return (
    <div className="space-y-1.5">
      <label
        htmlFor="workspace-agent-select"
        className="block text-body font-medium text-foreground"
      >
        所属智能体
      </label>
      {home ? (
        <p className="text-caption leading-5 text-muted-foreground">
          Home 工作区固定使用内置 HappyClaw，不能更换。
        </p>
      ) : (
        <>
          <Select
            value={value}
            onValueChange={onChange}
            disabled={disabled || profiles.length === 0}
          >
            <SelectTrigger
              id="workspace-agent-select"
              aria-label="工作区所属智能体"
              className="w-full sm:w-72"
            >
              <SelectValue placeholder="正在加载智能体" />
            </SelectTrigger>
            <SelectContent>
              {profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.is_default
                    ? getAgentProfileDisplayName(profile.name)
                    : profile.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-caption leading-5 text-muted-foreground">
            {changed
              ? '保存后新消息改由所选智能体处理，使用它的提示词、模型和能力；正在进行的对话会被中断，排队的消息保留。'
              : '工作区文件、会话记录、渠道绑定和记忆随工作区保留，更换智能体不会丢失。'}
          </p>
        </>
      )}
    </div>
  );
}
