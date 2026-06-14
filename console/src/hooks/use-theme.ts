// Theme management hook.
// Persists theme preference via the existing preferences store (whatsoup: namespace).
// Key: 'theme'; values: 'dark' | 'light'; default: 'dark'.
// Theme is applied as data-theme attribute on <html> (tokens-v3 §5 mechanics).
import { useCallback, useEffect, useState } from 'react';
import { getPreference, setPreference } from '../lib/preferences';

export type Theme = 'dark' | 'light';

const THEME_KEY = 'theme';
const THEME_COLOR_META_SELECTOR = 'meta[name="theme-color"]';
const THEME_COLOR_TOKEN = '--surface-base';

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector(THEME_COLOR_META_SELECTOR);
  const themeColor = meta ? getComputedStyle(document.documentElement).getPropertyValue(THEME_COLOR_TOKEN).trim() : '';
  if (themeColor) meta?.setAttribute('content', themeColor);
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
