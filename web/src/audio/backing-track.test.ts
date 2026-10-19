import { describe, expect, it, vi } from 'vitest';
import {
  backingTrackStartMs,
  backingTrackUrl,
  createBackingTrack,
  loadBackingTrack,
  planBackingStart,
} from './backing-track';
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

  describe('with the chart’s audio.offsetMs (the recording’s position at t = 0)', () => {
    it('starts the file before t = 0 when it is ahead of the chart by offsetMs', () => {
      // 500 ms into the file at t = 0: its first sample plays 500 ms before t = 0.
      const trackStartMs = backingTrackStartMs({ offsetMs: 500 });
      expect(trackStartMs).toBe(-500);
      const clock = clockAt({ songMs: -2000 });
      expect(planBackingStart({ ...base, trackStartMs, clock, now: 0 })).toEqual({
        when: 1.5,
        offset: 0,
      });
    });

    it('starts the file after t = 0 when offsetMs is negative', () => {
      const trackStartMs = backingTrackStartMs({ offsetMs: -250 });
      const clock = clockAt({ songMs: -2000 });
      expect(planBackingStart({ ...base, trackStartMs, clock, now: 0 })).toEqual({
        when: 2.25,
        offset: 0,
      });
    });

    it('joins mid-file when offsetMs reaches back before the lead-in', () => {
      // The file began 3 s before t = 0 but the clock only starts at −2 s.
      const trackStartMs = backingTrackStartMs({ offsetMs: 3000 });
      const clock = clockAt({ songMs: -2000 });
      const plan = planBackingStart({ ...base, trackStartMs, clock, now: 0 });
      expect(plan?.when).toBeCloseTo(0.05, 9);
      // Song time at 0.05 s is −1.95 s, which is 1.05 s into the file.
      expect(plan?.offset).toBeCloseTo(1.05, 9);
    });

    it('puts the recording at offsetMs at chart t = 0', () => {
      const trackStartMs = backingTrackStartMs({ offsetMs: 1200 });
      const clock = clockAt({ songMs: 0 });
      const plan = planBackingStart({ ...base, trackStartMs, clock, now: 0 });
      // Starting (almost) at t = 0 means being 1.2 s into the file, plus the 50 ms lead.
      expect(plan?.offset).toBeCloseTo(1.25, 9);
    });
  });
});

describe('createBackingTrack', () => {
  class FakeParam {
    value = 1;
    readonly calls: [string, ...number[]][] = [];
    cancelScheduledValues(t: number) {
      this.calls.push(['cancel', t]);
    }
    setValueAtTime(v: number, t: number) {
      this.calls.push(['set', v, t]);
    }
    linearRampToValueAtTime(v: number, t: number) {
      this.calls.push(['ramp', v, t]);
    }
  }
  class FakeSource {
    buffer: AudioBuffer | null = null;
    playbackRate = { value: 1 };
    onended: (() => void) | null = null;
    started: [number, number] | undefined;
    stoppedAt: number | undefined;
    connect<T>(node: T) {
      return node;
    }
    disconnect() {
      /* nothing to release */
    }
    start(when: number, offset: number) {
      this.started = [when, offset];
    }
    stop(t: number) {
      this.stoppedAt = t;
    }
  }

  function setup({ tempo = 1, songMs = -2000, trackStartMs = 0 } = {}) {
    const sources: FakeSource[] = [];
    const gains: FakeParam[] = [];
    const target = {
      context: {
        currentTime: 0,
        createBufferSource() {
          const source = new FakeSource();
          sources.push(source);
          return source;
        },
        createGain() {
          const param = new FakeParam();
          gains.push(param);
          return { gain: param, connect: <T>(node: T) => node, disconnect: () => undefined };
        },
      },
      output: {},
    } as unknown as { context: BaseAudioContext; output: AudioNode };
    const clock = clockAt({ tempo, songMs });
    const track = createBackingTrack({
      target,
      clock,
      audioOffsetMs: () => 0,
      buffer: { duration: 60 } as AudioBuffer,
      trackStartMs,
    });
    return {
      track,
      sources,
      gains,
      clock,
      context: target.context as unknown as { currentTime: number },
    };
  }

  it('starts the file at the plan, at the clock tempo', () => {
    const { track, sources } = setup({ tempo: 1.25 });
    track.play();
    expect(track.playing).toBe(true);
    expect(sources[0]?.started).toEqual([1.6, 0]);
    expect(sources[0]?.playbackRate.value).toBe(1.25);
  });

  it('plays nothing while the clock is stopped', () => {
    const { track, sources, clock } = setup();
    clock.pause();
    track.play();
    expect(track.playing).toBe(false);
    expect(sources).toHaveLength(0);
  });

  it('fades the old node out when played again', () => {
    const { track, sources, gains } = setup();
    track.play();
    track.play();
    expect(sources).toHaveLength(2);
    expect(sources[0]?.stoppedAt).toBeCloseTo(0.01, 9);
    expect(gains[0]?.calls).toContainEqual(['ramp', 0, expect.closeTo(0.01, 9)]);
  });

  it('fades and stops on stop(), and is no longer playing', () => {
    const { track, sources } = setup();
    track.play();
    track.stop(150);
    expect(track.playing).toBe(false);
    expect(sources[0]?.stoppedAt).toBeCloseTo(0.15, 9);
  });

  it('drops the node on reset() without touching it: its context is gone', () => {
    const { track, sources, gains } = setup();
    track.play();
    const callsBefore = gains[0]?.calls.length;
    track.reset();
    expect(track.playing).toBe(false);
    expect(sources[0]?.stoppedAt).toBeUndefined();
    expect(gains[0]?.calls).toHaveLength(callsBefore ?? -1);
    // And it can start again on the new context.
    track.play();
    expect(sources).toHaveLength(2);
    expect(track.playing).toBe(true);
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
