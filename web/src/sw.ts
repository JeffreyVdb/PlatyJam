/**
 * PlatyJam service worker (built by vite-plugin-pwa, `injectManifest`).
 *
 * - App shell: precached at install, so the game launches offline from start_url.
 * - Songs and soundfonts: cached on first use at runtime, never precached
 *   (they are large, and the precache is downloaded in full on every update).
 * - Updates: a new worker waits until the page sends SKIP_WAITING, which the HUD's
 *   "Update" button does. Nothing reloads mid-song on its own.
 *
 * Navigation preload stays off: it has produced blank Home Screen launches on iOS
 * (WebKit 236483).
 */
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim, registerQuotaErrorCallback } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import type { PrecacheEntry } from 'workbox-precaching';
import { RangeRequestsPlugin } from 'workbox-range-requests';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import {
  SONGS_CACHE,
  SOUNDFONTS_CACHE,
  mediaCacheFor,
  type MediaCacheName,
} from './sw/media-routes';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | PrecacheEntry)[];
};

const scope = new URL(self.registration.scope);

// --- App shell ---------------------------------------------------------------

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Serve the precached index.html for every navigation in scope, whatever its query
// string (`?debug`, launch parameters), so the app opens offline.
registerRoute(new NavigationRoute(createHandlerBoundToURL(new URL('index.html', scope).href)));

// --- Songs and soundfonts -----------------------------------------------------

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function mediaStrategy(cacheName: MediaCacheName, maxEntries: number): CacheFirst {
  return new CacheFirst({
    cacheName,
    plugins: [
      // Only whole, successful responses. A 206 from an uncached <audio> range
      // request is passed through but not stored; fetch() the whole file to cache it.
      new CacheableResponsePlugin({ statuses: [200] }),
      // Lets Safari seek: answers Range requests by slicing the cached whole file.
      new RangeRequestsPlugin(),
      // On a full disk, drop this cache rather than fail. The cache write runs after
      // the network response is returned (Workbox waitUntil), so the player still
      // gets the song either way.
      new ExpirationPlugin({
        maxEntries,
        maxAgeSeconds: ONE_YEAR_SECONDS,
        purgeOnQuotaError: true,
      }),
    ],
  });
}

const strategies: Record<MediaCacheName, CacheFirst> = {
  [SONGS_CACHE]: mediaStrategy(SONGS_CACHE, 200),
  [SOUNDFONTS_CACHE]: mediaStrategy(SOUNDFONTS_CACHE, 40),
};

registerRoute(
  ({ url, request }) => request.method === 'GET' && mediaCacheFor(url, scope) !== null,
  (options) => {
    const cacheName = mediaCacheFor(options.url, scope) ?? SONGS_CACHE;
    return strategies[cacheName].handle(options);
  },
);

// Tell open pages so the HUD can explain why a song was not saved for offline play.
registerQuotaErrorCallback(() => {
  void self.clients.matchAll({ type: 'window' }).then((clients) => {
    for (const client of clients) client.postMessage({ type: 'STORAGE_QUOTA_EXCEEDED' });
  });
});

// --- Update flow -------------------------------------------------------------

self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// Take control of the first page load immediately, so it works offline without a
// reload. Later versions still wait for SKIP_WAITING before activating.
clientsClaim();
