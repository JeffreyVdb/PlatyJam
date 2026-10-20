import { MODE_JUDGMENTS } from '../game/scoring';
import type {
  FinalResults,
  GameMode,
  GameSession,
  PauseInfo,
  SessionConfig,
} from '../game/session-contract';
import { starIcon } from '../hud/icons';
import { prefersReducedMotion } from '../hud/motion';
import type { RecordedResults } from '../save/save-store';
import { el, gestureButton, uid, visuallyHidden } from './controls';
import { formatTempo } from './flow';
import { gameBadge } from './games';
import type { Screen } from './screens';
import { DIFFICULTY_NAMES } from './song-select';

/**
 * The screens during a run: pause, the 3-2-1 countdown and the results. They drive
 * the session only through the `GameSession` commands.
 */

/** A live region filled this long after it appears is announced reliably. */
const ANNOUNCE_DELAY_MS = 150;

const LANE_NAMES = ['far left', 'left', 'right', 'far right'] as const;

const PAUSE_HINTS: Record<PauseInfo['reason'], string> = {
  player: 'Take a breath. The song waits where you left it.',
  interrupted: 'PlatyJam was in the background. The song waits where you left it.',
  inputcancel: 'A touch was interrupted, so the song stopped. Nothing was counted against you.',
  blur: 'PlatyJam lost the keyboard, so the song stopped. Nothing was counted against you.',
};

export function settingsLine({
  difficulty,
  tempo,
  failMode,
}: Pick<SessionConfig, 'difficulty' | 'tempo' | 'failMode'>): string {
  const speed = tempo === 1 ? 'normal speed' : `${formatTempo(tempo)} speed`;
  const mode = failMode === 'classic' ? 'Classic' : 'Relaxed';
  return `${DIFFICULTY_NAMES[difficulty]}, ${speed}, ${mode}`;
}

