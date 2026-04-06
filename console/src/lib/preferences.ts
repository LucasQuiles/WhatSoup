// ---------------------------------------------------------------------------
//  User preference persistence via localStorage.
// ---------------------------------------------------------------------------

const PREFIX = 'whatsoup:';

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getPreference<T extends string>(key: string, fallback: T, storage: Storage = localStorage): T {
  try {
    const val = storage.getItem(`${PREFIX}${key}`);
    return (val as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setPreference(key: string, value: string, storage: Storage = localStorage): void {
  try {
    storage.setItem(`${PREFIX}${key}`, value);
  } catch {
    // localStorage unavailable (SSR, private browsing quota)
  }
}
