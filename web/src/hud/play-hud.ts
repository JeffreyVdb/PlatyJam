import { judgmentName, STAR_THRESHOLDS } from '../game/scoring';
import type { GameSession, JudgmentEvent, SessionState } from '../game/session-contract';
import { starIcon } from './icons';
import { prefersReducedMotion } from './motion';

/**
 * The HUD during a run: score, song progress with its star marks, the combo, the
 * judgment of each hit, and the pause button. Values are written only when they
 * change, so a frame costs a few comparisons.
 *
 * It lays itself out for the game (`data-game`, style.css): Rhythm's keeps to the
 * corner and the hit line; Tiles' runs the progress along the very top, with a big
 * score centred under it and the judgment and combo below, over the lanes. Only the
 * pause button takes touches: tiles under the rest can be tapped.
 */
export interface PlayHud {
  /** Call every frame. */
  update(): void;
  onJudgment(event: Readonly<JudgmentEvent>): void;
  dispose(): void;
}

/** Combos below this are not worth showing. */
const COMBO_SHOWN_FROM = 3;
const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pauseIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('pause-icon');
  for (const x of [6.5, 13.5]) {
    const bar = document.createElementNS(SVG_NS, 'rect');
    bar.setAttribute('x', String(x));
    bar.setAttribute('y', '5');
    bar.setAttribute('width', '4');
    bar.setAttribute('height', '14');
    bar.setAttribute('rx', '1.6');
    svg.append(bar);
  }
  return svg;
}

const PLAYING_STATES: readonly SessionState[] = [
  'leadIn',
  'playing',
  'paused',
  'countdown',
  'failing',
];

export function createPlayHud(root: HTMLElement, session: GameSession): PlayHud {
  const hud = el('div', 'play-hud');
  hud.hidden = true;

  const meter = el('div', 'play-meter');
  const score = el('p', 'play-score', '0');
  score.setAttribute('aria-label', 'Score');
  const track = el('div', 'play-progress');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', 'Song progress');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  const fill = el('span', 'play-progress-fill');
  track.append(fill);
  const stars = STAR_THRESHOLDS.map((threshold) => {
    const mark = el('span', 'play-star');
    mark.style.setProperty('--at', String(threshold));
    mark.append(starIcon());
    track.append(mark);
    return mark;
  });
  meter.append(score, track);

  const pause = el('button', 'pause-button');
  pause.type = 'button';
  pause.setAttribute('aria-label', 'Pause');
  pause.append(pauseIcon());
  pause.addEventListener('click', () => {
    session.pause('player');
  });

  const centre = el('div', 'play-centre');
  const combo = el('p', 'play-combo');
  const judgment = el('p', 'play-judgment');
  judgment.setAttribute('aria-live', 'off');
  centre.append(combo, judgment);

  hud.append(meter, pause, centre);
  root.append(hud);

  let shownScore = -1;
  let shownCombo = -1;
  let shownProgress = -1;
  let shownStars = -1;

  const onState = ({ state }: { state: SessionState }) => {
    hud.dataset.game = session.config?.mode ?? 'rhythm';
    const visible = PLAYING_STATES.includes(state) || state === 'finished';
    hud.hidden = !visible;
    root.classList.toggle('is-playing', visible);
    // Only the run itself can be paused; the button would mislead elsewhere.
    pause.hidden = state !== 'leadIn' && state !== 'playing';
    // The pause screen and the countdown numeral take the centre.
    centre.hidden = state === 'paused' || state === 'countdown';
    if (state === 'leadIn') {
      judgment.textContent = '';
      combo.textContent = '';
    }
  };
  const offState = session.events.on('statechange', onState);
  onState({ state: session.state });

  return {
    update() {
      if (hud.hidden) return;
      const stats = session.stats();
      if (stats.score !== shownScore) {
        shownScore = stats.score;
        score.textContent = stats.score.toLocaleString('en');
      }
      if (stats.combo !== shownCombo) {
        shownCombo = stats.combo;
        combo.textContent = stats.combo >= COMBO_SHOWN_FROM ? `${stats.combo} combo` : '';
      }
      const percent = Math.round(stats.progress * 1000) / 10;
      if (percent !== shownProgress) {
        shownProgress = percent;
        fill.style.transform = `scaleX(${stats.progress})`;
        track.setAttribute('aria-valuenow', String(Math.round(percent)));
      }
      if (stats.stars !== shownStars) {
        shownStars = stats.stars;
        stars.forEach((mark, index) => {
          mark.classList.toggle('is-earned', stats.stars > index);
        });
      }
    },

    onJudgment(event) {
      if (event.unit === 'tail' && event.judgment !== 'miss') return;
      judgment.textContent = judgmentName(session.config?.mode ?? 'rhythm', event.judgment);
      judgment.dataset.judgment = event.judgment;
      // Restart the pop on every hit, even the same word twice.
      judgment.getAnimations().forEach((animation) => {
        animation.cancel();
      });
      const still = prefersReducedMotion();
      judgment.animate(
        still
          ? [{ opacity: 1 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }]
          : [
              { opacity: 1, transform: 'translateY(4px) scale(0.86)' },
              { opacity: 1, transform: 'translateY(0) scale(1.06)', offset: 0.18 },
              { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.32 },
              { opacity: 0, transform: 'translateY(-6px) scale(1)' },
            ],
        { duration: 620, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' },
      );
    },

    dispose() {
      offState();
      hud.remove();
    },
  };
}
