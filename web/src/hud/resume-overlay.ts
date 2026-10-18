/**
 * "Tap to resume": covers the screen while the audio engine is interrupted. The
 * whole overlay is one button, so any tap is the gesture the engine needs.
 *
 * A small stand-in: PLA-7 replaces it with the 3-2-1 countdown pause screen.
 */
export interface ResumeOverlay {
  /** `retry`: the first tap did not bring the sound back; one more tap recreates it. */
  show(kind: 'paused' | 'retry'): void;
  hide(): void;
  readonly visible: boolean;
}

const COPY = {
  paused: { title: 'Paused', hint: 'Tap anywhere to keep playing.' },
  retry: { title: "The sound didn't come back", hint: 'Tap once more to restart it.' },
} as const;

const SVG_NS = 'http://www.w3.org/2000/svg';

function playIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('resume-icon');
  const path = document.createElementNS(SVG_NS, 'path');
  // A rounded triangle, nudged right so it sits optically centred in the disc.
  path.setAttribute(
    'd',
    'M18 12.6c0-1.6 1.7-2.5 3-1.7l16.2 10.4c1.2.8 1.2 2.6 0 3.4L21 35.1c-1.3.8-3-.1-3-1.7z',
  );
  svg.append(path);
  return svg;
}

export function createResumeOverlay(root: HTMLElement, onTap: () => void): ResumeOverlay {
  const overlay = document.createElement('button');
  overlay.type = 'button';
  overlay.className = 'resume-overlay';
  const disc = document.createElement('span');
  disc.className = 'resume-disc';
  disc.append(playIcon());
  const title = document.createElement('span');
  title.className = 'resume-title';
  const hint = document.createElement('span');
  hint.className = 'resume-hint';
  overlay.append(disc, title, hint);

  // pointerup is the touch gesture WebKit honours; click covers mouse and keyboard.
  // The engine ignores the second call while the first is still resuming.
  overlay.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'mouse') onTap();
  });
  overlay.addEventListener('click', onTap);

  return {
    show(kind) {
      title.textContent = COPY[kind].title;
      hint.textContent = COPY[kind].hint;
      overlay.dataset.kind = kind;
      if (!overlay.isConnected) root.append(overlay);
      overlay.focus({ preventScroll: true });
    },
    hide() {
      overlay.remove();
    },
    get visible() {
      return overlay.isConnected;
    },
  };
}
