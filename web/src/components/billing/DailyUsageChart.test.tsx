// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {
    dailyUsage: [] as Array<Record<string, unknown>>,
    loadDailyUsage: vi.fn(),
    billingCurrency: 'USD',
    billingCurrencyRate: 1,
  },
}));
vi.mock('../../stores/billing', () => ({
  useBillingStore: (selector?: (state: typeof mocks.state) => unknown) =>
    selector ? selector(mocks.state) : mocks.state,
}));

const { default: DailyUsageChart } = await import('./DailyUsageChart');
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The server keys daily_usage by its LOCAL calendar day. At local 00:30 on the
// 1st in UTC+8 the UTC day is still the 31st of the month before, so a chart
// that matches rows by toISOString() would show yesterday's row as today's.
process.env.TZ = 'Asia/Shanghai';
const NOW = new Date('2026-08-31T16:30:00.000Z');

function row(date: string, messages: number) {
  return {
    user_id: 'u1',
    date,
    total_input_tokens: 10,
    total_output_tokens: 10,
    total_cost_usd: messages,
    message_count: messages,
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.state.dailyUsage = [row('2026-08-31', 3), row('2026-09-01', 7)];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('DailyUsageChart', () => {
  test('puts the local day last and reads its own ledger row', async () => {
    await act(async () => root.render(<DailyUsageChart />));
    const labels = [...container.querySelectorAll('.text-micro')].map(
      (node) => node.textContent,
    );
    expect(labels.at(-1)).toContain('09-01');

    const bars = container.querySelectorAll('.h-40 > div');
    expect(bars).toHaveLength(14);
    await act(async () =>
      bars[13].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );
    expect(container.textContent).toContain('2026-09-01');
    expect(container.textContent).toContain('消息: 7');
    expect(container.textContent).not.toContain('消息: 3');

    await act(async () =>
      bars[12].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );
    expect(container.textContent).toContain('2026-08-31');
    expect(container.textContent).toContain('消息: 3');
  });
});
