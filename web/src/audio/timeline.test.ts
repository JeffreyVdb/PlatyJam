import { describe, expect, it } from 'vitest';
import { createSongClock } from './clock';
import { createTimeline, type LatencyOffsets } from './timeline';

/**
 * A world where context time and performance time tick together:
 * context second s is audible at performance ms `s * 1000 + skewMs`.
 */
function world({ skewMs = 0 } = {}) {
  const state = { ctx: 0, perfMs: skewMs, offsets: { audioOffsetMs: 0, inputOffsetMs: 0 } };
  const clock = createSongClock(() => state.ctx);
  const timeline = createTimeline({
    clock,
    contextTimeAt: (perfMs) => (perfMs - skewMs) / 1000,
    nowMs: () => state.perfMs,
    offsets: (): LatencyOffsets => state.offsets,
  });
  const advance = (seconds: number) => {
    state.ctx += seconds;
    state.perfMs += seconds * 1000;
  };
  return { state, clock, timeline, advance };
}

describe('createTimeline', () => {
  it('reports song time through the output mapping', () => {
    const { clock, timeline, advance } = world({ skewMs: 5000 });
    clock.start(-1000);
    advance(1.5);
    expect(timeline.songTime()).toBe(500);
  });

  it('never lets songTime() go backwards while running', () => {
    const { state, clock, timeline, advance } = world();
    clock.start(0);
    advance(1);
    expect(timeline.songTime()).toBe(1000);
    // The output timestamp jitters back by 4 ms.
    state.perfMs -= 4;
    expect(timeline.songTime()).toBe(1000);
    state.perfMs += 10;
    expect(timeline.songTime()).toBe(1006);
  });

  it('resets the monotonic clamp on a seek back', () => {
    const { clock, timeline, advance } = world();
    clock.start(0);
    advance(5);
    expect(timeline.songTime()).toBe(5000);
    clock.start(0);
    expect(timeline.songTime()).toBe(0);
  });

  it('returns the held position while paused', () => {
    const { clock, timeline, advance } = world();
    clock.start(0);
    advance(2);
    clock.pause();
    advance(10);
    expect(timeline.songTime()).toBe(2000);
  });

  it('schedules a sound A ms early so it is heard on the beat', () => {
    const { state, clock, timeline } = world();
    state.offsets.audioOffsetMs = 40;
    clock.start(0);
    expect(timeline.startTimeFor(1000)).toBeCloseTo(0.96, 9);
  });

  it('keeps the audio offset in real ms at tempo ≠ 1', () => {
    const { state, clock, timeline } = world();
    state.offsets.audioOffsetMs = 40;
    clock.setTempo(1.5);
    clock.start(0);
    // Chart 1500 ms at 1.5× is 1 s of real time; the 40 ms are not scaled.
    expect(timeline.startTimeFor(1500)).toBeCloseTo(0.96, 9);
  });

  it('judges a tap at the moment it happened, I ms before it was received', () => {
    const { state, clock, timeline } = world();
    state.offsets.inputOffsetMs = 30;
    clock.start(0);
    // Received at perf 1030 ms: it happened at 1000 ms, which is song 1000 ms.
    expect(timeline.judgeSongTime(1030)).toBeCloseTo(1000, 9);
  });

  it('keeps the input offset in real ms at tempo ≠ 1', () => {
    const { state, clock, timeline } = world();
    state.offsets.inputOffsetMs = 30;
    clock.setTempo(0.75);
    clock.start(0);
    // Real 1000 ms at 0.75× is chart 750 ms.
    expect(timeline.judgeSongTime(1030)).toBeCloseTo(750, 9);
  });

  it('reads the offsets at call time', () => {
    const { state, clock, timeline } = world();
    clock.start(0);
    expect(timeline.judgeSongTime(1000)).toBeCloseTo(1000, 9);
    state.offsets = { audioOffsetMs: 0, inputOffsetMs: 100 };
    expect(timeline.judgeSongTime(1000)).toBeCloseTo(900, 9);
  });

  it('judges with the output mapping, not the current frame', () => {
    const { clock, timeline, advance } = world({ skewMs: 250 });
    clock.start(0);
    advance(3);
    // A tap that happened 0.5 s ago, received now.
    expect(timeline.judgeSongTime(250 + 2500)).toBeCloseTo(2500, 9);
  });

  it('reads what was shown at an event through the output mapping, with no input offset', () => {
    const { state, clock, timeline, advance } = world({ skewMs: 250 });
    state.offsets.inputOffsetMs = 100;
    clock.setTempo(0.75);
    clock.start(0);
    advance(3);
    // An event 0.5 s ago: real 2500 ms at 0.75× is what songTime() showed then.
    expect(timeline.shownSongTime(250 + 2500)).toBeCloseTo(1875, 9);
    expect(timeline.judgeSongTime(250 + 2500)).toBeCloseTo(1800, 9);
  });

  describe('judgeSongTimeNow', () => {
    it('judges a tap received now while the clock runs', () => {
      const { state, clock, timeline, advance } = world({ skewMs: 250 });
      state.offsets.inputOffsetMs = 200;
      clock.setTempo(1.5);
      clock.start(0);
      advance(2);
      expect(timeline.judgeSongTimeNow()).toBeCloseTo(timeline.judgeSongTime(state.perfMs), 9);
      expect(timeline.judgeSongTimeNow()).toBeCloseTo(3000 - 300, 9);
    });

    it('takes the input offset off the held position once the clock stopped', () => {
      const { state, clock, timeline, advance } = world();
      state.offsets.inputOffsetMs = -200;
      clock.setTempo(0.75);
      clock.start(0);
      advance(2);
      clock.pause();
      advance(5);
      // Held at 1500; at −200 ms a tap received as it stopped counts 200 ms (150 chart ms) later.
      expect(timeline.judgeSongTimeNow()).toBeCloseTo(1500 + 150, 9);
    });

    it('keeps the judge time from just before pause() stopped the clock', () => {
      const { state, clock, timeline, advance } = world();
      // What is heard trails the context clock by 40 ms.
      state.perfMs -= 40;
      state.offsets.inputOffsetMs = 200;
      clock.setTempo(1.5);
      clock.start(0);
      advance(2);
      const before = timeline.judgeSongTimeNow();
      timeline.pause();
      advance(5);
      expect(clock.isRunning).toBe(false);
      expect(clock.position()).toBeCloseTo(3000, 9);
      // Heard 40 ms behind the clock and tapped 200 ms before received: 240 real ms back.
      expect(before).toBeCloseTo(3000 - 240 * 1.5, 9);
      expect(timeline.judgeSongTimeNow()).toBeCloseTo(before, 9);
    });

    it('forgets that judge time once the clock moves again', () => {
      const { state, clock, timeline, advance } = world();
      // What is heard trails the context clock by 40 ms.
      state.perfMs -= 40;
      state.offsets.inputOffsetMs = 200;
      clock.start(0);
      advance(2);
      timeline.pause();
      clock.resume();
      advance(1);
      clock.pause();
      // Paused behind the timeline's back: only the held position is known.
      expect(timeline.judgeSongTimeNow()).toBeCloseTo(3000 - 200, 9);
    });
  });

  describe('shownSongTimeNow', () => {
    it('reads what is shown now while the clock runs, with no input offset', () => {
      const { state, clock, timeline, advance } = world({ skewMs: 250 });
      state.offsets.inputOffsetMs = 200;
      clock.setTempo(1.5);
      clock.start(0);
      advance(2);
      expect(timeline.shownSongTimeNow()).toBeCloseTo(timeline.shownSongTime(state.perfMs), 9);
      expect(timeline.shownSongTimeNow()).toBeCloseTo(3000, 9);
    });

    it('keeps what was shown just before pause() stopped the clock', () => {
      const { state, clock, timeline, advance } = world();
      // What is heard trails the context clock by 40 ms.
      state.perfMs -= 40;
      state.offsets.inputOffsetMs = 200;
      clock.setTempo(1.5);
      clock.start(0);
      advance(2);
      timeline.pause();
      advance(5);
      expect(clock.position()).toBeCloseTo(3000, 9);
      expect(timeline.shownSongTimeNow()).toBeCloseTo(3000 - 40 * 1.5, 9);
    });

    it('falls back to the held position once something else stopped the clock', () => {
      const { state, clock, timeline, advance } = world();
      state.offsets.inputOffsetMs = 200;
      clock.start(0);
      advance(2);
      clock.pause();
      advance(1);
      expect(timeline.shownSongTimeNow()).toBeCloseTo(2000, 9);
    });
  });
});
