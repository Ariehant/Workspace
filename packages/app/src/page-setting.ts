import { useEffect, useState } from 'react';
import { useApp } from './context';

/** Every mounted `usePageSetting`, told about changes (the page menu → the page). */
const listeners = new Set<(key: string, value: string) => void>();

/**
 * A per-page display setting (how backlinks or comments show), saved in this device's
 * settings under `<name>.<pageId>`.
 */
export function usePageSetting<T extends string>(
  name: string,
  pageId: string,
  fallback: T,
): [T, (value: T) => void] {
  const { platform } = useApp();
  const key = `${name}.${pageId}`;
  const [state, setState] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    let live = true;
    void platform.getSetting<T>(key).then(
      (value) =>
        live &&
        // A change made while loading wins.
        setState((current) => (current?.key === key ? current : { key, value: value ?? fallback })),
    );
    const listener = (changed: string, value: string) => {
      if (changed === key) setState({ key, value: value as T });
    };
    listeners.add(listener);
    return () => {
      live = false;
      listeners.delete(listener);
    };
    // `fallback` is a constant at each call site.
  }, [platform, key]);
  const set = (value: T) => {
    platform.setSetting(key, value);
    for (const listener of listeners) listener(key, value);
  };
  return [state?.key === key ? state.value : fallback, set];
}
