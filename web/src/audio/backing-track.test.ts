import { describe, expect, it } from 'vitest';
import { planBackingStart } from './backing-track';
import { createSongClock } from './clock';

function clockAt({ tempo = 1, ctx = 0, songMs = 0 } = {}) {
  const clock = createSongClock(() => ctx);
  clock.setTempo(tempo);
  clock.start(songMs, ctx);
  return clock;
}

describe('planBackingStart', () => {
  const base = { leadSec: 0.05, trackStartMs: 0, durationSec: 60, audioOffsetMs: 0 };

  it('starts the buffer at its beginning when the track start is still ahead', () => {
    const clock = clockAt({ songMs: -2000 });
    expect(planBackingStart({ ...base, clock, now: 0 })).toEqual({ when: 2, offset: 0 });
  });

  it('starts A ms early so the first sample is heard on time', () => {
    const clock = clockAt({ songMs: -2000 });
    const plan = planBackingStart({ ...base, audioOffsetMs: 40, clock, now: 0 });
    expect(plan?.when).toBeCloseTo(1.96, 9);
    expect(plan?.offset).toBe(0);
  });

  it('joins mid-track after a resume, at the buffer position heard at the start time', () => {
    // Resumed at song 10 s on a fresh context (time 0).
    const clock = clockAt({ songMs: 10_000 });
    const plan = planBackingStart({ ...base, clock, now: 0 });
    expect(plan?.when).toBeCloseTo(0.05, 9);
    expect(plan?.offset).toBeCloseTo(10.05, 9);
  });

  it('accounts for the audio offset when joining mid-track', () => {
    const clock = clockAt({ songMs: 10_000 });
    const plan = planBackingStart({ ...base, audioOffsetMs: 100, clock, now: 0 });
    // Started at 0.05 s, heard at 0.15 s, which is song 10.15 s.
    expect(plan?.offset).toBeCloseTo(10.15, 9);
  });

  it('measures the offset in buffer seconds (chart time) at tempo ≠ 1', () => {
    const clock = clockAt({ songMs: 10_000, tempo: 1.5 });
    const plan = planBackingStart({ ...base, clock, now: 0 });
    // 50 ms of real time at 1.5× is 75 chart ms.
    expect(plan?.offset).toBeCloseTo(10.075, 9);
  });

  it('honours a track that starts later in the chart', () => {
    const clock = clockAt({ songMs: 0 });
    expect(planBackingStart({ ...base, trackStartMs: 4000, clock, now: 0 })).toEqual({
      when: 4,
      offset: 0,
    });
  });

  it('returns null once the track is over', () => {
    const clock = clockAt({ songMs: 61_000 });
    expect(planBackingStart({ ...base, clock, now: 0 })).toBeNull();
  });
});
