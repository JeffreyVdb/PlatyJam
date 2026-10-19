import './style.css';
import { installDebugHook, isDebugEnabled } from './app/debug';
import { installPageLifecycle, lifecycle } from './app/lifecycle';
import { setupServiceWorker } from './app/pwa';
import { setupStoragePersistence } from './app/storage';
import { installTouchGuards } from './app/touch-guards';
import { watchViewport } from './app/viewport';
import { createGameAudio, type GameAudio } from './audio/game-audio';
import { openCalibration } from './calibration/calibration-overlay';
import { loadChart } from './chart/load';
import { installLaneInput } from './game/input';
import { createGameplaySession, type GameplaySession } from './game/session';
import { isRunActive } from './game/session-contract';
import { setupFromQuery } from './game/url-setup';
import { createAudioDebugSection } from './hud/audio-debug';
import { createHud, type Hud } from './hud/hud';
import { createInterimScreens } from './hud/interim-screens';
import { createPlayHud } from './hud/play-hud';
import { createResumeOverlay } from './hud/resume-overlay';
import { createRendererHost, type RendererHost } from './render/renderer-host';
import { createGameStage } from './scene/game-stage';

function required(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`index.html is missing ${selector}`);
  return node;
}

/**
 * Sound: unlock on the first gesture, the "Tap to resume" overlay, and the piano,
 * which starts loading now. Returns undefined where Web Audio is missing. Piano
 * notes that failed to load are reported by the game (see `startGame`).
 *
 * `ownsPause` says whether a game run is handling interruptions itself (its pause
 * screen and countdown); the generic overlay then stays out of the way.
 */
function startAudio(
  hudRoot: HTMLElement,
  hud: Hud,
  ownsPause: () => boolean,
): GameAudio | undefined {
  let audio: GameAudio;
  try {
    audio = createGameAudio({ bus: lifecycle, base: import.meta.env.BASE_URL });
  } catch (error) {
    console.error('[platyjam] Web Audio is unavailable', error);
    hud.showNotice("Sound isn't available in this browser.");
    return undefined;
  }
  const { engine } = audio;
  engine.installUnlock(document);

  const overlay = createResumeOverlay(hudRoot, () => {
    engine.resumeFromGesture();
  });
  engine.events.on('interrupted', () => {
    if (!ownsPause()) overlay.show('paused');
  });
  engine.events.on('needsgesture', () => {
    if (!ownsPause()) overlay.show('retry');
  });
  engine.events.on('recovered', () => {
    overlay.hide();
  });
  return audio;
}

/** What the stage draws when there is no game (no Web Audio). */
const NO_GAME = { config: undefined, simulation: undefined, songMs: 0, state: 'loading' } as const;

/**
 * The game: a session for the song in the query string, lane input on the stage,
 * and the interim screens standing in for PLA-7.
 *
 * Missing piano notes: if the song needs one, the session stops at `error` and the
 * Start screen offers Reload. Otherwise the song is playable, and a notice says
 * that some other notes are missing.
 */
function startGame(
  stage: HTMLElement,
  hudRoot: HTMLElement,
  hud: Hud,
  reload: () => void,
  audio: GameAudio,
  scene: ReturnType<typeof createGameStage>,
): GameplaySession {
  const session = createGameplaySession({ audio, bus: lifecycle });
  const input = installLaneInput({
    surface: stage,
    laneAt: (x, y) => scene.laneAt(x, y),
    accepting: () => session.acceptsInput(),
    sink: session.input,
  });
  session.attachInput(input);
  scene.setLaneHeld((lane) => input.isLaneHeld(lane));
  createInterimScreens(hudRoot, session, reload);
  const offReady = session.events.on('statechange', ({ state }) => {
    if (state !== 'ready') return;
    offReady();
    const { failed } = session.loading.samples;
    if (failed === 0) return;
    hud.showProblem(
      `${failed} piano notes didn't download. Reload when you're online to get them.`,
      'Reload',
      reload,
    );
  });

  const { song, ...settings } = setupFromQuery(window.location.search);
  session.load({
    ...settings,
    chart: loadChart(`${import.meta.env.BASE_URL}songs/${song}.json`),
  });
  return session;
}

function main() {
  const stage = required('#stage');
  const hudRoot = required('#hud');
  const hud = createHud(hudRoot);
  const reload = () => {
    window.location.reload();
  };

  installTouchGuards(stage);
  installPageLifecycle(lifecycle);
  let session: GameplaySession | undefined;
  const audio = startAudio(hudRoot, hud, () => (session ? isRunActive(session.state) : false));
  setupStoragePersistence();
  setupServiceWorker({
    bus: lifecycle,
    onUpdateReady: (apply) => {
      hud.showUpdate(apply);
    },
    onOfflineReady: () => {
      hud.showNotice('Ready to play offline.');
    },
  });

  lifecycle.on('storagequotaexceeded', () => {
    hud.showNotice("Storage is full. Songs still play, but new ones won't be saved for offline.");
  });
  lifecycle.on('contextfailed', ({ error }) => {
    console.error('[platyjam] WebGL is unavailable', error);
    hud.showProblem('The game screen stopped working.', 'Reload', reload);
  });

  let host: RendererHost;
  try {
    host = createRendererHost({ surface: stage, bus: lifecycle });
  } catch (error) {
    console.error('[platyjam] could not start WebGL 2', error);
    hud.showProblem("PlatyJam can't start its graphics in this browser.", 'Try again', reload);
    return;
  }

  const scene = createGameStage({ surface: stage });
  lifecycle.on('resize', ({ width, height }) => {
    scene.resize(width, height);
    // The HUD places the combo and judgment just above the hit line.
    hudRoot.style.setProperty('--hit-line-y', `${(scene.hitLineY() * 100).toFixed(2)}%`);
  });
  // Every GPU resource died with the old context; rebuild before the loop restarts.
  lifecycle.on('contextrestored', () => {
    scene.rebuild();
  });

  if (audio) {
    session = startGame(stage, hudRoot, hud, reload, audio, scene);
  }

  watchViewport({
    measure: () => {
      const { width, height } = stage.getBoundingClientRect();
      return { width, height };
    },
    onChange: (size) => {
      lifecycle.emit('resize', size);
    },
  });

  const playHud = session ? createPlayHud(hudRoot, session) : undefined;
  if (session) {
    session.events.on('judgment', (event) => {
      scene.onJudgment(event);
      playHud?.onJudgment(event);
    });
  }
  host.setFrame((delta, renderer) => {
    if (session) {
      session.update();
      scene.render(session.view(), delta, renderer);
    } else {
      scene.render(NO_GAME, delta, renderer);
    }
    playHud?.update();
  });

  if (isDebugEnabled(window.location.search)) {
    const hook = installDebugHook(window, host, lifecycle, () => scene.builds);
    const sections: HTMLElement[] = [];
    hook.session = session;
    if (audio) {
      hook.audio = audio;
      const calibrate = () => {
        openCalibration({
          root: hudRoot,
          engine: audio.engine,
          onSaved: ({ audioOffsetMs, inputOffsetMs }, persisted) => {
            hud.showNotice(
              persisted
                ? `Timing saved: sound ${audioOffsetMs} ms, touch ${inputOffsetMs} ms.`
                : "Timing applied, but this device wouldn't save it. It resets when PlatyJam closes.",
            );
          },
        });
      };
      sections.push(createAudioDebugSection({ audio, openCalibration: calibrate }));
    }
    hud.showDebugPanel(hook, sections);
  }
}

main();
