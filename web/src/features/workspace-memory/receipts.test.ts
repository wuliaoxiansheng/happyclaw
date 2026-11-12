import { describe, expect, test } from 'vitest';

import type { StreamingStep } from '@/lib/stream-steps';

import { memoryPageHref } from './model';
import { memoryReceipts } from './receipts';

function write(
  id: string,
  toolName: string,
  resultPreview: string,
  status: StreamingStep['status'] = 'done',
): StreamingStep {
  return { id, kind: 'tool', at: 0, status, toolName, resultPreview };
}

const REMEMBER = 'mcp__happyclaw__workspace_memory_remember';
const UPDATE = 'mcp__happyclaw__workspace_memory_update';

describe('memory receipts', () => {
  test('successful writes leave one receipt per item, last write wins', () => {
    const steps = [
      write(
        's1',
        REMEMBER,
        '{"result":"remembered","title":"部署 \\"流程\\"","id":"wmi_a","revision":1}',
      ),
      write(
        's2',
        REMEMBER,
        '{"result":"proposed","title":"Back up first","id":"wmi_b","revision":1,"note":"Submitted, awaiting',
      ),
      write(
        's3',
        UPDATE,
        '{"result":"updated","title":"部署流程 v2","id":"wmi_a","revision":2}',
      ),
      // Failed, unrelated or unreadable calls leave nothing.
      write(
        's4',
        REMEMBER,
        'A memory with this canonical key already exists',
        'error',
      ),
      write('s5', 'Bash', '{"result":"remembered","id":"x"}'),
      write(
        's6',
        'mcp__happyclaw__workspace_memory_forget',
        '{"result":"forgotten","id":"wmi_c"}',
      ),
      write('s7', REMEMBER, '{"result":"remembered","title":"no id"}'),
    ];
    expect(memoryReceipts(steps)).toEqual([
      { id: 'wmi_b', title: 'Back up first', proposed: true },
      { id: 'wmi_a', title: '部署流程 v2', proposed: false },
    ]);
  });

  test('an untitled item has no title; a running call none at all', () => {
    expect(
      memoryReceipts([
        write(
          's1',
          REMEMBER,
          '{"result":"remembered","title":null,"id":"wmi_a"}',
        ),
        write(
          's2',
          REMEMBER,
          '{"result":"remembered","id":"wmi_b"}',
          'running',
        ),
      ]),
    ).toEqual([{ id: 'wmi_a', title: null, proposed: false }]);
  });

  test('a title cut off by the preview bound is left out, the receipt kept', () => {
    expect(
      memoryReceipts([
        write(
          's1',
          REMEMBER,
          `{"result":"remembered","id":"wmi_a","title":"${'长'.repeat(500)}`,
        ),
      ]),
    ).toEqual([{ id: 'wmi_a', title: null, proposed: false }]);
  });

  test('a receipt links to its item on the Memory page', () => {
    expect(memoryPageHref('web:ws one', 'wmi_a')).toBe(
      '/memory?workspace=web%3Aws+one&item=wmi_a',
    );
  });
});
