import type {
  FinalResults,
  GameSession,
  PauseInfo,
  SessionConfig,
  SessionState,
} from '../game/session-contract';
import { starIcon } from './icons';
import { prefersReducedMotion } from './motion';

/**
 * A small stand-in for PLA-7's screens, like the "Tap to resume" overlay: the Start
 * tile, the pause menu, the 3-2-1 countdown and the results. It drives the session
 * only through the `GameSession` commands and reads only its outputs, so PLA-7 can
 * replace this file without touching gameplay.
 */
export interface InterimScreens {
  dispose(): void;
}

const DIFFICULTY_NAMES = { easy: 'Easy', normal: 'Normal', hard: 'Hard' } as const;
const LANE_NAMES = ['far left', 'left', 'right', 'far right'] as const;

const PAUSE_HINTS: Record<PauseInfo['reason'], string> = {
  player: 'Take a breath. The song waits where you left it.',
  interrupted: 'PlatyJam was in the background. The song waits where you left it.',
  inputcancel: 'A touch was interrupted, so the song stopped. Nothing was counted against you.',
  blur: 'PlatyJam lost the keyboard, so the song stopped. Nothing was counted against you.',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A touch `pointerup` is followed by a synthesized `click` within this many ms. */
const CLICK_AFTER_TOUCH_MS = 800;

/**
 * A button for a command that may need to start audio. `pointerup` is the touch
 * gesture WebKit honours; `click` covers mouse and keyboard. The `click` a touch
 * synthesizes afterwards is swallowed, so a command such as Restart runs once.
 */
function gestureButton(label: string, variant: 'primary' | 'quiet', onTap: () => void) {
  const node = el('button', `hud-button hud-button--${variant}`, label);
  node.type = 'button';
  let touchedAt = -Infinity;
  node.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse') return;
    touchedAt = event.timeStamp;
    onTap();
  });
  node.addEventListener('click', (event) => {
    if (event.timeStamp - touchedAt < CLICK_AFTER_TOUCH_MS) return;
    onTap();
  });
  return node;
}

function settingsLine({
  difficulty,
  tempo,
  failMode,
}: Pick<SessionConfig, 'difficulty' | 'tempo' | 'failMode'>): string {
  const speed = tempo === 1 ? 'normal speed' : `${tempo}× speed`;
  const mode = failMode === 'classic' ? 'Classic' : 'Relaxed';
  return `${DIFFICULTY_NAMES[difficulty]}, ${speed}, ${mode}`;
}

