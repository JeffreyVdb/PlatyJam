import {
  CALIBRATION_GRID,
  clampOffsets,
  deriveOffsets,
  type PhaseResult,
  summarizePhase,
  tapErrors,
} from '../audio/calibration';
import { saveCalibration } from '../audio/calibration-store';
import { ACCENT, createClick } from '../audio/click';
import { createSongClock } from '../audio/clock';
import type { AudioEngine } from '../audio/engine';
import { type AccompanimentNote, createAccompaniment } from '../audio/scheduler';
import { createTimeline, type LatencyOffsets, ZERO_OFFSETS } from '../audio/timeline';

/**
 * The latency calibration: two tap-along rounds, then the result to save.
 *
 * 1. Watch: flashes on a 100 BPM grid, no sound. Taps measure P_seen = I.
 * 2. Listen: clicks only; nothing on screen moves with the scored beats. Taps
 *    measure P_heard = A + I.
 *
 * Both rounds use the gameplay code paths (song clock, timeline, scheduler,
 * judgeSongTime) with the offsets at zero, so any bias in that pipeline ends up in
 * the measured offsets. Taps use Pointer Events and never make a sound.
 */
export interface CalibrationOptions {
  /** Where the overlay is mounted: the HUD layer, outside the touch-guarded stage. */
  root: HTMLElement;
  engine: AudioEngine;
  /** `persisted` is false when storage refused; the offsets still apply until reload. */
  onSaved?: (offsets: LatencyOffsets, persisted: boolean) => void;
  onClose?: () => void;
}

export interface CalibrationHandle {
  close(): void;
}

type Round = 'see' | 'hear';

/** Silence before the first count-in beat, ms. */
const LEAD_MS = 1000;
/** How long a flash stays lit, ms. */
const FLASH_MS = 110;
/** The Listen count-in number shows for this part of each count-in beat only. */
const COUNT_SHOW_MS = 300;
/** How long to wait for a suspended context to start before giving up. */
const START_TIMEOUT_MS = 1500;
const NUDGE_MS = 5;

const ROUND_COPY = {
  see: {
    step: 'Step 1 of 2: Watch',
    instruction: 'Tap anywhere when the circle lights up.',
    cue: 'flash',
  },
  hear: {
    step: 'Step 2 of 2: Listen',
    instruction: 'Tap anywhere on each click. The circle stays still.',
    cue: 'click',
  },
} as const;

function el<K extends keyof HTMLElementTagNameMap>(
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
  const node = el('button', `hud-button hud-button--${variant}`, label);
  node.type = 'button';
  node.addEventListener('click', onTap);
  return node;
}

function clickTrack(): AccompanimentNote[] {
  const { beatMs, countInBeats, scoredBeats } = CALIBRATION_GRID;
  return Array.from({ length: countInBeats + scoredBeats }, (_, beat) => ({
    t: beat * beatMs,
    pitch: beat < countInBeats ? ACCENT : 0,
    dur: 30,
    vel: 100,
  }));
}

interface RoundView {
  target: HTMLElement;
  count: HTMLElement;
}

interface RoundRun {
  tap(eventTimeStamp: number): void;
  stop(): void;
}

/** Runs one round against its own song clock; `done` gets the summarised taps. */
function runRound(
  round: Round,
  engine: AudioEngine,
  view: RoundView,
  done: (result: PhaseResult) => void,
): RoundRun {
  const { beatMs, countInBeats, scoredBeats } = CALIBRATION_GRID;
  const beats = countInBeats + scoredBeats;
  const endMs = beats * beatMs;
  const clock = createSongClock(() => engine.context.currentTime);
  const timeline = createTimeline({
    clock,
    contextTimeAt: (perfMs) => engine.contextTimeAt(perfMs),
    offsets: () => ZERO_OFFSETS,
  });
  const taps: number[] = [];
  const clicks =
    round === 'hear'
      ? createAccompaniment({
          timeline,
          now: () => engine.context.currentTime,
          instrument: createClick(engine),
        })
      : undefined;

  clock.start(-LEAD_MS);
  clicks?.play(clickTrack());

  let frame = 0;
  const render = () => {
    const songMs = timeline.songTime();
    const beat = Math.floor(songMs / beatMs);
    const since = songMs - beat * beatMs;
    const inCountIn = beat >= 0 && beat < countInBeats;
    const number = inCountIn ? String(countInBeats - beat) : '';

    if (round === 'see') {
      const lit = beat >= 0 && beat < beats && since < FLASH_MS;
      view.target.dataset.lit = lit ? (inCountIn ? 'count' : 'beat') : 'off';
      view.count.textContent = lit ? number : '';
    } else {
      // Count-in only, and gone well before the first scored click.
      view.count.textContent = inCountIn && since < COUNT_SHOW_MS ? number : '';
    }

    if (songMs >= endMs) {
      stop();
      done(summarizePhase(tapErrors(taps, CALIBRATION_GRID)));
      return;
    }
    frame = requestAnimationFrame(render);
  };
  frame = requestAnimationFrame(render);

  function stop() {
    cancelAnimationFrame(frame);
    clicks?.stopAll(10);
    clock.pause();
  }

  return {
    tap(eventTimeStamp) {
      if (clock.isRunning) taps.push(timeline.judgeSongTime(eventTimeStamp));
    },
    stop,
  };
}

