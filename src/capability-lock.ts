type LockState = {
  tail: Promise<void>;
  references: number;
};

/**
 * Pool of async mutexes keyed by string. Keys passed to one `withLocks` call
 * are always acquired in lexical order, so overlapping key sets cannot
 * deadlock. References include queued holders and are removed in the
 * exceptional path as well as success. Each pool has its own key namespace.
 */
export class KeyedLockPool {
  private readonly locks = new Map<string, LockState>();

  private async acquire(key: string): Promise<() => void> {
    let state = this.locks.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), references: 0 };
      this.locks.set(key, state);
    }
    state.references += 1;
    const previous = state.tail;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    state.tail = previous.then(() => gate);
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      state!.references -= 1;
      if (state!.references === 0 && this.locks.get(key) === state) {
        this.locks.delete(key);
      }
    };
  }

  async withLocks<T>(
    keys: string[],
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const ordered = Array.from(new Set(keys)).sort();
    const releases: Array<() => void> = [];
    try {
      for (const key of ordered) releases.push(await this.acquire(key));
      return await operation();
    } finally {
      for (let index = releases.length - 1; index >= 0; index -= 1) {
        releases[index]();
      }
    }
  }
}

const capabilityLocks = new KeyedLockPool();

export function userCapabilityLockKey(userId: string): string {
  return `user:${userId}`;
}

export const SYSTEM_CAPABILITY_LOCK_KEY = 'system';

/**
 * Serializes Agent policy validation/commit with capability mutations. Keys
 * are acquired lexically so operations spanning system + user scopes cannot
 * deadlock with single-scope mutations.
 */
export function withCapabilityScopeLocks<T>(
  keys: string[],
  operation: () => Promise<T> | T,
): Promise<T> {
  return capabilityLocks.withLocks(keys, operation);
}
