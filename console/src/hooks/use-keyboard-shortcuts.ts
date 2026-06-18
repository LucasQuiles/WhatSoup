// ---------------------------------------------------------------------------
//  WhatSoup Console — Global Keyboard Shortcuts
//  Lightweight hook for app-wide hotkeys.
// ---------------------------------------------------------------------------

import { useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

interface ShortcutHandlers {
  /** Called when user triggers "search" shortcut (Cmd/Ctrl+K) */
  onSearch?: () => void;
  /** Called when user presses ? to toggle shortcuts help */
  onHelp?: () => void;
}

/**
 * Registers global keyboard shortcuts for the console.
 *
 * Shortcuts:
 * - Cmd/Ctrl+K → Focus search input (calls onSearch)
 * - Escape → Close modals / clear search (browser-native for modals)
 * - 1-3 → Navigate to pages (only when no input focused)
 *   1 = SoupKitchen, 2 = Inbox, 3 = Ops
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers = {}) {
  const navigate = useNavigate();
  const location = useLocation();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;

      // Cmd/Ctrl+K — search (works even in inputs)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        handlers.onSearch?.();
        return;
      }

      // Don't handle other shortcuts when typing in an input
      if (isInput) return;

      // ? key — toggle shortcuts help
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        handlers.onHelp?.();
        return;
      }

      // Number keys for page navigation (no modifiers)
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        switch (e.key) {
          case '1':
            if (location.pathname !== '/') navigate('/');
            return;
          case '2':
            if (location.pathname !== '/inbox') navigate('/inbox');
            return;
          case '3':
            // Navigate to the canonical /operator route, not the /ops alias: /ops is a
            // <Navigate to="/operator" replace> redirect, so navigate('/ops') from /operator
            // pushes a spurious history entry before the redirect — breaking the Back button.
            if (location.pathname !== '/operator') navigate('/operator');
            return;
        }
      }
    },
    [navigate, location.pathname, handlers],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