/** Resolves true once the context runs (the Start tap usually unlocks it). */
function whenRunning(engine: AudioEngine): Promise<boolean> {
  if (engine.context.state === 'running' && engine.phase !== 'interrupted') {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const offs = [
      engine.events.on('unlocked', () => {
        finish(true);
      }),
      engine.events.on('resumed', () => {
        finish(true);
      }),
    ];
    const timer = setTimeout(() => {
      finish(engine.context.state === 'running' && engine.phase !== 'interrupted');
    }, START_TIMEOUT_MS);
    function finish(ok: boolean) {
      clearTimeout(timer);
      for (const off of offs) off();
      resolve(ok);
    }
  });
}

export function openCalibration({
  root,
  engine,
  onSaved,
  onClose,
}: CalibrationOptions): CalibrationHandle {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const sheet = el('section', 'calibration');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'calibration-title');
  const bar = el('header', 'calibration-bar');
  const title = el('h2', 'calibration-title', 'Timing check');
  title.id = 'calibration-title';
  const body = el('div', 'calibration-body');
  bar.append(
    title,
    button('Close', 'quiet', () => {
      close();
    }),
  );
  sheet.append(bar, body);
  root.append(sheet);

  let run: RoundRun | undefined;
  let seen: number | undefined;
  let closed = false;

  const show = (...nodes: Node[]) => {
    run?.stop();
    run = undefined;
    body.replaceChildren(...nodes);
    body.classList.remove('is-pad');
  };

  const showIntro = (notice?: string) => {
    const column = el('div', 'calibration-column');
    if (notice) column.append(el('p', 'calibration-notice', notice));
    const steps = el('ol', 'calibration-steps');
    steps.append(
      el('li', '', 'Watch: tap whenever the circle lights up. There is no sound.'),
      el('li', '', 'Listen: tap on every click. The screen stays still.'),
    );
    const start = button('Start', 'primary', () => {
      // Inside the tap: lets the engine resume or unlock the context right here.
      if (engine.phase === 'interrupted') engine.resumeFromGesture();
      void beginRound('see');
    });
    column.append(
      el(
        'p',
        'calibration-lede',
        'Every screen, speaker and pair of headphones adds a little delay. Two short rounds measure yours, so your taps land on the beat.',
      ),
      steps,
      el(
        'p',
        'calibration-aside',
        "Use the headphones or speakers you play with. Bluetooth headphones add a delay that calibration can't fully fix; wired headphones or the built-in speakers are the most accurate.",
      ),
      actions(start),
    );
    show(column);
    start.focus({ preventScroll: true });
  };

  const actions = (...buttons: HTMLButtonElement[]) => {
    const row = el('div', 'calibration-actions');
    row.append(...buttons);
    return row;
  };

  const beginRound = async (round: Round) => {
    if (round === 'see') seen = undefined;
    const copy = ROUND_COPY[round];
    const view = el('div', 'calibration-run');
    view.dataset.round = round;
    const target = el('div', 'calibration-target');
    target.dataset.lit = 'off';
    const count = el('span', 'calibration-count');
    target.append(count);
    view.append(
      el('p', 'calibration-step', copy.step),
      target,
      el('p', 'calibration-instruction', copy.instruction),
    );
    show(view);
    body.classList.add('is-pad');

    if (!(await whenRunning(engine))) {
      if (!closed) showIntro("PlatyJam couldn't start its sound. Tap Start to try again.");
      return;
    }
    if (closed || !view.isConnected) return;
    run = runRound(round, engine, { target, count }, (result) => {
      run = undefined;
      finishRound(round, result);
    });
  };

  const finishRound = (round: Round, result: PhaseResult) => {
    if (!result.ok) {
      showRetry(round, result);
      return;
    }
    if (round === 'see') {
      seen = result.offsetMs;
      void beginRound('hear');
      return;
    }
    showResults(deriveOffsets({ seenMs: seen ?? 0, heardMs: result.offsetMs }));
  };

  const showRetry = (round: Round, result: Extract<PhaseResult, { ok: false }>) => {
    const cue = ROUND_COPY[round].cue;
    const message =
      result.reason === 'too-few-taps'
        ? `Only ${result.taps} taps landed near a ${cue}; at least 8 are needed. Tap on every ${cue}, from the first to the last.`
        : `Your taps were too spread out to measure. Find a steady rhythm and tap on every ${cue}.`;
    const column = el('div', 'calibration-column');
    const again = button('Try again', 'primary', () => {
      void beginRound('see');
    });
    const heading =
      result.reason === 'too-few-taps' ? 'Not enough taps' : 'Inconsistent, try again';
    column.append(
      el('h3', 'calibration-heading', heading),
      el('p', 'calibration-lede', message),
      actions(again),
    );
    show(column);
    again.focus({ preventScroll: true });
  };

  const showResults = (measured: LatencyOffsets) => {
    let offsets = measured;
    const column = el('div', 'calibration-column');
    const values = el('dl', 'calibration-values');
    const soundValue = el('dd', 'calibration-value');
    const touchValue = el('dd', 'calibration-value');
    const render = () => {
      soundValue.textContent = `${offsets.audioOffsetMs} ms`;
      touchValue.textContent = `${offsets.inputOffsetMs} ms`;
    };
    const nudge = (deltaMs: number) => {
      offsets = clampOffsets({ ...offsets, audioOffsetMs: offsets.audioOffsetMs + deltaMs });
      render();
    };
    const sound = el('div', 'calibration-row');
    const nudges = el('div', 'calibration-nudge');
    const earlier = button(`−${NUDGE_MS} ms`, 'quiet', () => {
      nudge(-NUDGE_MS);
    });
    earlier.setAttribute('aria-label', `Sound delay minus ${NUDGE_MS} milliseconds`);
    const later = button(`+${NUDGE_MS} ms`, 'quiet', () => {
      nudge(NUDGE_MS);
    });
    later.setAttribute('aria-label', `Sound delay plus ${NUDGE_MS} milliseconds`);
    nudges.append(earlier, later);
    sound.append(el('dt', 'calibration-label', 'Sound delay'), soundValue, nudges);
    const touch = el('div', 'calibration-row');
    touch.append(el('dt', 'calibration-label', 'Touch delay'), touchValue);
    values.append(sound, touch);
    render();

    const save = button('Save', 'primary', () => {
      const persisted = saveCalibration(offsets);
      engine.setOffsets(offsets);
      onSaved?.(engine.offsets, persisted);
      close();
    });
    column.append(
      el('h3', 'calibration-heading', 'Your timing'),
      values,
      el(
        'p',
        'calibration-aside',
        'If notes still sound early or late while you play, nudge the sound delay: up if they come early, down if they come late.',
      ),
      actions(
        save,
        button('Try again', 'quiet', () => {
          void beginRound('see');
        }),
      ),
    );
    show(column);
    save.focus({ preventScroll: true });
  };

  const ripple = (event: PointerEvent) => {
    const rect = body.getBoundingClientRect();
    const dot = el('span', 'calibration-ripple');
    dot.style.left = `${event.clientX - rect.left}px`;
    dot.style.top = `${event.clientY - rect.top}px`;
    dot.addEventListener('animationend', () => {
      dot.remove();
    });
    setTimeout(() => {
      dot.remove();
    }, 600);
    body.append(dot);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!run || !event.isPrimary) return;
    run.tap(event.timeStamp);
    ripple(event);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (run && !event.repeat && (event.key === ' ' || event.key === 'Enter')) {
      event.preventDefault();
      run.tap(event.timeStamp);
    }
  };
  body.addEventListener('pointerdown', onPointerDown);
  sheet.addEventListener('keydown', onKeyDown);

  const offInterrupted = engine.events.on('interrupted', () => {
    if (!run) return;
    showIntro('The timing check stopped when PlatyJam was paused. Start again when you are ready.');
  });

  function close() {
    if (closed) return;
    closed = true;
    run?.stop();
    run = undefined;
    offInterrupted();
    sheet.remove();
    returnFocus?.focus({ preventScroll: true });
    onClose?.();
  }

  showIntro();
  return { close };
}
