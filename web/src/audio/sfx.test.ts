import { describe, expect, it } from 'vitest';
import { MASTER_GAIN } from './engine';
import {
  createEffectsPlayer,
  EFFECT_GAIN,
  EFFECT_LENGTH_S,
  type Effect,
  EFFECTS,
  fillCutoffAt,
  fillLevelAt,
  MAX_EFFECT_VOICES,
  renderEffect,
  renderFillLoop,
  REPEAT_WINDOW_S,
  STEAL_FADE_S,
} from './sfx';

const RATES = [44100, 48000];

const peakOf = (data: Float32Array) => data.reduce((max, x) => Math.max(max, Math.abs(x)), 0);
const meanOf = (data: Float32Array) => data.reduce((sum, x) => sum + x, 0) / data.length;
const maxStep = (data: Float32Array) => {
  let step = 0;
  for (let i = 1; i < data.length; i += 1) {
    step = Math.max(step, Math.abs((data[i] ?? 0) - (data[i - 1] ?? 0)));
  }
  return step;
};

describe('renderEffect', () => {
  describe.each(RATES)('at %i Hz', (sampleRate) => {
    it.each(EFFECTS)('renders %s at its length and level, inside ±1', (effect) => {
      const data = renderEffect(effect, sampleRate);
      expect(data.length).toBe(Math.round(EFFECT_LENGTH_S[effect] * sampleRate));
      expect(peakOf(data)).toBeCloseTo(EFFECT_GAIN[effect], 6);
      expect(peakOf(data)).toBeLessThanOrEqual(1);
      expect(data.every((x) => Number.isFinite(x))).toBe(true);
    });

    it.each(EFFECTS)('renders %s with no DC offset and no click at either end', (effect) => {
      const data = renderEffect(effect, sampleRate);
      expect(Math.abs(meanOf(data))).toBeLessThan(1e-6);
      expect(Math.abs(data[0] ?? 1)).toBe(0);
      expect(Math.abs(data.at(-1) ?? 1)).toBe(0);
      // The edges ramp in and out: the first and last 0.1 ms stay near silence.
      const edge = Math.round(0.0001 * sampleRate);
      const limit = 0.1 * EFFECT_GAIN[effect];
      expect(peakOf(data.subarray(0, edge))).toBeLessThan(limit);
      expect(peakOf(data.subarray(data.length - edge))).toBeLessThan(limit);
    });
  });

  it('renders the same samples every time', () => {
    for (const effect of EFFECTS) {
      expect(renderEffect(effect, 48000)).toEqual(renderEffect(effect, 48000));
    }
  });

  it('keeps the tap short, so it never covers the note', () => {
    expect(EFFECT_LENGTH_S.tap).toBeLessThanOrEqual(0.06);
    expect(EFFECT_LENGTH_S.tap).toBeGreaterThanOrEqual(0.03);
  });

  it('makes the long tile completion a bigger clear', () => {
    expect(EFFECT_LENGTH_S.complete).toBeGreaterThan(EFFECT_LENGTH_S.clear);
    expect(EFFECT_GAIN.complete).toBeGreaterThan(EFFECT_GAIN.clear);
  });
});

describe('renderFillLoop', () => {
  it.each(RATES)('is 2 s of noise at %i Hz, peak 1, with no DC offset', (sampleRate) => {
    const data = renderFillLoop(sampleRate);
    expect(data.length).toBe(2 * sampleRate);
    expect(peakOf(data)).toBeCloseTo(1, 6);
    expect(Math.abs(meanOf(data))).toBeLessThan(1e-6);
  });

  it('loops without a seam: the wrap is no bigger a step than any inside it', () => {
    const data = renderFillLoop(48000);
    const wrap = Math.abs((data[0] ?? 0) - (data.at(-1) ?? 0));
    expect(wrap).toBeLessThanOrEqual(maxStep(data));
  });

  it('brightens and grows as the long tile fills, and stays the quietest effect', () => {
    expect(fillCutoffAt(1)).toBeGreaterThan(fillCutoffAt(0.5));
    expect(fillCutoffAt(0.5)).toBeGreaterThan(fillCutoffAt(0));
    expect(fillLevelAt(1)).toBeGreaterThan(fillLevelAt(0));
    expect(fillLevelAt(1)).toBe(EFFECT_GAIN.fill);
    expect(EFFECT_GAIN.fill).toBeLessThan(Math.min(...EFFECTS.map((e) => EFFECT_GAIN[e])));
  });
});

