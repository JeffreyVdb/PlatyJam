import type { Instrument } from './instrument';
import type { Timeline } from './timeline';

/**
 * One accompaniment note, in chart time (ms at 1×). PLA-4's chart format uses the
 * same shape for `accompaniment[]`.
 */
export interface AccompanimentNote {
  /** Start, chart ms. */
  t: number;
  /** MIDI note number (60 = middle C). */
  pitch: number;
  /** Length, chart ms. */
  dur: number;
  /** MIDI velocity, 1–127. */
  vel: number;
}

export interface PlannedNote {
  note: AccompanimentNote;
  /** Context seconds. */
  start: number;
  stop: number;
}

export const TICK_MS = 25;
export const HORIZON_S = 0.1;

export interface WindowInput {
  /** Sorted by `t`. */
  notes: readonly AccompanimentNote[];
  /** Index of the first note not yet planned. */
  cursor: number;
  /** Context time now, seconds. */
  now: number;
  horizonSec: number;
  /** Context seconds to start a sound heard at a chart time (tempo and A applied). */
  startAt: (songMs: number) => number;
}

export interface WindowPlan {
  planned: PlannedNote[];
  /** Notes passed over because their start time was already behind `now`. */
  skipped: number;
  cursor: number;
}

/**
 * Picks the notes to hand to Web Audio on this tick: those starting before
 * `now + horizonSec`. The cursor only moves forward, so overlapping windows never
 * plan a note twice. A note whose start already passed (the tick ran late) is
 * skipped rather than played late.
 */
export function planWindow({ notes, cursor, now, horizonSec, startAt }: WindowInput): WindowPlan {
  const planned: PlannedNote[] = [];
  let skipped = 0;
  let i = cursor;
  for (; i < notes.length; i += 1) {
    const note = notes[i];
    if (!note) break;
    const start = startAt(note.t);
    if (start >= now + horizonSec) break;
    if (start < now) {
      skipped += 1;
      continue;
    }
    planned.push({ note, start, stop: startAt(note.t + note.dur) });
  }
  return { planned, skipped, cursor: i };
}

/**
 * Index of the first note that still has to start at context time `now`. Used to
 * re-plan after a pause or seek: notes that started before it are not replayed.
 */
export function seekCursor(
  notes: readonly AccompanimentNote[],
  now: number,
  startAt: (songMs: number) => number,
): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const note = notes[mid];
    if (note && startAt(note.t) < now) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface AccompanimentStats {
  active: boolean;
  scheduled: number;
  skipped: number;
  /** How far ahead of its start the most recent note was handed over, ms. */
  lastLeadMs: number;
}

/**
 * Plays chart accompaniment through an instrument with look-ahead scheduling: a
 * ~25 ms timer queues every note starting within the next ~100 ms against the
 * context clock. The timer only decides what to queue; timing comes from Web Audio.
 */
export interface Accompaniment {
  /** Starts scheduling `notes` against the timeline's (running) clock. */
  play(notes: readonly AccompanimentNote[]): void;
  /** Stops the timer and fades every voice out; `resume` picks up from the clock. */
  pause(fadeMs?: number): void;
  /** Re-plans from the current song time, if a song is loaded and the clock runs. */
  resume(): void;
  /** Fail or quit: fades every voice, clears the timer and forgets the song. */
  stopAll(fadeMs: number): void;
  stats(): AccompanimentStats;
}

export interface AccompanimentOptions<Voice> {
  timeline: Timeline;
  /** Current context time, seconds (read on every tick: the context can be replaced). */
  now: () => number;
  instrument: Instrument<Voice>;
  tickMs?: number;
  horizonSec?: number;
}

export const PAUSE_FADE_MS = 30;

export function createAccompaniment<Voice>({
  timeline,
  now,
  instrument,
  tickMs = TICK_MS,
  horizonSec = HORIZON_S,
}: AccompanimentOptions<Voice>): Accompaniment {
  let notes: readonly AccompanimentNote[] = [];
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stats: AccompanimentStats = { active: false, scheduled: 0, skipped: 0, lastLeadMs: 0 };
  const startAt = (songMs: number) => timeline.startTimeFor(songMs);

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    stats.active = false;
  };

  const tick = () => {
    timer = undefined;
    if (!timeline.clock.isRunning) {
      stats.active = false;
      return;
    }
    const ctxNow = now();
    const plan = planWindow({ notes, cursor, now: ctxNow, horizonSec, startAt });
    cursor = plan.cursor;
    stats.skipped += plan.skipped;
    for (const { note, start, stop } of plan.planned) {
      const voice = instrument.noteOn(note.pitch, note.vel, start);
      if (voice !== null) instrument.noteOff(voice, stop);
      stats.scheduled += 1;
      stats.lastLeadMs = (start - ctxNow) * 1000;
    }
    if (cursor >= notes.length) {
      stats.active = false;
      return;
    }
    stats.active = true;
    timer = setTimeout(tick, tickMs);
  };

  const replan = () => {
    clearTimer();
    if (!timeline.clock.isRunning || notes.length === 0) return;
    cursor = seekCursor(notes, now(), startAt);
    tick();
  };

  return {
    play(next) {
      notes = [...next].sort((a, b) => a.t - b.t);
      stats.scheduled = 0;
      stats.skipped = 0;
      replan();
    },
    pause(fadeMs = PAUSE_FADE_MS) {
      clearTimer();
      instrument.stopAll(fadeMs);
    },
    resume: replan,
    stopAll(fadeMs) {
      clearTimer();
      notes = [];
      cursor = 0;
      instrument.stopAll(fadeMs);
    },
    stats: () => ({ ...stats }),
  };
}
