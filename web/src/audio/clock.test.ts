import { describe, expect, it } from 'vitest';
import { createSongClock } from './clock';

/** A context clock the test moves by hand, in seconds. */
function fakeContextTime(start = 0) {
  const time = { now: start };
  return { time, now: () => time.now };
}

describe('createSongClock', () => {
  it('runs from the start offset at one chart ms per real ms', () => {
    const { time, now } = fakeContextTime(10);
    const clock = createSongClock(now);

    clock.start(-2000);
    expect(clock.isRunning).toBe(true);
    expect(clock.songTimeAt(10)).toBe(-2000);
    expect(clock.songTimeAt(12.5)).toBe(500);

    time.now = 11;
    expect(clock.position()).toBe(-1000);
  });

  it('starts at an explicit context time', () => {
    const clock = createSongClock(() => 0);
    clock.start(1000, 4);
    expect(clock.songTimeAt(5)).toBe(2000);
  });

  it('holds the song position while paused and continues from it on resume', () => {
    const { time, now } = fakeContextTime(0);
    const clock = createSongClock(now);
    clock.start(0);

    time.now = 3;
    clock.pause();
    expect(clock.isRunning).toBe(false);
    time.now = 50;
    expect(clock.position()).toBe(3000);
    expect(clock.songTimeAt(99)).toBe(3000);

    clock.resume();
    expect(clock.position()).toBe(3000);
    time.now = 51.25;
    expect(clock.position()).toBe(4250);
  });

  it('survives a recreated context whose time starts again at 0', () => {
    const { time, now } = fakeContextTime(120);
    const clock = createSongClock(now);
    clock.start(10_000);
    time.now = 125;
    clock.pause();

    time.now = 0; // new AudioContext
    clock.resume();
    time.now = 0.5;
    expect(clock.position()).toBe(15_500);
    expect(clock.ctxTimeFor(16_000)).toBe(1);
  });

  it('changes tempo mid-song without moving the position', () => {
    const { time, now } = fakeContextTime(0);
    const clock = createSongClock(now);
    clock.start(0);
    time.now = 2;
    expect(clock.position()).toBe(2000);

    clock.setTempo(1.5);
    expect(clock.tempo).toBe(1.5);
    expect(clock.position()).toBe(2000);
    time.now = 4;
    expect(clock.position()).toBe(5000);

    clock.setTempo(0.75);
    expect(clock.position()).toBe(5000);
    time.now = 8;
    expect(clock.position()).toBe(8000);
  });

  it('keeps the tempo across pause and resume', () => {
    const { time, now } = fakeContextTime(0);
    const clock = createSongClock(now);
    clock.setTempo(1.25);
    clock.start(0);
    time.now = 4;
    clock.pause();
    expect(clock.position()).toBe(5000);
    clock.resume(10);
    expect(clock.songTimeAt(12)).toBe(7500);
  });

  it('clamps tempo to 0.75–1.5', () => {
    const clock = createSongClock(() => 0);
    clock.setTempo(3);
    expect(clock.tempo).toBe(1.5);
    clock.setTempo(0.1);
    expect(clock.tempo).toBe(0.75);
  });

  it('maps song time back to context time, including tempo', () => {
    const clock = createSongClock(() => 0);
    clock.setTempo(1.5);
    clock.start(-3000, 2);

    // 4500 chart ms at 1.5× is 3 real seconds after the anchor.
    expect(clock.ctxTimeFor(1500)).toBe(5);
    expect(clock.songTimeAt(clock.ctxTimeFor(1234))).toBeCloseTo(1234, 9);
  });

  it('refuses to map song time to context time unless running', () => {
    const clock = createSongClock(() => 0);
    expect(() => clock.ctxTimeFor(0)).toThrow();
    clock.start(0);
    clock.pause();
    expect(() => clock.ctxTimeFor(0)).toThrow();
  });

  it('bumps the generation on start, pause and resume but not on tempo changes', () => {
    const clock = createSongClock(() => 0);
    const seen = [clock.generation];
    clock.start(0);
    seen.push(clock.generation);
    clock.setTempo(1.25);
    seen.push(clock.generation);
    clock.pause();
    seen.push(clock.generation);
    clock.resume();
    seen.push(clock.generation);
    expect(seen).toEqual([0, 1, 1, 2, 3]);
  });
});