/**
 * The Effects bus, mixed offline the way the player plays it: the repeat window,
 * the voice cap and the steal fade applied. `at` in seconds.
 */
const MIX_RATE = 48000;
const rendered = new Map(EFFECTS.map((effect) => [effect, renderEffect(effect, MIX_RATE)]));

function mixRun(cues: readonly { at: number; effect: Effect }[]) {
  const sampleRate = MIX_RATE;
  const end = Math.max(...cues.map(({ at, effect }) => at + EFFECT_LENGTH_S[effect])) + 0.01;
  const out = new Float32Array(Math.ceil(end * sampleRate));
  const voices: { effect: Effect; at: number; stopAt: number }[] = [];
  for (const { at, effect } of [...cues].sort((a, b) => a.at - b.at)) {
    const live = voices.filter(
      (v) => v.stopAt === Infinity && at < v.at + EFFECT_LENGTH_S[v.effect],
    );
    if (live.some((v) => v.effect === effect && at - v.at < REPEAT_WINDOW_S)) continue;
    if (live.length >= MAX_EFFECT_VOICES) {
      const oldest = live.reduce((a, b) => (b.at < a.at ? b : a));
      oldest.stopAt = at + STEAL_FADE_S;
    }
    voices.push({ effect, at, stopAt: Infinity });
  }
  for (const { effect, at, stopAt } of voices) {
    const data = rendered.get(effect) ?? new Float32Array();
    const offset = Math.round(at * sampleRate);
    for (let i = 0; i < data.length; i += 1) {
      const t = at + i / sampleRate;
      if (t >= stopAt) break;
      const fade = stopAt === Infinity ? 1 : Math.min(1, (stopAt - t) / STEAL_FADE_S);
      const k = offset + i;
      out[k] = (out[k] ?? 0) + (data[i] ?? 0) * fade;
    }
  }
  return out;
}

/** What the Effects bus reaches at the output: through the master gain at full volume. */
const atOutput = (busPeak: number, effectsVolume = 1) => busPeak * effectsVolume * MASTER_GAIN;

describe('headroom', () => {
  it('stays far below full scale on a fast run: 20 tiles a second, doubles, a combo', () => {
    const cues: { at: number; effect: Effect }[] = [];
    for (let n = 0; n < 60; n += 1) {
      const at = n / 20;
      cues.push({ at, effect: 'tap' }, { at, effect: 'clear' });
      // A double: the second finger a few ms later.
      if (n % 4 === 0)
        cues.push({ at: at + 0.004, effect: 'tap' }, { at: at + 0.004, effect: 'clear' });
      if (n % 10 === 9) cues.push({ at: at + 0.02, effect: 'complete' });
    }
    cues.push({ at: 1.5, effect: 'combo' }, { at: 3, effect: 'miss' }, { at: 3, effect: 'miss' });
    // At full Effects and master volume: under −4.4 dBFS (measured: −5.5).
    expect(atOutput(peakOf(mixRun(cues)))).toBeLessThan(0.6);
  });

  it('never clips, even with every effect starting within the repeat window', () => {
    // The worst there can be: each one-shot once (the repeat window stops a second),
    // at full Effects and master volume, at many relative offsets.
    const steps = [0, 0.005, 0.01, 0.02, REPEAT_WINDOW_S];
    let worst = 0;
    const [first, ...others] = EFFECTS;
    const offsets = (k: number): number[][] =>
      k === 0 ? [[]] : offsets(k - 1).flatMap((rest) => steps.map((at) => [...rest, at]));
    for (const ats of offsets(others.length)) {
      const cues = [
        { at: 0, effect: first },
        ...others.map((effect, k) => ({ at: ats[k] ?? 0, effect })),
      ];
      worst = Math.max(worst, peakOf(mixRun(cues)));
    }
    expect(atOutput(worst)).toBeLessThan(1);
  });

  it('keeps everything at once under full scale at the default Effects volume', () => {
    // A bound, not a mix: every one-shot and a fill at their peaks in the same sample.
    const sum = EFFECTS.reduce((total, effect) => total + EFFECT_GAIN[effect], EFFECT_GAIN.fill);
    expect(atOutput(sum, 0.7)).toBeLessThan(1);
  });
});

// ---- the player, on a fake context ----

