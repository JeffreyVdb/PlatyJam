import type { FailMode, GameMode } from '../game/session-contract';
import { rhythmIcon, tilesIcon } from '../hud/icons';
import { el } from './controls';

/**
 * What the menus say and show about each game: its name, icon, one line, the How to
 * play steps and the fail-mode hints, plus the badge and the looping preview. The
 * accent colours are tokens in style.css (`--rhythm`, `--tiles`).
 */
export interface GameInfo {
  name: string;
  icon: () => SVGSVGElement;
  /** What the game is, in one line. */
  line: string;
  /** How to play, three steps. */
  steps: readonly [string, string, string];
  failHints: Record<FailMode, string>;
}

export const GAMES: Record<GameMode, GameInfo> = {
  rhythm: {
    name: 'Rhythm',
    icon: rhythmIcon,
    line: 'Hit each tile on the line, in time with the music.',
    steps: [
      'Tap each tile just as it reaches the glowing line.',
      'Hold long tiles until they end.',
      'The closer to the line, the more points you get.',
    ],
    failHints: {
      classic: 'The first missed note ends the song.',
      relaxed: 'A miss breaks your combo, and the song plays on.',
    },
  },
  tiles: {
    name: 'Tiles',
    icon: tilesIcon,
    line: "Tap every tile before it falls off the screen. Timing doesn't matter.",
    steps: [
      'Tap any black tile, anywhere on it.',
      'Hold long tiles until they fill up.',
      "Don't let a tile fall off, and don't tap the water.",
    ],
    failHints: {
      classic: 'A tile that falls off, or a tap on empty space, ends the song.',
      relaxed: 'A tile that falls off breaks your combo, and the song plays on.',
    },
  },
};

/** The game's icon and name in its accent colour. */
export function gameBadge(mode: GameMode): HTMLElement {
  const badge = el('span', 'mode-badge');
  badge.dataset.mode = mode;
  badge.append(GAMES[mode].icon(), el('span', 'mode-badge-name', GAMES[mode].name));
  return badge;
}

// ---- Previews ----

/**
 * The tiles each preview drops, one loop each, staggered by `delay` (a fraction of
 * the loop). `kind` picks the keyframes: where the tile is hit, or that it is held.
 */
const DROPS: Record<GameMode, readonly { lane: number; delay: number; kind: string }[]> = {
  rhythm: [
    { lane: 1, delay: 0, kind: 'tap' },
    { lane: 3, delay: 0.25, kind: 'tap' },
    { lane: 0, delay: 0.5, kind: 'tap' },
    { lane: 2, delay: 0.75, kind: 'tap' },
  ],
  tiles: [
    { lane: 0, delay: 0, kind: 'high' },
    { lane: 2, delay: 0.2, kind: 'low' },
    { lane: 3, delay: 0.45, kind: 'hold' },
    { lane: 1, delay: 0.6, kind: 'high' },
    { lane: 0, delay: 0.8, kind: 'low' },
  ],
};

let observer: IntersectionObserver | undefined;

/** Previews off screen stand still (`is-offscreen`); so does every one in a hidden page. */
function pauseWhenUnseen(node: HTMLElement) {
  if (typeof IntersectionObserver === 'undefined') return;
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries)
      entry.target.classList.toggle('is-offscreen', !entry.isIntersecting);
  });
  observer.observe(node);
}

let watchingVisibility = false;
function pauseWhenHidden() {
  if (watchingVisibility) return;
  watchingVisibility = true;
  document.addEventListener('visibilitychange', () => {
    document.documentElement.classList.toggle('is-page-hidden', document.hidden);
  });
}

/**
 * A small looping picture of the game being played: four lanes, falling tiles and a
 * finger. CSS only (transform and opacity), paused off screen, and a still frame
 * under reduced motion. Decorative: the words next to it say the same.
 */
export function gamePreview(mode: GameMode): HTMLElement {
  const preview = el('div', `preview preview--${mode}`);
  preview.setAttribute('aria-hidden', 'true');
  for (let lane = 0; lane < 4; lane += 1) preview.append(el('span', 'preview-lane'));
  if (mode === 'rhythm') preview.append(el('span', 'preview-line'));
  for (const { lane, delay, kind } of DROPS[mode]) {
    const drop = el('span', `preview-drop preview-drop--${kind}`);
    drop.style.setProperty('--lane', String(lane));
    drop.style.setProperty('--delay', String(delay));
    const tile = el('span', 'preview-tile');
    if (kind === 'hold') tile.append(el('span', 'preview-fill'));
    drop.append(tile, el('span', 'preview-finger'));
    if (mode === 'rhythm') drop.append(el('span', 'preview-flash'));
    preview.append(drop);
  }
  pauseWhenUnseen(preview);
  pauseWhenHidden();
  return preview;
}
