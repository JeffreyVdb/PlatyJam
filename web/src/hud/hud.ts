import type { DebugHook } from '../app/debug';

/**
 * The HTML layer over the stage: brand, notices and the debug panel. It sits outside
 * the play surface, so its buttons receive ordinary taps (the touch guards only
 * cancel touches that start on the stage).
 */
export interface Hud {
  /** Shows a lasting "update ready" notice; `apply` runs when the player taps it. */
  showUpdate(apply: () => void): void;
  /** Shows a short notice that dismisses itself. */
  showNotice(message: string, durationMs?: number): void;
  /** Shows a notice that stays, with one recovery action. */
  showProblem(message: string, actionLabel: string, action: () => void): void;
  /** `sections` are appended below the render controls (the Audio tools). */
  showDebugPanel(hook: DebugHook, sections?: readonly HTMLElement[]): void;
}

const NOTICE_MS = 5000;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, variant: 'primary' | 'quiet', onTap: () => void) {
  const node = element('button', `hud-button hud-button--${variant}`, label);
  node.type = 'button';
  node.addEventListener('click', onTap);
  return node;
}

export function createHud(root: HTMLElement): Hud {
  const notices = root.querySelector<HTMLElement>('[data-hud="notices"]');
  if (!notices) throw new Error('HUD markup is missing [data-hud="notices"]');

  let update: HTMLElement | undefined;
  let problem: HTMLElement | undefined;

  const dismiss = (node: HTMLElement) => {
    node.classList.add('is-leaving');
    const remove = () => {
      node.remove();
    };
    node.addEventListener('animationend', remove, { once: true });
    // Fallback when animations are off (reduced motion) and never fire.
    setTimeout(remove, 400);
  };

  return {
    showUpdate(apply) {
      if (update?.isConnected) return;
      update = element('div', 'notice');
      const text = element('p', 'notice-text', 'A new version of PlatyJam is ready.');
      const action = button('Update now', 'primary', () => {
        action.disabled = true;
        action.textContent = 'Updating…';
        apply();
      });
      update.append(text, action);
      notices.append(update);
    },

    showNotice(message, durationMs = NOTICE_MS) {
      const node = element('div', 'notice notice--brief');
      node.append(element('p', 'notice-text', message));
      notices.append(node);
      setTimeout(() => {
        dismiss(node);
      }, durationMs);
    },

    showProblem(message, actionLabel, action) {
      problem?.remove();
      problem = element('div', 'notice notice--problem');
      problem.setAttribute('role', 'alert');
      problem.append(element('p', 'notice-text', message), button(actionLabel, 'primary', action));
      notices.append(problem);
    },

    showDebugPanel(hook, sections = []) {
      const panel = element('section', 'debug-panel');
      panel.setAttribute('aria-label', 'Debug tools');
      const status = element('p', 'debug-status');
      status.setAttribute('aria-live', 'off');
      const actions = element('div', 'debug-actions');
      actions.append(
        button('Lose context', 'quiet', () => {
          hook.loseContext();
        }),
        button('Restore context', 'quiet', () => {
          hook.restoreContext();
        }),
      );
      panel.append(status, actions, ...sections);
      root.append(panel);

      // Frames per second over the last refresh, for checking performance on a device.
      let lastFrames = hook.state().frames;
      let lastTime = performance.now();
      const refresh = () => {
        const s = hook.state();
        const now = performance.now();
        const fps = ((s.frames - lastFrames) * 1000) / Math.max(1, now - lastTime);
        lastFrames = s.frames;
        lastTime = now;
        const mode = s.contextLost ? 'Context lost' : s.running ? 'Rendering' : 'Paused';
        status.textContent = `${mode}, ${fps.toFixed(0)} fps, ${s.frames} frames, scene built ${s.sceneBuilds}×, renderer replaced ${s.recreations}×`;
      };
      refresh();
      setInterval(refresh, 250);
    },
  };
}
