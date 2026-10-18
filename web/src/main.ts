import './style.css';
import { installDebugHook, isDebugEnabled } from './app/debug';
import { installPageLifecycle, lifecycle } from './app/lifecycle';
import { setupServiceWorker } from './app/pwa';
import { setupStoragePersistence } from './app/storage';
import { installTouchGuards } from './app/touch-guards';
import { watchViewport } from './app/viewport';
import { createHud } from './hud/hud';
import { createRendererHost, type RendererHost } from './render/renderer-host';
import { createPlaceholderScene } from './scene/placeholder-scene';

function required(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`index.html is missing ${selector}`);
  return node;
}

function main() {
  const stage = required('#stage');
  const hud = createHud(required('#hud'));
  const reload = () => {
    window.location.reload();
  };

  installTouchGuards(stage);
  installPageLifecycle(lifecycle);
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
    hud.showDebugPanel(installDebugHook(window, host, lifecycle, () => scene.builds));
  }
}

main();