function laneList(lanes: readonly number[]): string {
  const names = lanes.map((lane) => LANE_NAMES[lane] ?? `lane ${lane + 1}`);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

const lanesWord = (lanes: readonly number[]) => (lanes.length > 1 ? 'lanes' : 'lane');

/** The line under a sheet's title that names the game being played. */
function gameLine(): { node: HTMLElement; show(mode: GameMode): void } {
  const node = el('p', 'game-card-mode');
  return {
    node,
    show(mode) {
      const current = node.firstElementChild;
      if (current instanceof HTMLElement && current.dataset.mode === mode) return;
      node.replaceChildren(gameBadge(mode));
    },
  };
}

export function sheet(className: string): {
  node: HTMLElement;
  card: HTMLElement;
  title: HTMLElement;
} {
  const node = el('section', `game-sheet ${className}`.trim());
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-modal', 'true');
  const card = el('div', 'game-card');
  const title = el('h2', 'game-card-title');
  title.id = uid('sheet');
  node.setAttribute('aria-labelledby', title.id);
  card.append(title);
  node.append(card);
  return { node, card, title };
}

// ---- Pause ----

export interface PauseScreen extends Screen {
  refresh(): void;
}

/** Resume (through the audio recovery when needed), Restart and Quit. */
export function createPauseScreen(session: GameSession, onQuit: () => void): PauseScreen {
  const { node, card, title } = sheet('');
  title.textContent = 'Paused';
  const game = gameLine();
  const hint = el('p', 'game-card-text');
  const alert = el('p', 'game-card-alert');
  alert.setAttribute('role', 'status');
  const resume = gestureButton('Resume', 'primary', () => {
    session.resume();
  });
  const actions = el('div', 'game-card-actions');
  actions.append(
    resume,
    gestureButton('Restart', 'quiet', () => {
      session.restart();
    }),
    gestureButton('Quit', 'quiet', onQuit),
  );
  card.append(game.node, hint, alert, actions);

  return {
    node,
    focusTarget: () => resume,
    refresh() {
      const info = session.pauseInfo;
      if (!info) return;
      game.show(session.config?.mode ?? 'rhythm');
      hint.textContent = PAUSE_HINTS[info.reason];
      const lanes = info.heldLanes.length
        ? `Then hold the ${laneList(info.heldLanes)} ${lanesWord(info.heldLanes)} again during the count.`
        : '';
      alert.textContent =
        info.audio === 'needsGesture'
          ? "The sound didn't come back. Tap Resume once more to restart it."
          : info.audio === 'recovering'
            ? 'Bringing the sound back…'
            : lanes;
      alert.hidden = alert.textContent === '';
      resume.disabled = info.audio === 'recovering';
    },
  };
}

// ---- Countdown ----

export interface CountdownScreen extends Screen {
  refresh(): void;
}

/** 3-2-1 over the lanes. It takes no pointer events: held lanes are reclaimed through it. */
export function createCountdownScreen(session: GameSession): CountdownScreen {
  const node = el('div', 'countdown');
  node.setAttribute('aria-live', 'assertive');
  const beat = el('p', 'countdown-beat');
  const hint = el('p', 'countdown-hint');
  node.append(beat, hint);

  return {
    node,
    focusTarget: () => node,
    refresh() {
      const info = session.countdown;
      if (!info) return;
      const text = String(info.beat);
      const newBeat = beat.textContent !== text || !node.isConnected;
      beat.textContent = text;
      hint.textContent = info.heldLanes.length
        ? `Hold the ${laneList(info.heldLanes)} ${lanesWord(info.heldLanes)} to keep your notes.`
        : '';
      // Reclaiming a lane updates the hint only; the beat pops once per number.
      if (!newBeat || prefersReducedMotion()) return;
      beat.getAnimations().forEach((animation) => {
        animation.cancel();
      });
      beat.animate(
        [
          { opacity: 0, transform: 'scale(1.35)' },
          { opacity: 1, transform: 'scale(1)', offset: 0.25 },
          { opacity: 1, transform: 'scale(0.96)' },
        ],
        { duration: 900, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' },
      );
    },
  };
}

// ---- Results ----

export interface ResultsScreen extends Screen {
  show(results: FinalResults, recorded: RecordedResults | undefined): void;
}

function resultHeading(results: FinalResults): string {
  if (results.outcome === 'cleared') return results.perfectBadge ? 'Perfect run' : 'Song cleared';
  const empty = results.failure?.kind === 'emptyTap';
  if (results.mode === 'tiles') return empty ? 'That was the water' : 'A tile got away';
  return empty ? 'That lane was empty' : 'A note got away';
}

/** Cleared or failed, score, stars, the counts, "New best!", then Retry or Song list. */
export function createResultsScreen({
  onRetry,
  onSongList,
}: {
  onRetry: () => void;
  onSongList: () => void;
}): ResultsScreen {
  const { node, card, title } = sheet('game-sheet--results');
  card.classList.add('game-card--results');
  const game = gameLine();
  const song = el('p', 'game-card-text');
  const stars = el('div', 'result-stars');
  stars.setAttribute('role', 'img');
  const scoreLine = el('div', 'result-score-line');
  const score = el('p', 'result-score');
  const badge = el('p', 'result-badge');
  scoreLine.append(score, badge);
  const stats = el('dl', 'result-stats');
  const summary = visuallyHidden('p');
  summary.setAttribute('role', 'status');
  const retry = gestureButton('Retry', 'primary', onRetry);
  const actions = el('div', 'game-card-actions');
  actions.append(retry, gestureButton('Song list', 'quiet', onSongList));
  card.append(game.node, song, stars, scoreLine, stats, actions, summary);

  return {
    node,
    focusTarget: () => retry,
    show(results, recorded) {
      const heading = resultHeading(results);
      title.textContent = heading;
      game.show(results.mode);
      song.textContent = `${results.songTitle}. ${settingsLine(results)}.`;
      stars.setAttribute('aria-label', `${results.stars} of 3 stars`);
      stars.replaceChildren(
        ...[0, 1, 2].map((i) => {
          const star = el('span', 'result-star');
          star.classList.toggle('is-earned', results.stars > i);
          star.style.setProperty('--i', String(i));
          star.append(starIcon());
          return star;
        }),
      );
      const scoreText = results.score.toLocaleString('en');
      score.textContent = scoreText;
      const newBest = recorded?.newBest === true;
      const previous = recorded?.previous;
      badge.classList.toggle('is-new', newBest);
      badge.textContent = newBest
        ? 'New best!'
        : previous
          ? `Best ${previous.score.toLocaleString('en')}`
          : '';
      badge.hidden = badge.textContent === '';
      const rows: [string, string][] = [
        ['Accuracy', `${results.accuracy.toFixed(1)}%`],
        ['Max combo', String(results.maxCombo)],
        // The game's own judgments: Perfect, Good and Miss, or Cleared and Missed.
        ...MODE_JUDGMENTS[results.mode].map(({ judgment, name }): [string, string] => [
          name,
          String(results[judgment] ?? 0),
        ]),
      ];
      stats.replaceChildren(
        ...rows.map(([label, value]) => {
          const row = el('div', 'result-row');
          row.append(el('dt', 'result-label', label), el('dd', 'result-value', value));
          return row;
        }),
      );
      // Filled once the sheet is on screen, so the live region announces it.
      summary.textContent = '';
      const text = `${heading}. ${results.stars} of 3 stars, score ${scoreText}.${newBest ? ' New best!' : ''}`;
      setTimeout(() => {
        summary.textContent = text;
      }, ANNOUNCE_DELAY_MS);
    },
  };
}
