import { describe, expect, it, vi } from 'vitest';
import { backingTrackUrl, loadBackingTrack, planBackingStart } from './backing-track';
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

describe('backingTrackUrl', () => {
  it('puts a relative path under the app base', () => {
    expect(backingTrackUrl('/PlatyJam/', 'songs/intro.mp3')).toBe('/PlatyJam/songs/intro.mp3');
  });

  it('leaves root-relative and absolute URLs alone', () => {
    expect(backingTrackUrl('/PlatyJam/', '/media/intro.mp3')).toBe('/media/intro.mp3');
    expect(backingTrackUrl('/PlatyJam/', 'https://example.org/a.mp3')).toBe(
      'https://example.org/a.mp3',
    );
    expect(backingTrackUrl('/PlatyJam/', 'blob:abc')).toBe('blob:abc');
  });
});

describe('loadBackingTrack', () => {
  const decoded = { duration: 60 } as AudioBuffer;
  const bytes = new ArrayBuffer(8);
  const ok = () => Promise.resolve(new Response(bytes));

  it('fetches the file under the app base and decodes it', async () => {
    const fetch = vi.fn(ok);
    const decode = vi.fn(() => Promise.resolve(decoded));
    const buffer = await loadBackingTrack({
      url: 'songs/a.mp3',
      base: '/PlatyJam/',
      fetch,
      decode,
    });
    expect(buffer).toBe(decoded);
    expect(fetch).toHaveBeenCalledWith('/PlatyJam/songs/a.mp3');
    expect(decode).toHaveBeenCalledWith(expect.any(ArrayBuffer));
  });

  it.each([
    ['an HTTP error', () => Promise.resolve(new Response('', { status: 404 })), () => decoded],
    ['no network', () => Promise.reject(new TypeError('offline')), () => decoded],
    [
      'a file that does not decode',
      ok,
      () => Promise.reject(new DOMException('bad', 'EncodingError')),
    ],
  ] as const)(
    'resolves null on %s, so the song plays without it',
    async (_label, fetch, decode) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const buffer = await loadBackingTrack({
        url: 'songs/a.mp3',
        base: '/',
        fetch,
        decode: () => Promise.resolve().then(decode),
      });
      expect(buffer).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    },
  );
});
