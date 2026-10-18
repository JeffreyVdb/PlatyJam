import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages project site: https://jeffreyvdb.github.io/PlatyJam/
const PAGES_BASE = '/PlatyJam/';

// Brand colours, kept in sync with the tokens in src/style.css.
const RIVER_DEEP = '#0d2b3e';

/** Normalises an override such as `PlatyJam` or `/x` into `/x/`. */
function normaliseBase(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '/' : `/${trimmed}/`;
}

export default defineConfig(({ command, isPreview }) => {
  // `vite preview` resolves config with command 'serve', so check isPreview too:
  // preview must serve dist/ at the same base it was built with.
  const base =
    command === 'build' || isPreview ? normaliseBase(process.env.BASE_PATH ?? PAGES_BASE) : '/';

  return {
    base,
    server: { host: '127.0.0.1', port: 44663, strictPort: true },
    preview: { host: '127.0.0.1', port: 36787, strictPort: true },
    build: {
      // three.js gets its own long-lived chunk, so an app update does not make
      // installed copies download the renderer again. It is ~550 kB on its own.
      chunkSizeWarningLimit: 700,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }],
          },
        },
      },
    },
    plugins: [
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        // The app calls registerSW() from virtual:pwa-register itself (src/app/pwa.ts).
        injectRegister: false,
        // A waiting worker only takes over when the player taps "Update" in the HUD.
        registerType: 'prompt',
        // Icons are already matched by globPatterns; don't list them twice.
        includeManifestIcons: false,
        injectManifest: {
          // App shell only. Songs and soundfonts are cached at runtime by src/sw.ts,
          // so audio extensions must never appear here.
          // The 1254 px icon original lives in assets-src/, outside public/, and never ships.
          globPatterns: ['**/*.{html,js,css,svg,png,ico,woff2}'],
        },
        manifest: {
          id: base,
          name: 'PlatyJam',
          short_name: 'PlatyJam',
          description: 'Tap the tiles as they reach the line and play the song.',
          // No query string: the precache matches start_url exactly (utm_/fbclid only are ignored).
          start_url: base,
          scope: base,
          display: 'standalone',
          // No `orientation`: iPadOS ignores it, and PlatyJam plays in both orientations.
          theme_color: RIVER_DEEP,
          background_color: RIVER_DEEP,
          lang: 'en',
          icons: [
            // Generated from assets-src/platyjam-icon.png by `pnpm icons`.
            { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png', purpose: 'any' },
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            {
              src: 'maskable-icon-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
      }),
    ],
  };
});
