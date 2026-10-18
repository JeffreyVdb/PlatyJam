import { describe, expect, it, vi } from 'vitest';
import { createLifecycle } from './lifecycle';
import {
  createStorageGuard,
  isInstalledWebApp,
  isQuotaExceededError,
  requestPersistence,
  setupStoragePersistence,
} from './storage';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeWindow({ standaloneMedia = false, standalone = undefined as boolean | undefined }) {
  const target = new EventTarget();
  return {
    matchMedia: (query: string) => ({
      matches: query === '(display-mode: standalone)' && standaloneMedia,
    }),
    navigator: { standalone },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
}

function fakeStorage(persisted = false) {
  return {
    persisted: vi.fn(() => Promise.resolve(persisted)),
    persist: vi.fn(() => Promise.resolve(true)),
  };
}

describe('isInstalledWebApp', () => {
  it('detects the standalone display mode', () => {
    expect(isInstalledWebApp(fakeWindow({ standaloneMedia: true }))).toBe(true);
  });

  it("detects Apple's navigator.standalone", () => {
    expect(isInstalledWebApp(fakeWindow({ standalone: true }))).toBe(true);
  });

  it('is false in a browser tab', () => {
    expect(isInstalledWebApp(fakeWindow({}))).toBe(false);
  });

  it('copes with a missing matchMedia', () => {
    expect(isInstalledWebApp({ navigator: {} })).toBe(false);
  });
});

describe('requestPersistence', () => {
  it('asks for persistence when not yet persisted', async () => {
    const storage = fakeStorage(false);
    await expect(requestPersistence(storage)).resolves.toBe(true);
    expect(storage.persist).toHaveBeenCalledOnce();
  });

  it('does not ask again when already persisted', async () => {
    const storage = fakeStorage(true);
    await expect(requestPersistence(storage)).resolves.toBe(true);
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it('resolves false when the API is missing', async () => {
    await expect(requestPersistence(null)).resolves.toBe(false);
    await expect(requestPersistence({})).resolves.toBe(false);
  });

  it('resolves false instead of throwing when the browser rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = { persist: () => Promise.reject(new Error('nope')) };
    await expect(requestPersistence(storage)).resolves.toBe(false);
  });
});

describe('setupStoragePersistence', () => {
  it('requests persistence at startup when installed', async () => {
    const storage = fakeStorage();
    const onResult = vi.fn();
    setupStoragePersistence({ win: fakeWindow({ standalone: true }), storage, onResult });
    await flush();

    expect(storage.persist).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it('waits for appinstalled in a browser tab, then requests once', async () => {
    const win = fakeWindow({});
    const storage = fakeStorage();
    setupStoragePersistence({ win, storage });
    await flush();
    expect(storage.persist).not.toHaveBeenCalled();

    win.dispatchEvent(new Event('appinstalled'));
    win.dispatchEvent(new Event('appinstalled'));
    await flush();
    expect(storage.persist).toHaveBeenCalledOnce();
  });

  it('does nothing harmful when the storage API is missing', async () => {
    const onResult = vi.fn();
    setupStoragePersistence({
      win: fakeWindow({ standalone: true }),
      storage: null,
      onResult,
    });
    await flush();
    expect(onResult).toHaveBeenCalledWith(false);
  });
});

describe('isQuotaExceededError', () => {
  it('matches the standard DOMException', () => {
    expect(isQuotaExceededError(new DOMException('full', 'QuotaExceededError'))).toBe(true);
  });

  it('matches the legacy code 22 and the Firefox variant', () => {
    expect(isQuotaExceededError({ name: 'Error', code: 22 })).toBe(true);
    expect(isQuotaExceededError({ name: 'NS_ERROR_DOM_QUOTA_REACHED', code: 1014 })).toBe(true);
  });

  it('rejects other errors and non-errors', () => {
    expect(isQuotaExceededError(new DOMException('gone', 'NotFoundError'))).toBe(false);
    expect(isQuotaExceededError(new TypeError('x'))).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
    expect(isQuotaExceededError('QuotaExceededError')).toBe(false);
  });
});

describe('createStorageGuard', () => {
  it('returns the write result when it succeeds', async () => {
    const guard = createStorageGuard(createLifecycle());
    await expect(guard('test', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('swallows quota errors, logs, and announces them', async () => {
    const bus = createLifecycle();
    const onFull = vi.fn();
    bus.on('storagequotaexceeded', onFull);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new DOMException('full', 'QuotaExceededError');

    const result = await createStorageGuard(bus)('song cache', () => Promise.reject<number>(error));

    expect(result).toBeUndefined();
    expect(onFull).toHaveBeenCalledExactlyOnceWith({ context: 'song cache', error });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('rethrows anything that is not a quota error', async () => {
    const bus = createLifecycle();
    const onFull = vi.fn();
    bus.on('storagequotaexceeded', onFull);
    const error = new TypeError('broken');

    await expect(createStorageGuard(bus)('x', () => Promise.reject(error))).rejects.toBe(error);
    expect(onFull).not.toHaveBeenCalled();
  });
});
