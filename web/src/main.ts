import './style.css';
import { installDebugHook, isDebugEnabled } from './app/debug';
import { installPageLifecycle, lifecycle } from './app/lifecycle';
import { setupServiceWorker } from './app/pwa';
import { setupStoragePersistence } from './app/storage';
import { installTouchGuards } from './app/touch-guards';
import { watchViewport } from './app/viewport';
import { createGameAudio, type GameAudio } from './audio/game-audio';
import { openCalibration } from './calibration/calibration-overlay';
import { createAudioDebugSection } from './hud/audio-debug';
import { createHud, type Hud } from './hud/hud';
import { createResumeOverlay } from './hud/resume-overlay';
import { createRendererHost, type RendererHost } from './render/renderer-host';
import { createPlaceholderScene } from './scene/placeholder-scene';

function required(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`index.html is missing ${selector}`);
  return node;
}

/**
 * Sound: unlock on the first gesture, the "Tap to resume" overlay, and the piano,
 * which starts loading now. Returns undefined where Web Audio is missing.
 */
function startAudio(hudRoot: HTMLElement, hud: Hud, reload: () => void): GameAudio | undefined {
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
    overlay.show('paused');
  });
  engine.events.on('needsgesture', () => {
    overlay.show('retry');
  });
  engine.events.on('resumed', () => {
    overlay.hide();
  });

  void audio.samples.ready.then(({ failed, buffers }) => {
    if (failed.length === 0) return;
    const message =
      buffers.size === 0
        ? "The piano sounds didn't download. Connect to the internet, then reload."
        : `${failed.length} piano notes didn't download. Reload when you're online to get them.`;
    hud.showProblem(message, 'Reload', reload);
  });
  return audio;
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
  const audio = startAudio(hudRoot, hud, reload);
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

  const scene = createPlaceholderScene();
  lifecycle.on('resize', ({ width, height }) => {
    scene.resize(width, height);
  });
  // Every GPU resource died with the old context; rebuild before the loop restarts.
  lifecycle.on('contextrestored', () => {
    scene.rebuild();
  });

  watchViewport({
    measure: () => {
      const { width, height } = stage.getBoundingClientRect();
      return { width, height };
    },
    onChange: (size) => {
      lifecycle.emit('resize', size);
    },
  });

  host.setFrame((delta, renderer) => {
    scene.render(delta, renderer);
  });

  if (isDebugEnabled(window.location.search)) {
    const hook = installDebugHook(window, host, lifecycle, () => scene.builds);
    const sections: HTMLElement[] = [];
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
