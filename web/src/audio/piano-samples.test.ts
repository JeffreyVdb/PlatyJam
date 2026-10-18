import { describe, expect, it, vi } from 'vitest';
import { loadPianoSamples, noteName, PIANO_RANGE, pianoSampleUrl } from './piano-samples';

describe('noteName', () => {
  it('names MIDI notes the way the FluidR3 files are named (flats only)', () => {
    expect(noteName(21)).toBe('A0');
    expect(noteName(22)).toBe('Bb0');
    expect(noteName(24)).toBe('C1');
    expect(noteName(60)).toBe('C4');
    expect(noteName(61)).toBe('Db4');
    expect(noteName(66)).toBe('Gb4');
    expect(noteName(68)).toBe('Ab4');
    expect(noteName(108)).toBe('C8');
  });

  it('covers the 88 keys', () => {
    expect(PIANO_RANGE).toEqual({ low: 21, high: 108 });
  });
});

describe('pianoSampleUrl', () => {
  it('builds the URL under the app base', () => {
    expect(pianoSampleUrl('/PlatyJam/', 61)).toBe(
      '/PlatyJam/soundfonts/fluidr3-gm/acoustic_grand_piano/Db4.mp3',
    );
    expect(pianoSampleUrl('/', 21)).toBe('/soundfonts/fluidr3-gm/acoustic_grand_piano/A0.mp3');
  });
});

describe('loadPianoSamples', () => {
  const okResponse = (url: string) =>
    ({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(url).buffer),
    }) as Response;

  it('fetches every key with at most `concurrency` requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetch = vi.fn(async (url: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return okResponse(url);
    });
    const decode = vi.fn((data: ArrayBuffer) =>
      Promise.resolve({ duration: data.byteLength } as AudioBuffer),
    );
    const progress = vi.fn();

    const result = await loadPianoSamples({
      base: '/',
      fetch,
      decode,
      concurrency: 6,
      onProgress: progress,
    });

    expect(fetch).toHaveBeenCalledTimes(88);
    expect(peak).toBe(6);
    expect(result.buffers.size).toBe(88);
    expect(result.failed).toEqual([]);
    expect(progress).toHaveBeenLastCalledWith({ loaded: 88, failed: 0, total: 88 });
  });

  it('carries on past failures and reports them (offline)', async () => {
    const fetch = vi.fn((url: string) =>
      url.endsWith('/C4.mp3')
        ? Promise.reject(new TypeError('Failed to fetch'))
        : url.endsWith('/D4.mp3')
          ? Promise.resolve({ ok: false, status: 404 } as Response)
          : Promise.resolve(okResponse(url)),
    );
    const decode = (data: ArrayBuffer) =>
      new TextDecoder().decode(data).endsWith('/E4.mp3')
        ? Promise.reject(new DOMException('bad data', 'EncodingError'))
        : Promise.resolve({} as AudioBuffer);

    const result = await loadPianoSamples({ base: '/', fetch, decode });

    expect(result.failed.sort()).toEqual([60, 62, 64]);
    expect(result.buffers.size).toBe(85);
    expect(result.buffers.has(60)).toBe(false);
  });
});
