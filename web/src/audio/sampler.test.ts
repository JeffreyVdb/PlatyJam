import { describe, expect, it } from 'vitest';
import {
  createSampler,
  MAX_VOICES,
  RELEASE_S,
  RESTRIKE_FADE_S,
  TAIL_FADE_S,
  velocityGain,
} from './sampler';

interface AutomationEvent {
  type: 'set' | 'ramp';
  v: number;
  t: number;
}

/**
 * Records automation calls the way the sampler issues them, and keeps the event
 * list as Web Audio does, so `valueAt` gives the gain the listener would hear.
 */
class FakeParam {
  value = 1;
  readonly calls: [string, ...number[]][] = [];
  events: AutomationEvent[] = [];
  setValueAtTime(v: number, t: number) {
    this.calls.push(['set', v, t]);
    this.insert({ type: 'set', v, t });
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(['ramp', v, t]);
    this.insert({ type: 'ramp', v, t });
  }
  cancelScheduledValues(t: number) {
    this.calls.push(['cancel', t]);
    this.events = this.events.filter((event) => event.t < t);
  }
  /** set holds its value until the next event; a ramp interpolates from the event before it. */
  valueAt(t: number): number {
    let previous: AutomationEvent | undefined;
    for (const event of this.events) {
      if (event.t > t) {
        if (event.type === 'set') break;
        const from = previous ?? { v: this.value, t };
        return from.v + ((event.v - from.v) * (t - from.t)) / (event.t - from.t);
      }
      previous = event;
    }
    return previous?.v ?? this.value;
  }
  private insert(event: AutomationEvent) {
    const at = this.events.findIndex((other) => other.t > event.t);
    if (at === -1) this.events.push(event);
    else this.events.splice(at, 0, event);
  }
}

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  startedAt: number | undefined;
  stoppedAt: number | undefined;
  connect<T>(node: T) {
    return node;
  }
  disconnect() {
    /* nothing to release */
  }
  start(t: number) {
    this.startedAt = t;
  }
  stop(t: number) {
    this.stoppedAt = t;
  }
}

function setup() {
  const sources: FakeSource[] = [];
  const gains: FakeParam[] = [];
  const context = {
    currentTime: 10,
    createBufferSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    createGain: () => {
      const gain = new FakeParam();
      gains.push(gain);
      return { gain, connect: <T>(node: T) => node, disconnect: () => undefined };
    },
  };
  const buffer = { duration: 3 } as AudioBuffer;
  const buffers = new Map<number, AudioBuffer>();
  for (let midi = 21; midi <= 108; midi += 1) buffers.set(midi, buffer);
  const target = { context: context as unknown as BaseAudioContext, output: {} as AudioNode };
  const sampler = createSampler({ target, buffers });
  return { context, sources, gains, sampler, buffers };
}

describe('velocityGain', () => {
  it('follows a squared curve, so soft notes are clearly softer', () => {
    expect(velocityGain(127)).toBe(1);
    expect(velocityGain(64)).toBeCloseTo(0.254, 3);
    expect(velocityGain(0)).toBeGreaterThan(0);
    expect(velocityGain(500)).toBe(1);
  });
});

