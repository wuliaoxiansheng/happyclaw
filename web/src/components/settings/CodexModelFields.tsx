import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  codexFallbackEffort,
  codexModelDefaultEffort,
  codexModelEfforts,
  type CodexCatalog,
} from './codex-catalog';
import { effortLabel } from './model-connections';
import { SettingsField } from './SettingsLayout';

interface CodexModelFieldsProps {
  catalog: CodexCatalog;
  model: string;
  effort: string;
  onChange: (next: { model: string; effort: string }) => void;
  disabled?: boolean;
}

/** A ChatGPT connection's default model and reasoning effort. */
export function CodexModelFields({
  catalog,
  model,
  effort,
  onChange,
  disabled = false,
}: CodexModelFieldsProps) {
  const listed = catalog.models.some((option) => option.value === model);
  const modelEfforts = codexModelEfforts(catalog, model);
  // A stored level the model no longer offers stays visible until changed.
  const efforts = modelEfforts.includes(effort)
    ? modelEfforts
    : [effort, ...modelEfforts];
  const modelDefaultEffort = codexModelDefaultEffort(catalog, model);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <SettingsField
        label="默认模型"
        htmlFor="codex-model-select"
        description="对话没有指定模型时使用它；聊天里可以随时切换。"
      >
        <NativeSelect
          id="codex-model-select"
          value={model}
          onChange={(event) => {
            const next = event.target.value;
            onChange({
              model: next,
              effort: codexFallbackEffort(catalog, next, effort),
            });
          }}
          disabled={disabled}
          className="w-full font-mono"
        >
          {/* 当前值不在目录里（如旧目录的模型）时保留为额外选项 */}
          {!listed && model && (
            <NativeSelectOption value={model}>{model}</NativeSelectOption>
          )}
          {catalog.models.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.value === catalog.defaultModel
                ? `${option.value}·默认`
                : option.value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </SettingsField>
      <SettingsField
        label="默认推理档位"
        htmlFor="codex-effort-select"
        description="对应上游 reasoning.effort，越高越慢但推理越深。"
      >
        <NativeSelect
          id="codex-effort-select"
          value={effort}
          onChange={(event) => onChange({ model, effort: event.target.value })}
          disabled={disabled}
          className="w-full font-mono"
        >
          {efforts.map((level) => (
            <NativeSelectOption key={level} value={level}>
              {level === modelDefaultEffort
                ? `${effortLabel(level)}（默认）`
                : effortLabel(level)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </SettingsField>
    </div>
  );
}
