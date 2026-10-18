# PlatyJam

PlatyJam is a musical rhythm game planned for the browser. Follow the beat, hit incoming tiles, and keep the melody flowing as each song puts your timing and reflexes to the test.

## Gameplay

- Tiles travel down lanes toward a hit line in time with the music.
- Tap or press the matching lane as a tile reaches the line to play its note.
- Hold sustained tiles for their full duration to carry longer notes.
- Chain accurate hits to build combos and earn higher scores.
- Missed notes break your streak, while faster and more complex patterns increase the challenge.

## Planned technology

- **Backend:** Rust.
- **Frontend:** a TypeScript single-page app with three.js (WebGL 2), installed on iPad as a Home Screen web app. It lives in [`web/`](web/).

## Status

`web/` holds the app shell: an offline-capable PWA with a placeholder stage (tiles falling down four lanes). Gameplay, songs and audio come next.

## Web app (`web/`)

### Toolchain

- **Node 26** and **pnpm 12**, pinned in [`mise.toml`](mise.toml) (`mise install` sets both up), `web/.nvmrc` and `packageManager` in `web/package.json`. CI uses the same versions.
- **TypeScript is pinned to `~6.0.3`** on purpose. typescript-eslint 8 supports only `<6.1.0`, and TypeScript 7 ships no compiler API for it to use yet. Do not bump to 6.1 or 7.x until typescript-eslint supports them.
- No dependency needs install scripts, so pnpm's default build-script blocking stays on and there is no `allowBuilds` list. If a new dependency needs one, `pnpm install` fails and names it; allow just that package under `allowBuilds` in a `pnpm-workspace.yaml`.

### Commands

Run these in `web/`:

| Command          | What it does                                                    |
| ---------------- | --------------------------------------------------------------- |
| `pnpm install`   | Install dependencies (CI uses `pnpm install --frozen-lockfile`) |
| `pnpm dev`       | Dev server at http://127.0.0.1:44663/ (service worker off)      |
| `pnpm build`     | Typecheck, then build to `web/dist/` with base `/PlatyJam/`     |
| `pnpm preview`   | Serve `dist/` at http://127.0.0.1:36787/PlatyJam/ (with the SW) |
| `pnpm test`      | Unit tests (Vitest, jsdom)                                      |
| `pnpm lint`      | ESLint (type-checked rules) and Prettier check                  |
| `pnpm format`    | Prettier write, then ESLint autofix                             |
| `pnpm typecheck` | `tsc` for the app, service worker and config projects           |
| `pnpm icons`     | Regenerate the app icons from `web/assets-src/`                 |

The build is served from `/PlatyJam/` (the GitHub Pages project site). Set `BASE_PATH=/other/` to build for another path.

### Layout

- `src/main.ts` wires the modules together; the platform logic sits in small modules under `src/app/` (lifecycle events, viewport sizing, touch guards, storage, service worker registration, the `?debug` hook).
- `src/render/renderer-host.ts` owns the canvas, the WebGL renderer, the render loop and context-loss recovery.
- `src/scene/` is the placeholder stage. `src/hud/` is the HTML layer above it.
- `src/sw.ts` is the service worker. Three TypeScript projects keep DOM and worker globals apart: `tsconfig.app.json`, `tsconfig.sw.json`, `tsconfig.node.json`.
- `assets-src/platyjam-icon.png` is the original icon artwork. It is not served; `pnpm icons` derives the PNGs in `public/` from it.

### Lifecycle events

Modules subscribe through `lifecycle` in `src/app/lifecycle.ts`; `on()` returns an unsubscribe function.

| Event                  | When                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pause` / `resume`     | The page is hidden or shown again. Rendering stops while hidden. Save progress on `pause`.                                           |
| `contextlost`          | The WebGL context is gone; rendering has stopped.                                                                                    |
| `contextrestored`      | Rebuild every GPU resource against `renderer`. `recreated: true` means a new renderer and canvas replaced one that never recovered. |
| `contextfailed`        | No working WebGL context could be created.                                                                                           |
| `resize`               | The stage changed size (`width`, `height` in CSS px, `pixelRatio` capped at 2).                                                      |
| `storagequotaexceeded` | A guarded Cache API or IndexedDB write hit the quota and was skipped.                                                                |

Wrap storage writes in the guard from `createStorageGuard()` (`src/app/storage.ts`) so a full disk shows a notice instead of breaking the game. Game input on the stage must use Pointer Events: the touch guards cancel `touchstart`, which also stops iOS from synthesising `click` there.

### Offline and caching

- The app shell (HTML, JS, CSS, font, icons) is precached and served offline, for any query string.
- Songs (`songs/…`, audio and MIDI files) and soundfonts (`soundfonts/…`, `.sf2`, `.sf3`) are cached on first use in the `platyjam-songs` and `platyjam-soundfonts` caches. They are never precached. Only whole `200` responses are stored, so load a song with `fetch()` once to make it available offline; a `Range` request from an uncached `<audio>` element passes through without being cached.
- Updates wait: when a new version is ready, the HUD shows **Update now**. Nothing reloads until the player taps it.

## Testing on an iPad

GitHub Pages serves `main` at https://jeffreyvdb.github.io/PlatyJam/.

1. **Install.** Open the site in Safari, tap Share, then **Add to Home Screen** (keep **Open as Web App** on). Launch PlatyJam from the Home Screen icon.
2. **Offline.** Launch once online and wait about 10 seconds ("Ready to play offline." appears on first install). Force-quit the app from the App Switcher, turn on Airplane Mode, and launch it again: the stage should appear.
3. **Rotation.** Rotate the iPad; the lanes should refit without a reload in both orientations.
4. **Background.** Switch to another app and back; the tiles should continue from where they were, without a jump.
5. **Debug hook.** Open `https://jeffreyvdb.github.io/PlatyJam/?debug` (in Safari, or temporarily as the Home Screen URL). A panel shows the render state with **Lose context** and **Restore context** buttons. Lose then restore: the stage stops, then comes back with the scene rebuilt. Lose without restoring: after about 3 seconds the renderer is replaced (`renderer replaced 1×`). The same calls are available as `window.__platyjam.loseContext()` / `.restoreContext()` from Web Inspector (Safari on a Mac: Develop › your iPad › PlatyJam).
6. **Updates.** After a new deployment, bring the app to the foreground; **Update now** appears in the top right.
