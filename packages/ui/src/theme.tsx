import { useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const darkQuery = '(prefers-color-scheme: dark)';

/** Resolve the preference against the OS setting and apply it to <html data-theme>. */
export function useAppliedTheme(preference: ThemePreference): ResolvedTheme {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(darkQuery).matches);

  useEffect(() => {
    const media = window.matchMedia(darkQuery);
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme =
    preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  return resolved;
}