class FakeParam {
  value = 1;
  readonly calls: [string, ...number[]][] = [];
  setValueAtTime(v: number, t: number) {
    this.calls.push(['set', v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(['ramp', v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(['exp', v, t]);
  }
  cancelScheduledValues(t: number) {
    this.calls.push(['cancel', t]);
  }
}

class FakeNode {
  readonly connected: unknown[] = [];
  connect<T>(node: T) {
    this.connected.push(node);
    return node;
  }
  disconnect() {
    /* nothing to release */
  }
}

class FakeSource extends FakeNode {
  buffer: { length: number; sampleRate: number } | null = null;
  loop = false;
  onended: (() => void) | null = null;
  startArgs: number[] | undefined;
  stoppedAt: number | undefined;
  start(...args: number[]) {
    this.startArgs = args;
  }
  stop(t: number) {
    // As in Web Audio, the last call to stop() is the one that applies.
    this.stoppedAt = t;
  }
  end() {
    this.onended?.();
  }
}

function fakeContext(sampleRate = 48000) {
  const sources: FakeSource[] = [];
  const gains: { gain: FakeParam }[] = [];
  const filters: { type: string; Q: FakeParam; frequency: FakeParam }[] = [];
  const created: number[] = [];
  const context = {
    sampleRate,
    state: 'running' as AudioContextState,
    currentTime: 10,
    createBuffer: (_channels: number, length: number, rate: number) => {
      created.push(length);
      const data = new Float32Array(length);
      return { length, sampleRate: rate, getChannelData: () => data };
    },
    createBufferSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    createGain: () => {
      const node = Object.assign(new FakeNode(), { gain: new FakeParam() });
      gains.push(node);
      return node;
    },
    createBiquadFilter: () => {
      const node = Object.assign(new FakeNode(), {
        type: 'lowpass',
        Q: new FakeParam(),
        frequency: new FakeParam(),
      });
      filters.push(node);
      return node;
    },
  };
  return { context, sources, gains, filters, created };
}

function setup() {
  const fake = fakeContext();
  const target = {
    context: fake.context as unknown as BaseAudioContext,
    output: { label: 'effects submix' } as unknown as AudioNode,
  };
  return { ...fake, target, player: createEffectsPlayer(target) };
}

describe('createEffectsPlayer', () => {
  it('plays an effect at once, never scheduled, into the Effects submix', () => {
    const { player, sources, gains, target } = setup();
    player.play('tap');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.startArgs).toEqual([0]);
    expect(sources[0]?.buffer?.length).toBe(Math.round(EFFECT_LENGTH_S.tap * 48000));
    expect(sources[0]?.connected).toEqual([gains[0]]);
    expect((gains[0] as unknown as FakeNode).connected).toEqual([target.output]);
    expect(player.activeVoices()).toBe(1);
  });

  it('renders each buffer once, and prepare() renders them all ahead of the first tap', () => {
    const { player, created } = setup();
    player.prepare();
    expect(created).toHaveLength(EFFECTS.length + 1);
    player.play('tap');
    player.play('miss');
    player.fill(1);
    expect(created).toHaveLength(EFFECTS.length + 1);
  });

  it('plays the same effect once within the repeat window, and again after it', () => {
    const { player, sources, context } = setup();
    player.play('tap');
    context.currentTime += REPEAT_WINDOW_S / 2;
    player.play('tap');
    player.play('clear');
    expect(sources).toHaveLength(2);
    context.currentTime += REPEAT_WINDOW_S;
    player.play('tap');
    expect(sources).toHaveLength(3);
  });

  it('plays nothing while the context is not running, and queues nothing for later', () => {
    const { player, sources, context } = setup();
    context.state = 'suspended';
    player.play('tap');
    player.fill(2).stop();
    context.state = 'interrupted';
    player.play('miss');
    expect(sources).toHaveLength(0);
    context.state = 'running';
    player.play('clear');
    expect(sources).toHaveLength(1);
  });

  it(`keeps ${MAX_EFFECT_VOICES} voices at most, fading the oldest out`, () => {
    const { player, sources, gains, context } = setup();
    for (let n = 0; n < MAX_EFFECT_VOICES + 1; n += 1) {
      player.play(n % 2 === 0 ? 'clear' : 'tap');
      context.currentTime += REPEAT_WINDOW_S;
    }
    expect(player.activeVoices()).toBe(MAX_EFFECT_VOICES);
    const stealAt = 10 + MAX_EFFECT_VOICES * REPEAT_WINDOW_S;
    expect(sources[0]?.stoppedAt).toBeCloseTo(stealAt + STEAL_FADE_S, 9);
    expect(gains[0]?.gain.calls.at(-1)?.[1]).toBe(0);
    expect(sources[1]?.stoppedAt).toBeUndefined();
  });

  it('starts a fill when asked, opening its low-pass and raising its level to the end', () => {
    const { player, sources, filters, gains } = setup();
    player.fill(2, { when: 10.5 });
    const source = sources[0];
    expect(source?.loop).toBe(true);
    expect(source?.startArgs).toEqual([10.5]);
    expect(source?.stoppedAt).toBe(12.5);
    expect(filters[0]?.type).toBe('lowpass');
    expect(filters[0]?.frequency.calls).toEqual([
      ['set', fillCutoffAt(0), 10.5],
      ['exp', fillCutoffAt(1), 12.5],
    ]);
    const ramps = gains[0]?.gain.calls ?? [];
    expect(ramps[0]).toEqual(['set', 0, 10.5]);
    expect(ramps.at(-1)).toEqual(['ramp', 0, 12.5]);
    expect(Math.max(...ramps.map(([, v]) => v ?? 0))).toBeLessThanOrEqual(EFFECT_GAIN.fill);
  });

  it('picks a fill up part way through, from where it had got to', () => {
    const { player, sources, filters } = setup();
    player.fill(2, { offsetS: 1.5 });
    expect(sources[0]?.startArgs).toEqual([10]);
    expect(sources[0]?.stoppedAt).toBe(10.5);
    expect(filters[0]?.frequency.calls[0]).toEqual(['set', fillCutoffAt(0.75), 10]);
  });

  it('plays nothing for a fill already over', () => {
    const { player, sources } = setup();
    player.fill(1, { offsetS: 1 }).stop();
    expect(sources).toHaveLength(0);
  });

  it('fades a fill out when its long tile is let go, from the level it is at', () => {
    const { player, sources, gains, context } = setup();
    const fill = player.fill(2);
    context.currentTime = 11;
    fill.stop();
    expect(sources[0]?.stoppedAt).toBeCloseTo(11.02, 9);
    const calls = gains[0]?.gain.calls ?? [];
    expect(calls.at(-3)).toEqual(['cancel', 11]);
    const [, level] = calls.at(-2) ?? [];
    expect(level).toBeGreaterThan(fillLevelAt(0));
    expect(level).toBeLessThan(fillLevelAt(1));
    expect(calls.at(-1)).toEqual(['ramp', 0, 11.02]);
  });

  it('never sounds a fill stopped before its start', () => {
    const { player, sources } = setup();
    player.fill(2, { when: 11 }).stop();
    expect(sources[0]?.stoppedAt).toBe(11);
  });

  it('counts fills under the same cap', () => {
    const { player, sources, context } = setup();
    for (let n = 0; n < MAX_EFFECT_VOICES; n += 1) {
      player.fill(3);
      context.currentTime += 0.1;
    }
    player.play('tap');
    expect(sources[0]?.stoppedAt).toBeCloseTo(10 + MAX_EFFECT_VOICES * 0.1 + STEAL_FADE_S, 9);
    expect(sources[1]?.stoppedAt).toBe(13.1);
  });

  it('stops only the fills on stopFills, and everything on stopAll', () => {
    const { player, sources } = setup();
    player.play('miss');
    player.fill(2);
    player.stopFills(120);
    expect(sources[0]?.stoppedAt).toBeUndefined();
    expect(sources[1]?.stoppedAt).toBeCloseTo(10.12, 9);
    player.stopAll(30);
    expect(sources[0]?.stoppedAt).toBeCloseTo(10.03, 9);
    expect(player.activeVoices()).toBe(0);
  });

  it('forgets a voice when it ends', () => {
    const { player, sources } = setup();
    player.play('tap');
    sources[0]?.end();
    expect(player.activeVoices()).toBe(0);
  });

  it('keeps its buffers for a recreated context, and drops the old voices', () => {
    const { player, sources, target, created } = setup();
    player.play('tap');
    const next = fakeContext();
    Object.assign(target, { context: next.context });
    player.reset();
    expect(player.activeVoices()).toBe(0);
    player.play('tap');
    expect(next.sources[0]?.buffer).toBe(sources[0]?.buffer);
    expect(created).toHaveLength(1);
    expect(next.created).toHaveLength(0);
  });
});
