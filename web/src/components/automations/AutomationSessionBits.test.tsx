// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { emulatePointer } from '@/components/ui/overlay-test-utils';
import type { Automation } from '../../lib/automation';
import { BoundAutomationMark } from './AutomationSessionBits';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

const paused = {
  id: 'auto-1',
  name: '每周账单',
  status: 'paused',
} as Automation;

describe('BoundAutomationMark', () => {
  test('a tap on touch shows which automations the session runs', () => {
    emulatePointer('phone');
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
    act(() => root!.render(<BoundAutomationMark automations={[paused]} />));
    const mark = container.querySelector('[role="img"]') as HTMLElement;
    expect(mark.getAttribute('aria-label')).toBe('绑定了自动化：每周账单');
    expect(document.body.textContent).not.toContain('已暂停');

    act(() => mark.click());
    const popover = document.querySelector('[data-slot="popover-content"]');
    expect(popover?.textContent).toBe('每周账单 · 已暂停');
  });
});
