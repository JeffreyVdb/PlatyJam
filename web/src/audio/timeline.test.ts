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
});
