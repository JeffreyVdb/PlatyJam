import { registerSW } from 'virtual:pwa-register';
import type { Lifecycle } from './lifecycle';

export interface ServiceWorkerOptions {
  bus: Lifecycle;
  /** A new version is waiting. Call `apply` when the player chooses to update. */
  onUpdateReady: (apply: () => void) => void;
  /** The app shell is cached; PlatyJam now opens offline. */
  onOfflineReady: () => void;
}

/**
 * Registers the service worker in "prompt" mode: an update waits until the player
 * taps the HUD's update button. The page reloads only after that tap, never on its own.
 */
export function setupServiceWorker({ bus, onUpdateReady, onOfflineReady }: ServiceWorkerOptions) {
  let requested = false;
  let registration: ServiceWorkerRegistration | undefined;
  const reload = () => {
    window.location.reload();
  };

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      onUpdateReady(() => {
        requested = true;
        // The waiting worker may already have been activated from another window.
        if (registration?.waiting) void updateSW();
        else reload();
      });
    },
    onNeedReload() {
      // Another window applied the update. Let this one reload when the player is ready.
      if (requested) reload();
      else onUpdateReady(reload);
    },
    onOfflineReady,
    onRegisteredSW(_url, registered) {
      registration = registered;
      // A Home Screen app may stay open for days; look for updates whenever it returns.
      if (registered) {
        bus.on('resume', () => {
          void registered.update().catch(() => undefined);
        });
      }
    },
    onRegisterError(error: unknown) {
      console.error('[platyjam] service worker registration failed', error);
    },
  });

  // Absent on insecure origins (e.g. a LAN IP over http), where nothing is registered.
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<unknown>) => {
    if ((event.data as { type?: unknown } | null)?.type === 'STORAGE_QUOTA_EXCEEDED') {
      bus.emit('storagequotaexceeded', {
        context: 'service worker media cache',
        error: new DOMException('Media cache write failed', 'QuotaExceededError'),
      });
    }
  });
}
