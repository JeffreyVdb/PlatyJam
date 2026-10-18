import type { Lifecycle } from './lifecycle';

interface StandaloneWindow {
  matchMedia?: (query: string) => { matches: boolean };
  /** Apple adds a non-standard `standalone` flag. */
  navigator: object;
}

/** True when launched from the Home Screen rather than in a browser tab. */
export function isInstalledWebApp(win: StandaloneWindow = window): boolean {
  // `navigator.standalone` is Apple's legacy flag; display-mode is the standard check.
  return (
    win.matchMedia?.('(display-mode: standalone)').matches === true ||
    (win.navigator as { standalone?: unknown }).standalone === true
  );
}

type PersistentStorage = Partial<Pick<StorageManager, 'persist' | 'persisted'>>;

/** `navigator.storage`, or null where the browser lacks it (old WebKit, insecure origins). */
function defaultStorage(): PersistentStorage | null {
  // lib.dom types this as always present; it is not.
  return (navigator as Partial<Navigator>).storage ?? null;
}

/**
 * Asks the browser not to evict our storage. WebKit grants this on heuristics,
 * favouring Home Screen apps, so the result is advisory. Never throws.
 */
export async function requestPersistence(storage: PersistentStorage | null): Promise<boolean> {
  try {
    if (!storage?.persist) return false;
    if ((await storage.persisted?.()) === true) return true;
    return await storage.persist();
  } catch (error) {
    console.warn('[platyjam] storage persistence request failed', error);
    return false;
  }
}

export interface PersistenceSetupOptions {
  win?: StandaloneWindow & Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Defaults to `navigator.storage`; null means the API is missing. */
  storage?: PersistentStorage | null;
  onResult?: (persisted: boolean) => void;
}

/**
 * Requests persistent storage once: at startup when running installed, otherwise on
 * `appinstalled` where the browser fires it (iPadOS does not).
 */
export function setupStoragePersistence({
  win = window,
  storage = defaultStorage(),
  onResult,
}: PersistenceSetupOptions = {}): () => void {
  let requested = false;
  const request = () => {
    if (requested) return;
    requested = true;
    void requestPersistence(storage).then((persisted) => onResult?.(persisted));
  };

  if (isInstalledWebApp(win)) {
    request();
    return () => undefined;
  }

  const onInstalled = () => {
    win.removeEventListener('appinstalled', onInstalled);
    request();
  };
  win.addEventListener('appinstalled', onInstalled);
  return () => {
    win.removeEventListener('appinstalled', onInstalled);
  };
}

/**
 * Recognises "storage full" across engines: the standard `QuotaExceededError`, the
 * legacy DOMException code 22, and Firefox's `NS_ERROR_DOM_QUOTA_REACHED` (code 1014).
 */
export function isQuotaExceededError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

export type StorageGuard = <T>(context: string, write: () => Promise<T>) => Promise<T | undefined>;

/**
 * Wraps Cache API / IndexedDB writes so a full disk degrades instead of failing:
 * on a quota error the write is skipped, logged and announced as
 * `storagequotaexceeded`, and the guard resolves to `undefined`. Other errors rethrow.
 *
 *   await guardStorageWrite('song cache', () => cache.put(request, response));
 */
export function createStorageGuard(bus: Lifecycle): StorageGuard {
  return async (context, write) => {
    try {
      return await write();
    } catch (error) {
      if (!isQuotaExceededError(error)) throw error;
      console.warn(`[platyjam] storage is full; skipped write: ${context}`, error);
      bus.emit('storagequotaexceeded', { context, error });
      return undefined;
    }
  };
}