function laneList(lanes: readonly number[]): string {
  const names = lanes.map((lane) => LANE_NAMES[lane] ?? `lane ${lane + 1}`);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

function resultHeading(results: FinalResults): string {
  if (results.outcome === 'cleared') return results.perfectBadge ? 'Perfect run' : 'Song cleared';
  return results.failure?.kind === 'emptyTap' ? 'That lane was empty' : 'A note got away';
}

/** `reload` reloads the page: the way out of the `error` state. */
export function createInterimScreens(
  root: HTMLElement,
  session: GameSession,
  reload: () => void,
): InterimScreens {
  // ---- Start tile ----
  const start = el('section', 'start-panel');
  start.setAttribute('aria-label', 'Start');
  const title = el('h1', 'start-title');
  const composer = el('p', 'start-composer');
  const settings = el('p', 'start-settings');
  const startTile = gestureButton('Play', 'primary', () => {
    if (session.state === 'error') reload();
    else session.start();
  });
  startTile.className = 'start-tile';
  const startNote = el('p', 'start-note');
  start.append(title, composer, settings, startTile, startNote);

  // ---- Pause menu ----
  const pauseMenu = el('section', 'game-sheet');
  pauseMenu.setAttribute('role', 'dialog');
  pauseMenu.setAttribute('aria-modal', 'true');
  pauseMenu.setAttribute('aria-labelledby', 'pause-title');
  const pauseCard = el('div', 'game-card');
  const pauseTitle = el('h2', 'game-card-title', 'Paused');
  pauseTitle.id = 'pause-title';
  const pauseHint = el('p', 'game-card-text');
  const pauseAudio = el('p', 'game-card-alert');
  pauseAudio.setAttribute('role', 'status');
  const resume = gestureButton('Resume', 'primary', () => {
    session.resume();
  });
  const pauseActions = el('div', 'game-card-actions');
  pauseActions.append(
    resume,
    gestureButton('Restart', 'quiet', () => {
      session.restart();
    }),
    gestureButton('Quit', 'quiet', () => {
      session.quit();
    }),
  );
  pauseCard.append(pauseTitle, pauseHint, pauseAudio, pauseActions);
  pauseMenu.append(pauseCard);

  // ---- Countdown: lets every touch through to the lanes ----
  const countdown = el('div', 'countdown');
  countdown.setAttribute('aria-live', 'assertive');
  const countdownBeat = el('p', 'countdown-beat');
  const countdownHint = el('p', 'countdown-hint');
  countdown.append(countdownBeat, countdownHint);

  // ---- Results ----
  const resultsSheet = el('section', 'game-sheet game-sheet--results');
  resultsSheet.setAttribute('role', 'dialog');
  resultsSheet.setAttribute('aria-modal', 'true');
  resultsSheet.setAttribute('aria-labelledby', 'results-title');

  const views = [start, pauseMenu, countdown, resultsSheet];
  const show = (node: HTMLElement | undefined) => {
    for (const view of views) if (view !== node) view.remove();
    if (node && !node.isConnected) root.append(node);
  };

  const renderStart = () => {
    const config = session.config;
    const state = session.state;
    title.textContent = config?.chart.title ?? 'PlatyJam';
    composer.textContent = config ? config.chart.composer : '';
    settings.textContent = config ? settingsLine(config) : '';
    if (state === 'loading') {
      const { chartLoaded, samples } = session.loading;
      startTile.disabled = true;
      startTile.textContent = 'Loading';
      startNote.textContent = chartLoaded
        ? `Tuning the piano: ${samples.loaded + samples.failed} of ${samples.total} notes`
        : 'Fetching the song';
    } else if (state === 'error') {
      startTile.disabled = false;
      startTile.textContent = 'Reload';
      startNote.textContent = session.error ?? "This song didn't load.";
    } else if (state === 'starting') {
      startTile.disabled = true;
      startTile.textContent = 'Starting';
      startNote.textContent = '';
    } else {
      startTile.disabled = false;
      startTile.textContent = 'Play';
      startNote.textContent = 'Tap the tiles as they reach the line. Keys: D F J K.';
    }
  };

  const renderPause = () => {
    const info = session.pauseInfo;
    if (!info) return;
    pauseHint.textContent = PAUSE_HINTS[info.reason];
    const lanes = info.heldLanes.length
      ? ` Then hold the ${laneList(info.heldLanes)} ${info.heldLanes.length > 1 ? 'lanes' : 'lane'} again during the count.`
      : '';
    pauseAudio.textContent =
      info.audio === 'needsGesture'
        ? "The sound didn't come back. Tap Resume once more to restart it."
        : info.audio === 'recovering'
          ? 'Bringing the sound back…'
          : lanes.trim();
    pauseAudio.hidden = pauseAudio.textContent === '';
    resume.disabled = info.audio === 'recovering';
  };

  const renderCountdown = () => {
    const info = session.countdown;
    if (!info) return;
    const beat = String(info.beat);
    const newBeat = countdownBeat.textContent !== beat || !countdown.isConnected;
    countdownBeat.textContent = beat;
    countdownHint.textContent = info.heldLanes.length
      ? `Hold the ${laneList(info.heldLanes)} ${info.heldLanes.length > 1 ? 'lanes' : 'lane'} to keep your notes.`
      : '';
    // Reclaiming a lane updates the hint only; the beat pops once per number.
    if (!newBeat || prefersReducedMotion()) return;
    countdownBeat.getAnimations().forEach((animation) => {
      animation.cancel();
    });
    countdownBeat.animate(
      [
        { opacity: 0, transform: 'scale(1.35)' },
        { opacity: 1, transform: 'scale(1)', offset: 0.25 },
        { opacity: 1, transform: 'scale(0.96)' },
      ],
      { duration: 900, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' },
    );
  };

  const renderResults = (results: FinalResults) => {
    const card = el('div', 'game-card game-card--results');
    const heading = el('h2', 'game-card-title', resultHeading(results));
    heading.id = 'results-title';
    const song = el('p', 'game-card-text', `${results.songTitle}. ${settingsLine(results)}.`);
    const starRow = el('div', 'result-stars');
    starRow.setAttribute('aria-label', `${results.stars} of 3 stars`);
    for (let i = 0; i < 3; i += 1) {
      const star = el('span', 'result-star');
      star.classList.toggle('is-earned', results.stars > i);
      star.append(starIcon());
      starRow.append(star);
    }
    const score = el('p', 'result-score', results.score.toLocaleString('en'));
    const stats = el('dl', 'result-stats');
    const rows: [string, string][] = [
      ['Accuracy', `${results.accuracy.toFixed(1)}%`],
      ['Best combo', String(results.maxCombo)],
      ['Perfect', String(results.perfect)],
      ['Good', String(results.good)],
      ['Miss', String(results.miss)],
    ];
    for (const [label, value] of rows) {
      const row = el('div', 'result-row');
      row.append(el('dt', 'result-label', label), el('dd', 'result-value', value));
      stats.append(row);
    }
    const actions = el('div', 'game-card-actions');
    const again = gestureButton('Play again', 'primary', () => {
      session.restart();
    });
    actions.append(
      again,
      gestureButton('Quit', 'quiet', () => {
        session.quit();
      }),
    );
    card.append(heading, song, starRow, score, stats, actions);
    resultsSheet.replaceChildren(card);
    return again;
  };

  const render = (state: SessionState) => {
    switch (state) {
      case 'loading':
      case 'ready':
      case 'starting':
      case 'quit':
      case 'error':
        renderStart();
        show(start);
        if (state === 'ready' || state === 'quit' || state === 'error') {
          startTile.focus({ preventScroll: true });
        }
        break;
      case 'paused':
        renderPause();
        show(pauseMenu);
        resume.focus({ preventScroll: true });
        break;
      case 'countdown':
        renderCountdown();
        show(countdown);
        break;
      case 'finished': {
        const results = session.results;
        if (!results) break;
        const again = renderResults(results);
        show(resultsSheet);
        again.focus({ preventScroll: true });
        break;
      }
      default:
        show(undefined);
        // Keep focus off the overlays' buttons so lane keys never activate them.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
  };

  const offs = [
    session.events.on('statechange', ({ state }) => {
      render(state);
    }),
    session.events.on('pause', renderPause),
    session.events.on('countdown', renderCountdown),
  ];

  // Loading progress has no event; poll it while loading.
  const poll = setInterval(() => {
    if (session.state === 'loading') renderStart();
  }, 200);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) return;
    const onButton = event.target instanceof HTMLButtonElement;
    const state = session.state;
    if (event.key === 'Escape') {
      if (state === 'leadIn' || state === 'playing') session.pause('player');
      else if (state === 'paused') session.resume();
      return;
    }
    // Enter or Space starts from anywhere; a focused button handles its own.
    if ((event.key === 'Enter' || event.key === ' ') && !onButton) {
      if (state === 'ready' || state === 'quit') {
        event.preventDefault();
        session.start();
      }
    }
  };
  window.addEventListener('keydown', onKeyDown);

  render(session.state);

  return {
    dispose() {
      for (const off of offs) off();
      clearInterval(poll);
      window.removeEventListener('keydown', onKeyDown);
      show(undefined);
    },
  };
}
