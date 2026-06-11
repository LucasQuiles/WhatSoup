// Theme management hook.
// Persists theme preference via the existing preferences store (whatsoup: namespace).
// Key: 'theme'; values: 'dark' | 'light'; default: 'dark'.
// Theme is applied as data-theme attribute on <html> (tokens-v3 §5 mechanics).
import { useCallback, useEffect, useState } from 'react';
import { getPreference, setPreference } from '../lib/preferences';

export type Theme = 'dark' | 'light';

const THEME_KEY = 'theme';

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = getPreference<Theme>(THEME_KEY, 'dark');
    return stored === 'light' ? 'light' : 'dark';
  });

  useEffect(() => {
    applyTheme(theme);
    setPreference(THEME_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggleTheme };
}
