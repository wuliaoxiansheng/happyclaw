import { useEffect, useRef, useState } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SettingsField } from '@/components/settings/SettingsLayout';
import { getErrorMessage } from '@/components/settings/types';
import { apiErrorBody } from '@/utils/error';
import {
  useAgentProfilesStore,
  type AgentCapabilityReferences,
  type AgentHostGrant,
  type AgentProfileImportResult,
} from '@/stores/agent-profiles';

interface ParsedFile {
  fileName: string;
  data: { format?: unknown; agent?: { name?: unknown } } & Record<
    string,
    unknown
  >;
}

function describeHostGrants(grants: AgentHostGrant[]): string {
  return grants
    .map((grant) =>
      grant === 'host_context' ? '宿主机 Claude 上下文' : '宿主机 Skills',
    )
    .join(' / ');
}

export function describeReferences(refs: AgentCapabilityReferences): string {
  return [
    refs.skills.length ? `HappyClaw Skills：${refs.skills.join('、')}` : '',
    refs.host_skills.length
      ? `宿主机 Skills：${refs.host_skills.join('、')}`
      : '',
    refs.mcp.length ? `MCP：${refs.mcp.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('；');
}

/**
 * Create an Agent from a file another instance (or this one) exported.
 * Skills and MCP the account does not have are named and only dropped once
 * the user agrees; a member's import silently cannot carry host grants, and
 * the caller says so after it succeeds.
 */
export function ImportAgentDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (result: AgentProfileImportResult) => void;
}) {
  const importProfile = useAgentProfilesStore((state) => state.importProfile);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<ParsedFile | null>(null);
  const [name, setName] = useState('');
  const [importing, setImporting] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once the server named Skills/MCP this account lacks.
  const [missing, setMissing] = useState<AgentCapabilityReferences | null>(
    null,
  );
  // Set once the server named the host resources the file would grant.
  const [hostGrants, setHostGrants] = useState<AgentHostGrant[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setName('');
    setNameError(null);
    setError(null);
    setMissing(null);
    setHostGrants(null);
  }, [open]);

  const readFile = async (selected: File | undefined) => {
    if (!selected) return;
    setError(null);
    setNameError(null);
    setMissing(null);
    setHostGrants(null);
    try {
      const data = JSON.parse(await selected.text());
      if (data?.format !== 'happyclaw-agent') {
        throw new Error('not an export');
      }
      setFile({ fileName: selected.name, data });
      setName(typeof data.agent?.name === 'string' ? data.agent.name : '');
    } catch {
      setFile(null);
      setError('这不是 HappyClaw 智能体导出文件（.json）');
    }
  };

  const submit = async (): Promise<void> => {
    if (!file || !name.trim()) return;
    setImporting(true);
    setError(null);
    setNameError(null);
    try {
      const result = await importProfile({
        data: file.data,
        name: name.trim(),
        // Each only after the user saw what it covers and went on.
        ...(missing ? { drop_missing: true } : {}),
        ...(hostGrants ? { confirm_host_grants: true } : {}),
      });
      onImported(result);
    } catch (err) {
      const body = apiErrorBody(err);
      if (body?.code === 'AGENT_NAME_TAKEN' || body?.code === 'INVALID_NAME') {
        setNameError(getErrorMessage(err, '名称已被使用'));
      } else if (body?.code === 'AGENT_IMPORT_MISSING_REFERENCES') {
        setMissing(body.missing as AgentCapabilityReferences);
      } else if (body?.code === 'AGENT_IMPORT_HOST_GRANTS') {
        setHostGrants(body.grants as AgentHostGrant[]);
      } else {
        setError(getErrorMessage(err, '导入失败'));
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!importing) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>导入智能体</DialogTitle>
          <DialogDescription>
            选择“导出”得到的 JSON
            文件。模型配置不随文件迁移，导入后跟随默认模型。
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              const selected = event.target.files?.[0];
              event.target.value = '';
              void readFile(selected);
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="w-full justify-center pointer-coarse:min-h-11"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            <FileUp />
            {file ? `已选择 ${file.fileName}，重新选择` : '选择文件'}
          </Button>

          {file && (
            <SettingsField label="名称" htmlFor="import-agent-name">
              <Input
                id="import-agent-name"
                value={name}
                maxLength={80}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
                aria-invalid={!!nameError || undefined}
                aria-describedby={
                  nameError ? 'import-agent-name-error' : undefined
                }
                className="pointer-coarse:min-h-11"
              />
              {nameError && (
                <p
                  id="import-agent-name-error"
                  role="alert"
                  className="mt-1 text-caption text-error"
                >
                  {nameError}
                </p>
              )}
            </SettingsField>
          )}

          {hostGrants && (
            <div
              role="alert"
              className="space-y-1 rounded-lg bg-warning/10 px-3 py-2.5"
            >
              <p className="text-label text-foreground">
                此文件会授予：{describeHostGrants(hostGrants)}
              </p>
              <p className="text-caption leading-5 text-muted-foreground">
                导入的智能体运行时会使用这台机器上的这些资源。确认来源可信后再导入。
              </p>
            </div>
          )}

          {missing && (
            <div
              role="alert"
              className="space-y-1 rounded-lg bg-warning/10 px-3 py-2.5"
            >
              <p className="text-label text-foreground">当前账号没有这些能力</p>
              <p className="text-caption leading-5 text-muted-foreground">
                {describeReferences(missing)}
                。导入后的智能体不会使用它们，之后可以在能力配置里重新选择。
              </p>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-error/10 px-3 py-2 text-caption text-error"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={importing}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!file || !name.trim() || importing}
          >
            {importing && <Loader2 className="animate-spin" />}
            {missing ? '去掉这些后创建' : hostGrants ? '授予并导入' : '导入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
