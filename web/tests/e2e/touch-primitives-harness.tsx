// UI primitives with their phone touch sizing: icon buttons alone, side by
// side, absolutely placed and opted out of the hit area; text fields;
// tabs, a command list, a toggle group, an InfoTip and two segmented controls (one that fits,
// one that overflows). Nothing here talks to a backend.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, X } from 'lucide-react';
import { IconButton } from '../../src/components/common/IconButton';
import { InfoTip } from '../../src/components/common/InfoTip';
import { SegmentedControl } from '../../src/components/common/SegmentedControl';
import { Button } from '../../src/components/ui/button';
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../src/components/ui/command';
import { Input } from '../../src/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '../../src/components/ui/native-select';
import { Tabs, TabsList, TabsTrigger } from '../../src/components/ui/tabs';
import { Textarea } from '../../src/components/ui/textarea';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '../../src/components/ui/toggle-group';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import '../../src/styles/globals.css';

const MANY = [
  '今天',
  '最近 7 天',
  '最近 30 天',
  '本月',
  '上月',
  '全部时间',
].map((label) => ({ value: label, label }));

function Segments() {
  const [fit, setFit] = useState('a');
  const [many, setMany] = useState(MANY[0].value);
  return (
    <>
      <SegmentedControl
        label="短"
        value={fit}
        onChange={setFit}
        options={[
          { value: 'a', label: '甲' },
          { value: 'b', label: '乙' },
        ]}
      />
      <div className="w-48">
        <SegmentedControl
          label="长"
          value={many}
          onChange={setMany}
          options={MANY}
        />
      </div>
    </>
  );
}

function Harness() {
  return (
    <div className="flex flex-col items-start gap-6 p-8">
      <div className="flex gap-6">
        <IconButton
          label="单个"
          icon={<Plus />}
          hideTooltip
          data-testid="single"
        />
        <IconButton
          label="不扩展"
          icon={<Plus />}
          hideTooltip
          hitSlop={false}
          data-testid="no-slop"
        />
      </div>
      <div className="flex gap-1">
        <IconButton label="左" icon={<Plus />} hideTooltip data-testid="left" />
        <IconButton
          label="右"
          icon={<Plus />}
          hideTooltip
          data-testid="right"
        />
      </div>
      <div className="flex gap-1 pl-12">
        <IconButton
          label="隐藏"
          icon={<Plus />}
          hideTooltip
          className="phone:hidden"
        />
        <IconButton
          label="后"
          icon={<Plus />}
          hideTooltip
          data-testid="after-hidden"
        />
      </div>
      <div className="relative h-16 w-40 border border-surface-border">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="关闭"
          data-testid="corner"
          className="absolute top-2 right-2"
        >
          <X />
        </Button>
      </div>
      <Input data-testid="input" className="text-sm" placeholder="输入" />
      <Textarea data-testid="textarea" placeholder="多行" />
      <NativeSelect size="sm" data-testid="select">
        <NativeSelectOption>一</NativeSelectOption>
      </NativeSelect>
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a" data-testid="tab">
            甲
          </TabsTrigger>
          <TabsTrigger value="b">乙</TabsTrigger>
        </TabsList>
      </Tabs>
      <Command className="h-auto w-72">
        <CommandInput data-testid="command-input" placeholder="搜索" />
        <CommandList>
          <CommandItem data-testid="command-item">命令</CommandItem>
        </CommandList>
      </Command>
      <ToggleGroup type="single" defaultValue="a" size="sm">
        <ToggleGroupItem value="a" data-testid="toggle">
          甲
        </ToggleGroupItem>
        <ToggleGroupItem value="b">乙</ToggleGroupItem>
      </ToggleGroup>
      <InfoTip content="尚未完成的回复">
        <button type="button">未完成</button>
      </InfoTip>
      <Segments />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <Harness />
  </TooltipProvider>,
);