describe('createSampler', () => {
  it('starts a hit immediately at currentTime, with the velocity as its level', () => {
    const { sources, gains, sampler } = setup();
    expect(sampler.noteOn(60, 127)).not.toBeNull();
    expect(sources[0]?.startedAt).toBe(10);
    expect(gains[0]?.calls[0]).toEqual(['set', 1, 10]);
  });

  it('fades the last 40 ms of the 3 s sample so a long hold never clicks', () => {
    const { gains, sampler } = setup();
    sampler.noteOn(60, 127, 12);
    expect(gains[0]?.calls).toEqual([
      ['set', 1, 12],
      ['set', 1, 15 - TAIL_FADE_S],
      ['ramp', 0, 15],
    ]);
  });

  it('releases a held note from its current level over the release time, then stops it', () => {
    const { context, sources, gains, sampler } = setup();
    const voice = sampler.noteOn(60, 127);
    if (!voice) throw new Error('no voice');
    context.currentTime = 11;
    sampler.noteOff(voice);
    expect(gains[0]?.calls.slice(3)).toEqual([
      ['cancel', 11],
      ['ramp', 1, 11],
      ['ramp', 0, 11 + RELEASE_S],
    ]);
    expect(sources[0]?.stoppedAt).toBeCloseTo(11 + RELEASE_S, 9);
  });

  it('schedules a release at a future time for accompaniment notes', () => {
    const { sources, sampler } = setup();
    const voice = sampler.noteOn(60, 127, 10.5);
    if (!voice) throw new Error('no voice');
    sampler.noteOff(voice, 11);
    expect(sources[0]?.startedAt).toBe(10.5);
    expect(sources[0]?.stoppedAt).toBeCloseTo(11 + RELEASE_S, 9);
  });

  it('releases the previous voice of a pitch when it is struck again', () => {
    const { context, sources, sampler } = setup();
    sampler.noteOn(60, 100);
    sampler.noteOn(62, 100);
    context.currentTime = 10.5;
    sampler.noteOn(60, 100);
    expect(sources[0]?.stoppedAt).toBeGreaterThan(10.5);
    expect(sources[0]?.stoppedAt).toBeLessThan(10.5 + RELEASE_S);
    expect(sources[1]?.stoppedAt).toBeUndefined();
    // The released voice still sounds until its fade ends.
    expect(sampler.activeVoices()).toBe(3);
  });

  it('keeps a pending release ramp when the pitch is struck again inside it', () => {
    const { gains, sampler } = setup();
    const voice = sampler.noteOn(60, 127);
    if (!voice) throw new Error('no voice');
    // Released at 10.5: 1 → 0 by 10.75. Struck again at 10.6, when the gain is 0.6.
    sampler.noteOff(voice, 10.5);
    sampler.noteOn(60, 127, 10.6);
    const gain = gains[0];
    if (!gain) throw new Error('no gain');
    expect(gain.calls.slice(-3)).toEqual([
      ['cancel', 10.6],
      ['ramp', expect.closeTo(0.6, 9), 10.6],
      ['ramp', 0, expect.closeTo(10.6 + RESTRIKE_FADE_S, 9)],
    ]);
    // The first release still runs up to the re-strike: no step, no click.
    expect(gain.valueAt(10.5)).toBeCloseTo(1, 9);
    expect(gain.valueAt(10.55)).toBeCloseTo(0.8, 9);
    expect(gain.valueAt(10.6 - 1e-6)).toBeCloseTo(0.6, 5);
    expect(gain.valueAt(10.64)).toBeCloseTo(0.3, 9);
    expect(gain.valueAt(10.7)).toBe(0);
  });

  it('releases inside the tail fade from the fading level, on the same line', () => {
    const { gains, sampler } = setup();
    const voice = sampler.noteOn(60, 127);
    if (!voice) throw new Error('no voice');
    // The tail fade runs 12.96 → 13; release half-way through it.
    sampler.noteOff(voice, 12.98);
    const gain = gains[0];
    if (!gain) throw new Error('no gain');
    expect(gain.valueAt(12.97)).toBeCloseTo(0.75, 9);
    expect(gain.valueAt(12.98)).toBeCloseTo(0.5, 9);
    expect(gain.valueAt(12.99)).toBeCloseTo(0.25, 9);
    expect(gain.valueAt(13)).toBe(0);
  });

  it('fades from the level of an earlier release when stopping everything', () => {
    const { context, gains, sampler } = setup();
    const voice = sampler.noteOn(60, 127);
    if (!voice) throw new Error('no voice');
    sampler.noteOff(voice, 10.5);
    context.currentTime = 10.625;
    sampler.stopAll(50);
    const gain = gains[0];
    if (!gain) throw new Error('no gain');
    expect(gain.valueAt(10.6)).toBeCloseTo(0.6, 9);
    expect(gain.valueAt(10.625)).toBeCloseTo(0.5, 9);
    expect(gain.valueAt(10.65)).toBeCloseTo(0.25, 9);
    expect(gain.valueAt(10.675)).toBe(0);
  });

  it(`steals the oldest voice with a fast fade beyond ${MAX_VOICES} voices`, () => {
    const { context, sources, sampler } = setup();
    for (let i = 0; i < MAX_VOICES; i += 1) {
      context.currentTime = 10 + i * 0.01;
      sampler.noteOn(21 + i, 100);
    }
    expect(sampler.activeVoices()).toBe(MAX_VOICES);
    context.currentTime = 11;
    sampler.noteOn(100, 100);
    expect(sampler.activeVoices()).toBe(MAX_VOICES);
    expect(sources[0]?.stoppedAt).toBeCloseTo(11.02, 2);
    expect(sources[1]?.stoppedAt).toBeUndefined();
  });

  it('stopAll reaches playing and not-yet-started voices', () => {
    const { context, sources, sampler } = setup();
    sampler.noteOn(60, 100);
    sampler.noteOn(64, 100, 10.08);
    context.currentTime = 10.05;
    sampler.stopAll(30);
    expect(sources[0]?.stoppedAt).toBeCloseTo(10.08, 9);
    // Stopped before it starts: it never sounds.
    expect(sources[1]?.stoppedAt).toBeLessThanOrEqual(10.08);
    expect(sampler.activeVoices()).toBe(0);
  });

  it('returns null for a pitch without a loaded sample', () => {
    const { sampler, buffers } = setup();
    buffers.delete(60);
    expect(sampler.noteOn(60, 100)).toBeNull();
    expect(sampler.noteOn(12, 100)).toBeNull();
  });

  it('forgets voices of a context that was replaced', () => {
    const { sampler } = setup();
    sampler.noteOn(60, 100);
    sampler.reset();
    expect(sampler.activeVoices()).toBe(0);
  });

  it('removes a voice once its source has ended', () => {
    const { sources, sampler } = setup();
    sampler.noteOn(60, 100);
    sources[0]?.onended?.();
    expect(sampler.activeVoices()).toBe(0);
  });
});
