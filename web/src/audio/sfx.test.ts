import { describe, expect, it } from 'vitest';
import { effectCues } from '../game/effect-cues';
import { MASTER_GAIN } from './engine';
import {
  createEffectsPlayer,
  EFFECT_GAIN,
  EFFECT_LENGTH_S,
  EFFECTS,
  EFFECTS_PEAK_BUDGET,
  FILL_FILTER_GAIN,
  type FillVoice,
  fillCutoffAt,
  fillLevelAt,
  MAX_EFFECT_VOICES,
  renderEffect,
  remainingPeaks,
  renderFillLoop,
  REPEAT_WINDOW_S,
  START_SLACK_S,
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

/** What the Effects bus reaches at the output: through the master gain at full volume. */
const atOutput = (busPeak: number, effectsVolume = 1) => busPeak * effectsVolume * MASTER_GAIN;

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
  buffer: { length: number; sampleRate: number; getChannelData: () => Float32Array } | null = null;
  /** The context's `currentTime` when it was created. */
  readonly createdAt: number;
  constructor(createdAt: number) {
    super();
    this.createdAt = createdAt;
  }
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
  const filters: (FakeNode & { type: string; Q: FakeParam; frequency: FakeParam })[] = [];
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
      const source = new FakeSource(context.currentTime);
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

// ---- the player's output, mixed from what it asked the fake context for ----

/** A fake param's value at `t`: `value`, then its set and linear/exponential ramps. */
function automation(param: FakeParam): (t: number) => number {
  let events: { kind: string; v: number; t: number }[] = [];
  for (const [kind, v = 0, t = 0] of param.calls) {
    if (kind === 'cancel') events = events.filter((e) => e.t < v);
    else events.push({ kind, v, t });
  }
  return (t) => {
    let previous = { t: -Infinity, v: param.value };
    for (const event of events) {
      if (t < event.t) {
        if (event.kind === 'set' || previous.t === -Infinity) return previous.v;
        const f = (t - previous.t) / (event.t - previous.t);
        return event.kind === 'exp'
          ? previous.v * (event.v / previous.v) ** f
          : previous.v + (event.v - previous.v) * f;
      }
      previous = event;
    }
    return previous.v;
  };
}

/** When a fake source stops sounding: its stop, or the end of its buffer. */
const endOf = (source: FakeSource) =>
  source.stoppedAt ??
  (source.loop || !source.buffer
    ? Infinity
    : Math.max(source.startArgs?.[0] ?? 0, source.createdAt) +
      source.buffer.length / source.buffer.sampleRate);

/**
 * What the fake context would have played, at its sample rate: every source from its
 * start, through its low-pass (a fill's: RBJ, as Web Audio computes it, the cutoff
 * swept) and its gain automation. Each voice is `delay()` s later than the player
 * thought, as when `currentTime` was stale.
 */
function mixPlayed(fake: ReturnType<typeof fakeContext>, delay: () => number = () => 0) {
  const { sampleRate } = fake.context;
  const voices = fake.sources.flatMap((source) => {
    if (!source.buffer || !source.startArgs) return [];
    const next = source.connected[0];
    const filter = fake.filters.find((f) => f === next);
    const gainNode = fake.gains.find((g) => g === (filter ? filter.connected[0] : next));
    if (!gainNode) return [];
    const start = Math.max(source.startArgs[0] ?? 0, source.createdAt);
    return [{ source, filter, gain: automation(gainNode.gain), start, at: start + delay() }];
  });
  const t0 = Math.min(...voices.map((v) => v.start));
  const end = Math.max(...voices.map((v) => endOf(v.source) + (v.at - v.start)));
  const out = new Float32Array(Math.ceil((end - t0) * sampleRate) + 1);
  for (const { source, filter, gain, start, at } of voices) {
    const data = source.buffer?.getChannelData() ?? new Float32Array();
    const cutoff = filter && automation(filter.frequency);
    const resonance = filter ? 10 ** (filter.Q.value / 20) : 1;
    let [x1, x2, y1, y2, b0, b1, a1, a2] = [0, 0, 0, 0, 0, 0, 0, 0];
    const first = Math.round((at - t0) * sampleRate);
    const stop = endOf(source);
    for (let n = 0; ; n += 1) {
      // The time the player scheduled this sample for.
      const t = start + n / sampleRate;
      if (t >= stop || (!source.loop && n >= data.length)) break;
      let x = data[n % data.length] ?? 0;
      if (cutoff) {
        if (n % 128 === 0) {
          // New coefficients each render quantum: the sweep is slow.
          const w0 = (2 * Math.PI * cutoff(t)) / sampleRate;
          const alpha = Math.sin(w0) / (2 * resonance);
          const cos = Math.cos(w0);
          [b0, b1, a1, a2] = [(1 - cos) / 2, 1 - cos, -2 * cos, 1 - alpha].map(
            (c) => c / (1 + alpha),
          ) as [number, number, number, number];
        }
        const y = b0 * (x + x2) + b1 * x1 - a1 * y1 - a2 * y2;
        [x2, x1, y2, y1] = [x1, x, y1, y];
        x = y;
      }
      const k = first + n;
      if (k < out.length) out[k] = (out[k] ?? 0) + x * gain(t);
    }
  }
  return out;
}

/** A player on a fake context, and a clock that ends each voice when it would. */
function driven(sampleRate = 48000) {
  const fake = fakeContext(sampleRate);
  const player = createEffectsPlayer({
    context: fake.context as unknown as BaseAudioContext,
    output: {} as AudioNode,
  });
  const wait = (seconds: number) => {
    fake.context.currentTime += seconds;
    for (const source of fake.sources) {
      if (endOf(source) <= fake.context.currentTime) source.end();
    }
  };
  const judge = (event: Parameters<typeof effectCues>[0]) => {
    for (const effect of effectCues(event, 'tiles').oneShots) player.play(effect);
  };
  return { fake, player, wait, judge };
}

/** Seeded uniform [0, 1) (mulberry32), so a failing search can be replayed. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

describe('headroom', () => {
  it('keeps the budget under full scale through the master gain', () => {
    expect(EFFECTS_PEAK_BUDGET * MASTER_GAIN).toBeLessThan(1);
    // Every one-shot alone fits, so a lone effect is never ducked.
    for (const effect of EFFECTS) {
      expect(EFFECT_GAIN[effect]).toBeLessThan(EFFECTS_PEAK_BUDGET);
    }
  });

  it('counts the peak still to come in a one-shot from every millisecond on', () => {
    for (const sampleRate of RATES) {
      for (const effect of EFFECTS) {
        const data = renderEffect(effect, sampleRate);
        const tail = remainingPeaks(data, sampleRate);
        expect(tail[0]).toBe(peakOf(data));
        for (let i = 0; i < data.length; i += 1) {
          const ms = Math.floor((i * 1000) / sampleRate);
          expect(Math.abs(data[i] ?? 0)).toBeLessThanOrEqual(tail[ms] ?? 0);
        }
        for (let k = 1; k < tail.length; k += 1) {
          expect(tail[k]).toBeLessThanOrEqual(tail[k - 1] ?? 0);
        }
      }
    }
  });

  it('bounds the fill through its low-pass: no cutoff of the sweep overshoots more', () => {
    // The L1 norm of the RBJ low-pass's impulse response (Web Audio's, Q in dB) bounds
    // its output for any input of peak 1.
    for (const sampleRate of RATES) {
      for (let hz = fillCutoffAt(0); hz <= fillCutoffAt(1); hz *= 1.01) {
        const w0 = (2 * Math.PI * hz) / sampleRate;
        const alpha = Math.sin(w0) / (2 * 10 ** (-3 / 20));
        const cos = Math.cos(w0);
        let [x1, x2, y1, y2, norm] = [0, 0, 0, 0, 0];
        for (let n = 0; n < 4000; n += 1) {
          const x = n === 0 ? 1 : 0;
          const y =
            (((1 - cos) / 2) * (x + x2) + (1 - cos) * x1 + 2 * cos * y1 - (1 - alpha) * y2) /
            (1 + alpha);
          [x2, x1, y2, y1] = [x1, x, y1, y];
          norm += Math.abs(y);
        }
        expect(norm).toBeLessThanOrEqual(FILL_FILTER_GAIN);
      }
    }
  });

  it('plays a fast pile-up under full scale (the round-1 counterexample)', () => {
    // A tap reaches combo 50; 5120 samples later a held tile completes, another is
    // tapped and an empty press misses. At round 1 this reached +1.07 dBFS.
    const { fake, wait, judge } = driven();
    judge({ unit: 'tap', judgment: 'clear', combo: 50 });
    wait(5120 / 48000);
    judge({ unit: 'tail', judgment: 'clear', combo: 51 });
    judge({ unit: 'tap', judgment: 'clear', combo: 52 });
    judge({ unit: 'empty', judgment: 'miss', combo: 0 });
    expect(atOutput(peakOf(mixPlayed(fake)))).toBeLessThan(1);
    // The ones already sounding and the newcomers that fit keep their level. The miss,
    // last in, would play 21 dB down under them, so it is dropped.
    expect(fake.sources).toHaveLength(6);
    expect(fake.gains.every((node) => node.gain.value === 1)).toBe(true);
  });

  it('ducks no one-shot by 1 dB on a fast run: 20 tiles a second, doubles, long tiles, a combo', () => {
    const { fake, player, wait, judge } = driven();
    for (let n = 0; n < 60; n += 1) {
      judge({ unit: 'tap', judgment: 'clear', combo: n === 30 ? 50 : n + 1 });
      if (n % 4 === 0) {
        // A double: the second finger a few ms later.
        wait(0.004);
        judge({ unit: 'tap', judgment: 'clear', combo: n + 1 });
      }
      if (n % 10 === 5) player.fill(0.45);
      if (n % 10 === 4) judge({ unit: 'tail', judgment: 'clear', combo: n + 1 });
      wait(n % 4 === 0 ? 0.046 : 0.05);
    }
    // A one-shot's duck is its gain's value (a fill's is in its automation). One is
    // ducked, by 0.6 dB: a completion on a fill, at the end of the combo.
    const ducks = fake.gains.map((node) => node.gain.value).filter((level) => level < 1);
    expect(Math.min(...ducks)).toBeGreaterThan(10 ** (-1 / 20));
    // At full Effects and master volume (measured: −3.0 dBFS).
    expect(atOutput(peakOf(mixPlayed(fake)))).toBeLessThan(0.75);
  });

  it('never clips, whatever plays when: a seeded search over full lifetimes', () => {
    // Judgments in any order and at any spacing, a combo on any of them, fills of any
    // length, each voice really starting up to START_SLACK_S late: more than the game
    // can produce. At full Effects and master volume.
    const units = ['tap', 'head', 'tail', 'empty'] as const;
    let worst = 0;
    for (let seed = 1; seed <= 100; seed += 1) {
      const next = random(seed);
      const { fake, player, wait, judge } = driven(seed % 2 ? 48000 : 44100);
      const fills: FillVoice[] = [];
      for (let n = 0; n < 40; n += 1) {
        const r = next();
        // Together, within a repeat window, or anywhere over the longest lifetime.
        wait(r < 0.3 ? 0 : r < 0.7 ? next() * 0.03 : next() * 0.3);
        const unit = units[Math.floor(next() * units.length)] ?? 'tap';
        const judgment = unit === 'empty' || next() < 0.25 ? 'miss' : 'clear';
        judge({ unit, judgment, combo: next() < 0.3 ? 50 : 1 });
        if (unit === 'head' && judgment === 'clear') {
          const when = fake.context.currentTime + next() * 0.3;
          fills.push(player.fill(0.1 + next() * 0.9, { when }));
        }
        if (unit === 'tail') fills.splice(Math.floor(next() * fills.length), 1)[0]?.stop();
      }
      worst = Math.max(worst, peakOf(mixPlayed(fake, () => next() * START_SLACK_S)));
    }
    // Measured: −2.0 dBFS. Without the budget this search finds +1.1 dBFS.
    expect(atOutput(worst)).toBeLessThan(1);
  }, 20_000);
});
