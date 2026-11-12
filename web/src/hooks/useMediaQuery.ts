import { useEffect, useState } from 'react';

interface QueryStore {
  mql: MediaQueryList;
  listeners: Set<() => void>;
  onChange: () => void;
}

// One MediaQueryList and one change listener per query, however many
// components ask (every message bubble and link checks the phone query).
const stores = new Map<string, QueryStore>();

function storeFor(query: string): QueryStore {
  let store = stores.get(query);
  if (!store) {
    const listeners = new Set<() => void>();
    store = {
      mql: window.matchMedia(query),
      listeners,
      onChange: () => listeners.forEach((listener) => listener()),
    };
    stores.set(query, store);
  }
  return store;
}

function subscribe(query: string, listener: () => void): () => void {
  const store = storeFor(query);
  if (store.listeners.size === 0) {
    store.mql.addEventListener('change', store.onChange);
  }
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) {
      store.mql.removeEventListener('change', store.onChange);
      // Dropped so a later subscriber reads a fresh list (tests swap
      // window.matchMedia between cases).
      stores.delete(query);
    }
  };
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : storeFor(query).mql.matches,
  );
  useEffect(() => {
    const update = () => setMatches(storeFor(query).mql.matches);
    const unsubscribe = subscribe(query, update);
    update();
    return unsubscribe;
  }, [query]);
  return matches;
}
