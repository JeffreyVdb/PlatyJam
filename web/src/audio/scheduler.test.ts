import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSongClock } from './clock';
import type { Instrument } from './instrument';
import { type AccompanimentNote, createAccompaniment, planWindow, seekCursor } from './scheduler';
import { createTimeline } from './timeline';

const note = (t: number, dur = 200, pitch = 60): AccompanimentNote => ({ t, pitch, dur, vel: 90 });

/** Song time 0 at context 0, with an audio offset of `audioOffsetMs`. */
function startAt({ tempo = 1, audioOffsetMs = 0, anchorCtx = 0, anchorSongMs = 0 } = {}) {
  const clock = createSongClock(() => anchorCtx);
  clock.setTempo(tempo);
  clock.start(anchorSongMs);
  return (songMs: number) => clock.ctxTimeFor(songMs) - audioOffsetMs / 1000;
}

describe('planWindow', () => {
  const notes = [note(0), note(50), note(100), note(150), note(400)];

  it('plans notes that start inside the horizon, with start and stop times', () => {
    const plan = planWindow({ notes, cursor: 0, now: 0, horizonSec: 0.1, startAt: startAt() });
    expect(plan.planned.map((p) => p.note.t)).toEqual([0, 50]);
    expect(plan.planned[1]).toEqual({ note: notes[1], start: 0.05, stop: 0.25 });
    expect(plan.cursor).toBe(2);
    expect(plan.skipped).toBe(0);
  });

  it('never plans a note twice across overlapping ticks', () => {
    const at = startAt();
    const seen: number[] = [];
    let cursor = 0;
    for (const now of [0, 0.025, 0.05, 0.075, 0.1, 0.125, 0.3, 0.325]) {
      const plan = planWindow({ notes, cursor, now, horizonSec: 0.1, startAt: at });
      seen.push(...plan.planned.map((p) => p.note.t));
      cursor = plan.cursor;
    }
    expect(seen).toEqual([0, 50, 100, 150, 400]);
  });

  it('skips notes whose start has already passed (a stalled tick)', () => {
    const plan = planWindow({ notes, cursor: 0, now: 0.12, horizonSec: 0.1, startAt: startAt() });
    expect(plan.planned.map((p) => p.note.t)).toEqual([150]);
    expect(plan.skipped).toBe(3);
    expect(plan.cursor).toBe(4);
  });

  it('applies tempo to start times and durations', () => {
    const plan = planWindow({
      notes: [note(150, 300)],
      cursor: 0,
      now: 0,
      horizonSec: 0.1,
      startAt: startAt({ tempo: 1.5 }),
    });
    // 150 chart ms at 1.5× starts at 100 ms; 300 chart ms last 200 real ms.
    expect(plan.planned).toHaveLength(0);

    const later = planWindow({
      notes: [note(150, 300)],
      cursor: 0,
      now: 0.01,
      horizonSec: 0.1,
      startAt: startAt({ tempo: 1.5 }),
    });
    expect(later.planned[0]?.start).toBeCloseTo(0.1, 9);
    expect(later.planned[0]?.stop).toBeCloseTo(0.3, 9);
  });

  it('starts notes A ms early', () => {
    const plan = planWindow({
      notes: [note(1000, 500)],
      cursor: 0,
      now: 0.9,
      horizonSec: 0.1,
      startAt: startAt({ audioOffsetMs: 40 }),
    });
    expect(plan.planned[0]?.start).toBeCloseTo(0.96, 9);
    expect(plan.planned[0]?.stop).toBeCloseTo(1.46, 9);
  });
});

describe('seekCursor', () => {
  const notes = [note(0), note(1000), note(2000), note(3000)];

  it('re-plans after a pause from the current song time, without replaying started notes', () => {
    // Paused at song 1500 ms, resumed on a recreated context at time 0.
    const at = startAt({ anchorCtx: 0, anchorSongMs: 1500 });
    const cursor = seekCursor(notes, 0, at);
    expect(cursor).toBe(2);

    const plan = planWindow({ notes, cursor, now: 0.45, horizonSec: 0.1, startAt: at });
    expect(plan.planned.map((p) => p.note.t)).toEqual([2000]);
    expect(plan.planned[0]?.start).toBeCloseTo(0.5, 9);
  });

  it('includes a note exactly at the current time', () => {
    expect(seekCursor(notes, 1, startAt())).toBe(1);
  });

  it('returns the end when every note has started', () => {
    expect(seekCursor(notes, 10, startAt())).toBe(4);
  });

  it('rewinds to the first note on a seek to the start', () => {
    expect(seekCursor(notes, 0, startAt({ anchorSongMs: -500 }))).toBe(0);
  });
});

describe('createAccompaniment', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const state = { ctx: 0 };
    const clock = createSongClock(() => state.ctx);
    const timeline = createTimeline({
      clock,
      contextTimeAt: (perfMs) => perfMs / 1000,
      offsets: () => ({ audioOffsetMs: 0, inputOffsetMs: 0 }),
    });
    const started: { pitch: number; when: number | undefined }[] = [];
    const noteOff = vi.fn();
    const stopAll = vi.fn();
    const instrument: Instrument<number> = {
      noteOn: (pitch, _vel, when) => {
        started.push({ pitch, when });
        return started.length;
      },
      noteOff,
      stopAll,
    };
    const accompaniment = createAccompaniment({ timeline, now: () => state.ctx, instrument });
    /** Moves context time and the timers together. */
    const advance = (ms: number) => {
      for (let i = 0; i < ms; i += 5) {
        state.ctx += 0.005;
        vi.advanceTimersByTime(5);
      }
    };
    return { state, clock, noteOff, stopAll, accompaniment, started, advance };
  }

  const song = [note(0, 100, 60), note(500, 100, 62), note(1000, 100, 64), note(1500, 100, 65)];

  it('queues notes ahead of time and releases each at its end', () => {
    const { clock, noteOff, accompaniment, started, advance } = setup();
    clock.start(-200);
    accompaniment.play(song);
    expect(started).toEqual([]);

    advance(150);
    expect(started.map((s) => s.pitch)).toEqual([60]);
    expect(started[0]?.when).toBeCloseTo(0.2, 9);
    expect(noteOff).toHaveBeenCalledWith(1, expect.closeTo(0.3, 9) as number);
  });

  it('stops on pause and re-plans on resume without replaying started notes', () => {
    const { clock, stopAll, accompaniment, started, advance } = setup();
    clock.start(0);
    accompaniment.play(song);
    advance(450); // 500 ms note is queued (starts within 100 ms)
    expect(started.map((s) => s.pitch)).toEqual([60, 62]);

    clock.pause();
    accompaniment.pause(30);
    expect(stopAll).toHaveBeenCalledWith(30);
    advance(2000);
    expect(started).toHaveLength(2);

    clock.resume();
    accompaniment.resume();
    advance(600);
    // The 500 ms note was cut by the pause before it started; it plays again.
    expect(started.map((s) => s.pitch)).toEqual([60, 62, 62, 64]);
  });

  it('forgets the song on stopAll', () => {
    const { clock, stopAll, accompaniment, started, advance } = setup();
    clock.start(0);
    accompaniment.play(song);
    accompaniment.stopAll(200);
    expect(stopAll).toHaveBeenCalledWith(200);
    accompaniment.resume();
    advance(2000);
    expect(started.map((s) => s.pitch)).toEqual([60]);
    expect(accompaniment.stats().active).toBe(false);
  });
});
