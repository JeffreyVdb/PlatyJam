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

`web/` holds the app shell: an offline-capable PWA with a placeholder stage (tiles falling down four lanes), and the audio engine: game clock, piano sampler, accompaniment scheduler and latency calibration. Gameplay and songs come next.

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
- `src/scene/` is the placeholder stage. `src/hud/` is the HTML layer above it, including the "Tap to resume" overlay and the `?debug` Audio tools.
- `src/audio/` is the audio engine (see [Audio](#audio)); `src/calibration/` is the latency calibration overlay.
- `src/sw.ts` is the service worker. Three TypeScript projects keep DOM and worker globals apart: `tsconfig.app.json`, `tsconfig.sw.json`, `tsconfig.node.json`.
- `assets-src/platyjam-icon.png` is the original icon artwork. It is not served; `pnpm icons` derives the PNGs in `public/` from it.

### Lifecycle events

Modules subscribe through `lifecycle` in `src/app/lifecycle.ts`; `on()` returns an unsubscribe function.

| Event                  | When                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pause` / `resume`     | The page is hidden or shown again. Rendering stops while hidden. Save progress on `pause`.                                          |
| `contextlost`          | The WebGL context is gone; rendering has stopped.                                                                                   |
| `contextrestored`      | Rebuild every GPU resource against `renderer`. `recreated: true` means a new renderer and canvas replaced one that never recovered. |
| `contextfailed`        | No working WebGL context could be created.                                                                                          |
| `resize`               | The stage changed size (`width`, `height` in CSS px, `pixelRatio` capped at 2).                                                     |
| `storagequotaexceeded` | A guarded Cache API or IndexedDB write hit the quota and was skipped.                                                               |

Wrap storage writes in the guard from `createStorageGuard()` (`src/app/storage.ts`) so a full disk shows a notice instead of breaking the game. Game input on the stage must use Pointer Events: the touch guards cancel `touchstart`, which also stops iOS from synthesising `click` there.

### Offline and caching

- The app shell (HTML, JS, CSS, font, icons) is precached and served offline, for any query string.
- The piano samples live in `public/soundfonts/fluidr3-gm/acoustic_grand_piano/` (88 MP3s, about 1.9 MB) and are served from `<base>soundfonts/fluidr3-gm/…`. The app fetches all of them at startup, so the first online launch fills the soundfont cache and the piano then works offline.
- Songs (`songs/…`, audio and MIDI files) and soundfonts (`soundfonts/…`, `.sf2`, `.sf3`) are cached on first use in the `platyjam-songs` and `platyjam-soundfonts` caches. They are never precached. Only whole `200` responses are stored, so load a song with `fetch()` once to make it available offline; a `Range` request from an uncached `<audio>` element passes through without being cached.
- Updates wait: when a new version is ready, the HUD shows **Update now**. Nothing reloads until the player taps it.

## Audio

Everything under `web/src/audio/`. The pure maths has no Web Audio imports and is unit-tested; only `engine.ts`, `sampler.ts`, `click.ts` and `backing-track.ts` touch Web Audio objects.

| Module             | What it does                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `engine.ts`        | Owns the one `AudioContext` and master gain: unlock, `audioSession`, interruptions, recreation, the song clock |
| `clock.ts`         | The song clock: context time to song time, with start offset, pause, resume and tempo                          |
| `output-time.ts`   | Maps a `performance.now()` time (an `event.timeStamp`) to context time with `getOutputTimestamp()`             |
| `timeline.ts`      | The clock plus calibrated offsets: `songTime()`, `judgeSongTime()`, `startTimeFor()`                           |
| `sampler.ts`       | Piano voices: `noteOn` / `noteOff`, velocity curve, release envelope, 48-voice cap                             |
| `piano-samples.ts` | Loads the 88 FluidR3 MP3s with `fetch` and `decodeAudioData`, six at a time                                    |
| `scheduler.ts`     | Look-ahead accompaniment (25 ms tick, 100 ms horizon) and the `AccompanimentNote` type charts use              |
| `backing-track.ts` | An optional audio file started in sync with the clock                                                          |
| `calibration*.ts`  | Calibration statistics, and saving the offsets                                                                 |
| `game-audio.ts`    | Wires engine, piano and accompaniment together; `main.ts` calls it                                             |

### Time model

- **Song time** is in ms of chart time (the chart at 1×). The clock maps context time (`ctx.currentTime`) to song time: at tempo `t` (0.75 to 1.5) song time advances `t` ms per real ms. Nothing is derived from frame counts.
- Pausing stores the song position; resuming re-anchors it to the current context time. A recreated context starts again at `currentTime` 0, so no context-time anchor survives a pause. Changing the tempo re-anchors so the position does not jump.
- `engine.timeline.songTime()` is for rendering: the song time the player hears now, through the output timestamp. It never goes backwards while the clock runs.
- `engine.timeline.judgeSongTime(event.timeStamp)` is the song time at which a tap happened. Gameplay judges hits with it, and it is the only place the input offset is applied.
- Accompaniment, clicks and backing files start at `engine.timeline.startTimeFor(c)`: `clock.ctxTimeFor(c) − A / 1000`.

### Latency offsets

All offsets are real-time ms (never scaled by tempo), and **positive means late**:

- **A**, the audio offset: a sound reaches the ear A ms after it was scheduled. Sounds are scheduled A ms early.
- **I**, the input offset: a tap reaches the page I ms after it happened. Taps are judged at `event.timeStamp − I`.
- Visual latency is assumed to be 0 and is folded into I.

The calibration (`openCalibration()` in `src/calibration/`, opened from **Calibrate** in `?debug` until PLA-7's settings screen exists) runs two tap-along rounds at 100 BPM: a 4-beat count-in, then 16 scored beats. **Watch** has flashes and no sound, and gives P_seen. **Listen** has clicks and no moving visuals, and gives P_heard. It drops the first 4 scored taps and taps more than 120 ms off, needs at least 8 taps, and takes the median. If the spread (IQR) is over 60 ms it asks for a retry. Then `I = P_seen` and `A = P_heard − P_seen`, clamped to −150…+250 ms and −150…+400 ms. Both rounds use the gameplay clock, scheduler and `judgeSongTime` with the offsets at zero, so any bias in that pipeline is measured too. The result is saved as `{ version: 1, audioOffsetMs, inputOffsetMs, calibratedAt }` under the `localStorage` key `platyjam.calibration.v1` and loaded at startup; missing or corrupt data reads as zeros.

### Engine events

Subscribe with `engine.events.on(type, handler)`:

| Event          | When                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `statechange`  | The context's own state changed (`running`, `suspended`, `interrupted`, `closed`).                      |
| `unlocked`     | Audio started for the first time.                                                                       |
| `interrupted`  | The song clock paused and audio is fading out. Show "Tap to resume"; call `engine.resumeFromGesture()`. |
| `needsgesture` | That tap did not bring the sound back. Ask for one more tap; it recreates the context.                  |
| `resumed`      | Audio runs again and the song clock continues. The accompaniment re-plans from the current song time.   |
| `recreated`    | A new `AudioContext` replaced a stuck one. Nodes are gone; decoded `AudioBuffer`s are reused.           |
| `silenced`     | `engine.silence()` was called (the calibration does on open): fade out every sound and forget the song. |

### Unlock and interruptions

- At startup the engine sets `navigator.audioSession.type = 'playback'` where it exists (iOS 17+), so the silent switch does not mute the game, and reads it back. With `playback`, WebKit no longer pauses audio in the background and Now Playing / lock-screen controls can appear, so the engine pauses itself.
- **Unlock:** capture-phase listeners on `document` call `ctx.resume()` synchronously on `touchend`, `pointerup` (touch and pen), `pointerdown` (mouse), `mousedown`, `keydown` and `click`, and are removed once the context runs. Touch `pointerdown` does not count as a user gesture.
- **Background:** on the lifecycle `pause` event, or when the context goes `interrupted` or suspends on its own, the engine pauses the song clock, emits `interrupted` (scheduled audio fades out over 30 ms), then suspends the context.
- **Return:** on the lifecycle `resume` event it runs a silent recovery (suspend, wait 200 ms, resume) but leaves the song paused.
- **Tap to resume:** `resumeFromGesture()` calls `resume()` inside the tap. If that rejects, takes over 300 ms, or the clock does not move afterwards (WebKit bug 263627), the overlay asks for one more tap, and that tap creates a new `AudioContext` synchronously before resuming. If the silent recovery already failed, the first tap recreates it.

### Credits

Piano samples: acoustic grand piano from FluidR3_GM by Frank Wen and contributors, MP3 conversion by Benjamin Gleitzman ([gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts)), licensed under [CC BY 3.0 US](https://creativecommons.org/licenses/by/3.0/us/). The files are unmodified. Full notice: [`web/public/soundfonts/fluidr3-gm/ATTRIBUTION.md`](web/public/soundfonts/fluidr3-gm/ATTRIBUTION.md).

## Testing on an iPad

GitHub Pages serves `main` at https://jeffreyvdb.github.io/PlatyJam/.

1. **Install.** Open the site in Safari, tap Share, then **Add to Home Screen** (keep **Open as Web App** on). Launch PlatyJam from the Home Screen icon.
2. **Offline.** Launch once online and wait about 10 seconds ("Ready to play offline." appears on first install). Force-quit the app from the App Switcher, turn on Airplane Mode, and launch it again: the stage should appear.
3. **Rotation.** Rotate the iPad; the lanes should refit without a reload in both orientations.
4. **Background.** Switch to another app and back; the tiles should continue from where they were, without a jump.
5. **Debug hook.** Open `https://jeffreyvdb.github.io/PlatyJam/?debug` (in Safari, or temporarily as the Home Screen URL). A panel shows the render state with **Lose context** and **Restore context** buttons. Lose then restore: the stage stops, then comes back with the scene rebuilt. Lose without restoring: after about 3 seconds the renderer is replaced (`renderer replaced 1×`). The same calls are available as `window.__platyjam.loseContext()` / `.restoreContext()` from Web Inspector (Safari on a Mac: Develop › your iPad › PlatyJam).
6. **Updates.** After a new deployment, bring the app to the foreground; **Update now** appears in the top right.

### Audio on an iPad

Use the Home Screen app opened with `?debug`. The **Audio** section of the debug panel shows the engine state, the audio session, unlock attempts per event type, loaded samples, voices, context recreations and the saved offsets.

1. **Silent mode and the first tap.** Turn on silent mode, launch the app and tap the **Tap pad**. The note should sound on that first tap. The panel should read `Audio session: playback` and `Engine running`, and **Unlock attempts** shows which event unlocked it. If it never says `running`, note which events were counted.
2. **Background and return.** Start the sync test, then switch to another app and back. Expect Now Playing / lock-screen controls while it plays. On return the game shows **Paused**; tap once and the music continues from where it stopped. If it asks to tap again, tap: `context recreated` should go up by one and the sound should come back. It should never stay silent. **Simulate pause** and **Simulate stuck pause** run the same paths without leaving the app.
3. **3-minute sync.** Start the sync test at 1× (120 BPM piano metronome and chords for 3 minutes). The dot should flash exactly with each click to the end, `skipped late` should stay at 0, and `clock drift` and `output lag` should stay roughly constant. Repeat at 0.75× and 1.5×.
4. **Tap-to-sound latency.** Use the built-in speakers at full volume. Film the iPad from the side in slow motion (240 fps) while tapping the **Tap pad** with a fingernail, so the tap is audible. Step through the video: the latency is the time from the fingertip touching the glass to the start of the piano note in the audio track (count frames, about 4.2 ms each at 240 fps). Take the median of 10 taps and record it on PLA-3.
5. **Calibration persistence.** Tap **Calibrate**, complete both rounds and **Save**. Force-quit the app and relaunch it: the panel's **Calibration** line still shows the saved values.
