// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useSteadyValue } from './useSteadyValue';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

function Probe({ text }: { text: string }) {
  // A new object each render: only the key says whether the line changed.
  const shown = useSteadyValue({ text }, text, 300);
  return <span>{shown.text}</span>;
}

const shown = () => container.textContent;
const render = (text: string) =>
  act(async () => {
    root.render(<Probe text={text} />);
  });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useSteadyValue', () => {
  test('starts on the first value, with no wait', async () => {
    await render('读取文件');
    expect(shown()).toBe('读取文件');
  });

  test('lets a change settle before showing it', async () => {
    await render('读取文件');
    await render('运行命令');
    expect(shown()).toBe('读取文件');
    await advance(299);
    expect(shown()).toBe('读取文件');
    await advance(1);
    expect(shown()).toBe('运行命令');
  });

  test('skips what comes and goes within the wait', async () => {
    await render('读取文件');
    await render('搜索代码');
    await advance(100);
    await render('运行命令');
    await advance(100);
    await render('编辑文件');
    await advance(100);
    expect(shown()).toBe('编辑文件');
  });

  test('never waits longer than the wait, however often the value moves', async () => {
    await render('0');
    for (let i = 1; i <= 8; i += 1) {
      await render(String(i));
      await advance(100);
    }
    // 800ms of changes every 100ms: a debounce would still show "0".
    expect(Number(shown())).toBeGreaterThanOrEqual(3);
  });

  test('keeps the line when the value goes back before the wait is up', async () => {
    await render('读取文件');
    await render('运行命令');
    await advance(100);
    await render('读取文件');
    await advance(300);
    expect(shown()).toBe('读取文件');
  });

  test('does not touch state after it is gone', async () => {
    await render('读取文件');
    await render('运行命令');
    await act(async () => root.unmount());
    await advance(500);
    root = createRoot(container);
    await render('读取文件');
    expect(shown()).toBe('读取文件');
  });
});
