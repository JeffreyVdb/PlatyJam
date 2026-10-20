import { describe, expect, it } from 'vitest';
import { effectCues } from '../game/effect-cues';
import { createTilesSimulation } from '../game/tiles-simulation';
import { MASTER_GAIN } from './engine';
import {
  createEffectsPlayer,
  EFFECT_GAIN,
  EFFECT_LENGTH_S,
  EFFECTS,
  type Effect,
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
  TAP_RESERVE,
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
  loop = false;
  onended: (() => void) | null = null;
  startArgs: number[] | undefined;
  /** Context seconds it really starts: when asked, or when the render gets to it if later. */
  playsAt = Infinity;
  stoppedAt: number | undefined;
  readonly #renderTime: () => number;
  #ended = false;
  constructor(renderTime: () => number) {
    super();
    this.#renderTime = renderTime;
  }
  start(...args: number[]) {
    this.startArgs = args;
    this.playsAt = Math.max(args[0] ?? 0, this.#renderTime());
  }
  stop(t: number) {
    // As in Web Audio, the last call to stop() is the one that applies.
    this.stoppedAt = t;
  }
  end() {
    if (this.#ended) return;
    this.#ended = true;
    this.onended?.();
  }
}

/**
 * A fake context. `lag()` is how far the render is ahead of `currentTime` when it gets
 * a message (0 to `START_SLACK_S` in the search): a source started then really starts
 * at that render time, or later if asked to.
 */
function fakeContext(sampleRate = 48000, lag: () => number = () => 0) {
  const sources: FakeSource[] = [];
  const gains: { gain: FakeParam }[] = [];
  const filters: (FakeNode & { type: string; Q: FakeParam; frequency: FakeParam })[] = [];
  const created: number[] = [];
  let rendered = -Infinity;
  /** The render's time now: never behind `currentTime`, never going back. */
  const renderTime = () => (rendered = Math.max(rendered, context.currentTime + lag()));
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
      const source = new FakeSource(renderTime);
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
  return { context, sources, gains, filters, created, renderTime };
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

  it('counts fills under the same cap, and steals what yields first', () => {
    const { player, sources, context } = setup();
    for (let n = 0; n < 3; n += 1) {
      player.fill(3);
      context.currentTime += 0.1;
    }
    for (const effect of ['tap', 'clear', 'combo'] as const) player.play(effect);
    expect(player.activeVoices()).toBe(MAX_EFFECT_VOICES);
    context.currentTime += 0.05;
    // The combo yields first: the tap steals it, not the oldest.
    player.play('tap');
    expect(sources[5]?.stoppedAt).toBeCloseTo(10.35 + STEAL_FADE_S, 9);
    expect(sources[0]?.stoppedAt).toBe(13);
    expect(player.activeVoices()).toBe(MAX_EFFECT_VOICES);
  });

  it('makes room for a miss: fades the combo, then the clear, spares the fill, starts as they stop', () => {
    const { player, sources, gains } = setup();
    player.fill(2);
    player.play('combo');
    player.play('clear');
    player.play('miss');
    const [fill, combo, clear, miss] = sources;
    expect(combo?.stoppedAt).toBeCloseTo(10 + STEAL_FADE_S, 9);
    expect(clear?.stoppedAt).toBeCloseTo(10 + STEAL_FADE_S, 9);
    expect(gains[1]?.gain.calls.at(-1)).toEqual(['ramp', 0, 10 + STEAL_FADE_S]);
    expect(fill?.stoppedAt).toBe(12);
    expect(miss?.startArgs).toEqual([10 + STEAL_FADE_S]);
    expect(gains[3]?.gain.value).toBe(1);
  });

  it('plays a tap at once at its level, whatever else is playing', () => {
    const { player, sources, gains, context } = setup();
    player.fill(2);
    for (const effect of ['combo', 'clear', 'complete', 'miss'] as const) player.play(effect);
    context.currentTime += 0.005;
    player.play('tap');
    const tap = sources.at(-1);
    expect(tap?.startArgs).toEqual([0]);
    expect(gains.at(-1)?.gain.value).toBe(1);
  });

  it('plays a clear or combo that does not fit quieter, or not at all, and fades nothing', () => {
    const { player, sources, gains } = setup();
    player.play('miss');
    player.play('complete');
    player.play('clear');
    // 0.8 − 0.44 − 0.32 is left of the 0.24 the clear would need.
    expect(gains[2]?.gain.value).toBeCloseTo((EFFECTS_PEAK_BUDGET - TAP_RESERVE - 0.76) / 0.24, 6);
    player.play('combo');
    expect(sources).toHaveLength(3);
    expect(sources.every((source) => source.stoppedAt === undefined)).toBe(true);
  });

  it('shortens a fade that is already under way, never lengthens one', () => {
    const { player, sources, context } = setup();
    const fill = player.fill(2);
    context.currentTime = 10.5;
    fill.stop(500);
    player.stopAll(30);
    expect(sources[0]?.stoppedAt).toBeCloseTo(10.53, 9);
    fill.stop(100);
    expect(sources[0]?.stoppedAt).toBeCloseTo(10.53, 9);
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

/** When a fake source really falls silent: its stop, or the end of its buffer. */
const endOf = (source: FakeSource) => {
  const stop = source.stoppedAt ?? Infinity;
  if (source.loop || !source.buffer) return stop;
  return Math.min(stop, source.playsAt + source.buffer.length / source.buffer.sampleRate);
};

/** RBJ low-pass coefficients as Web Audio computes them (Q in dB): b0, b1 (b2 = b0), a1, a2. */
function lowpassAt(hz: number, qDb: number, sampleRate: number) {
  const w0 = (2 * Math.PI * hz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20));
  const cos = Math.cos(w0);
  return [(1 - cos) / 2, 1 - cos, -2 * cos, 1 - alpha].map((c) => c / (1 + alpha)) as [
    number,
    number,
    number,
    number,
  ];
}

/**
 * What the fake context would have played, at its sample rate, as Web Audio plays it:
 * each source from when it really started (`playsAt`), through its low-pass (a fill's,
 * its cutoff swept, new coefficients each render quantum) and its gain. Only the onset
 * moves with a late start: gain and cutoff automation and the stop keep their context
 * times.
 *
 * `inPhase` sums every voice's magnitude instead (a fill at its gain times
 * `FILL_FILTER_GAIN`): the most the bus could reach had every phase lined up, which is
 * what the budget bounds. `only` mixes some of the sources.
 */
function mixPlayed(
  fake: ReturnType<typeof fakeContext>,
  {
    inPhase = false,
    only = () => true,
  }: { inPhase?: boolean; only?: (source: FakeSource) => boolean } = {},
) {
  const { sampleRate } = fake.context;
  const voices = fake.sources.flatMap((source) => {
    if (!source.buffer || !source.startArgs || !only(source)) return [];
    const next = source.connected[0];
    const filter = fake.filters.find((f) => f === next);
    const gainNode = fake.gains.find((g) => g === (filter ? filter.connected[0] : next));
    if (!gainNode || endOf(source) <= source.playsAt) return [];
    return [{ source, filter, gain: automation(gainNode.gain), from: source.playsAt }];
  });
  if (voices.length === 0) return new Float32Array();
  const t0 = Math.min(...voices.map((v) => v.from));
  const end = Math.max(...voices.map((v) => endOf(v.source)));
  const out = new Float32Array(Math.ceil((end - t0) * sampleRate) + 2);
  for (const { source, filter, gain, from } of voices) {
    const data = source.buffer?.getChannelData() ?? new Float32Array();
    const cutoff = filter ? automation(filter.frequency) : undefined;
    const qDb = filter?.Q.value ?? 0;
    let [x1, x2, y1, y2, b0, b1, a1, a2] = [0, 0, 0, 0, 0, 0, 0, 0];
    const stop = endOf(source);
    for (let n = 0; ; n += 1) {
      const t = from + n / sampleRate;
      if (t >= stop || (!source.loop && n >= data.length)) break;
      let x = data[n % data.length] ?? 0;
      if (inPhase) {
        x = filter ? FILL_FILTER_GAIN : Math.abs(x);
      } else if (cutoff) {
        if (n === 0 || Math.round(t * sampleRate) % 128 === 0) {
          [b0, b1, a1, a2] = lowpassAt(cutoff(t), qDb, sampleRate);
        }
        const y = b0 * (x + x2) + b1 * x1 - a1 * y1 - a2 * y2;
        [x2, x1, y2, y1] = [x1, x, y1, y];
        x = y;
      }
      const k = Math.round((t - t0) * sampleRate);
      out[k] = (out[k] ?? 0) + x * (inPhase ? Math.abs(gain(t)) : gain(t));
    }
  }
  return out;
}

/** Effects that always play at their level: never ducked, never dropped. */
const GUARANTEED: readonly Effect[] = ['miss', 'complete', 'tap'];

interface Played {
  readonly effect: Effect;
  /** `currentTime` when it was asked for. */
  readonly at: number;
  /** The source it started, if any. */
  readonly source: FakeSource | undefined;
}

/**
 * A player on a fake context whose render runs `lag()` ahead, and a clock that ends
 * each voice when the render really gets past it. `play` and `judge` log what each
 * effect asked for started.
 */
function driven(sampleRate = 48000, lag?: () => number) {
  const fake = fakeContext(sampleRate, lag);
  const player = createEffectsPlayer({
    context: fake.context as unknown as BaseAudioContext,
    output: {} as AudioNode,
  });
  const played: Played[] = [];
  const wait = (seconds: number) => {
    fake.context.currentTime += seconds;
    const rendered = fake.renderTime();
    for (const source of fake.sources) {
      if (source.startArgs && endOf(source) <= rendered) source.end();
    }
  };
  const play = (effect: Effect) => {
    const before = fake.sources.length;
    player.play(effect);
    played.push({ effect, at: fake.context.currentTime, source: fake.sources[before] });
  };
  const judge = (event: Parameters<typeof effectCues>[0]) => {
    for (const effect of effectCues(event, 'tiles').oneShots) play(effect);
  };
  /** The gain a source started at, from its automation. */
  const levelOf = (source: FakeSource) => {
    const node = fake.gains.find((g) => g === source.connected[0]);
    return node ? automation(node.gain)(source.playsAt) : 0;
  };
  return { fake, player, wait, play, judge, played, levelOf };
}

/**
 * Every miss, completion and tap asked for played at its full level (a tap at once, a
 * miss or completion within `STEAL_FADE_S`, then for at least `REPEAT_WINDOW_S`), or
 * repeated one of its kind within the window. Returns how many did each.
 */
function expectGuaranteed({ played, levelOf }: ReturnType<typeof driven>) {
  const last = new Map<Effect, number>();
  let started = 0;
  let repeats = 0;
  for (const { effect, at, source } of played) {
    if (!GUARANTEED.includes(effect)) continue;
    if (!source) {
      expect(at - (last.get(effect) ?? -Infinity), `${effect} at ${at}`).toBeLessThan(
        REPEAT_WINDOW_S,
      );
      repeats += 1;
      continue;
    }
    started += 1;
    expect(levelOf(source), `${effect} at ${at}`).toBeCloseTo(1, 9);
    // When it was asked to start: at once (0), or later to make room.
    const asked = Math.max(at, source.startArgs?.[0] ?? 0);
    if (effect === 'tap') {
      expect(source.startArgs).toEqual([0]);
      expect(source.stoppedAt).toBeUndefined();
    } else {
      expect(asked - at).toBeLessThanOrEqual(STEAL_FADE_S + 1e-9);
      expect((source.stoppedAt ?? Infinity) - asked).toBeGreaterThanOrEqual(REPEAT_WINDOW_S - 1e-9);
    }
    last.set(effect, asked);
  }
  return { started, repeats };
}

/**
 * Mixes what a run played, and checks the budget held at every sample with every phase
 * lined up: taps within `TAP_RESERVE`, the rest within the remainder. Returns the
 * real mix's peak, at the output at full Effects and master volume.
 */
function expectWithinBudget({ fake, played }: ReturnType<typeof driven>) {
  const taps = new Set(
    played.flatMap(({ effect, source }) => (effect === 'tap' && source ? [source] : [])),
  );
  const tapPeak = peakOf(mixPlayed(fake, { inPhase: true, only: (source) => taps.has(source) }));
  const restPeak = peakOf(mixPlayed(fake, { inPhase: true, only: (source) => !taps.has(source) }));
  expect(tapPeak).toBeLessThanOrEqual(TAP_RESERVE + 1e-6);
  expect(restPeak).toBeLessThanOrEqual(EFFECTS_PEAK_BUDGET - TAP_RESERVE + 1e-6);
  const peak = atOutput(peakOf(mixPlayed(fake)));
  expect(peak).toBeLessThan(1);
  return { peak, inPhase: atOutput(tapPeak + restPeak) };
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

/**
 * The most the fill's low-pass puts out, for any input of peak 1, at any sample of a
 * sweep over `seconds`: the L1 norm of its time-varying impulse response (how much each
 * output depends on every input before it), with new coefficients every `quantum`
 * samples. Computed backwards from each output (the adjoint recursion).
 */
function sweptLowpassGain(sampleRate: number, seconds: number, quantum: number) {
  const sweep = Math.round(seconds * sampleRate);
  const lookback = 500;
  const total = sweep + lookback;
  const b0 = new Float64Array(total);
  const b1 = new Float64Array(total);
  const a1 = new Float64Array(total);
  const a2 = new Float64Array(total);
  for (let j = 0; j < total; j += 1) {
    const k = Math.floor(j / quantum) * quantum;
    const c = lowpassAt(fillCutoffAt(k / sweep), -3, sampleRate);
    [b0[j], b1[j], a1[j], a2[j]] = c;
  }
  const g = new Float64Array(lookback + 3);
  let worst = 0;
  for (let n = 0; n < total; n += 2) {
    // g[i]: how much y[n] depends on y[n − i].
    g.fill(0);
    g[0] = 1;
    let norm = 0;
    for (let i = 0; i < lookback && i <= n; i += 1) {
      const j = n - i;
      if (i > 0) {
        g[i] =
          -(a1[j + 1] ?? 0) * (g[i - 1] ?? 0) - (i > 1 ? (a2[j + 2] ?? 0) * (g[i - 2] ?? 0) : 0);
      }
      // y[n]'s dependence on x[j]: through y[j], y[j + 1] and y[j + 2].
      const dx =
        (b0[j] ?? 0) * (g[i] ?? 0) +
        (i > 0 ? (b1[j + 1] ?? 0) * (g[i - 1] ?? 0) : 0) +
        (i > 1 ? (b0[j + 2] ?? 0) * (g[i - 2] ?? 0) : 0);
      norm += Math.abs(dx);
    }
    worst = Math.max(worst, norm);
  }
  return worst;
}

describe('headroom', () => {
  const tailOf = (effect: Effect, sampleRate: number) =>
    remainingPeaks(renderEffect(effect, sampleRate), sampleRate);
  const others = EFFECTS_PEAK_BUDGET - TAP_RESERVE;

  it('keeps the budget under full scale through the master gain', () => {
    expect(EFFECTS_PEAK_BUDGET * MASTER_GAIN).toBeLessThan(1);
    // Every effect alone fits its share, so a lone effect is never ducked.
    for (const effect of EFFECTS) {
      expect(EFFECT_GAIN[effect]).toBeLessThan(effect === 'tap' ? TAP_RESERVE : others);
    }
    expect(EFFECT_GAIN.fill * FILL_FILTER_GAIN).toBeLessThan(others);
  });

  it.each(RATES)('keeps room for a tap at its level, at once, at %i Hz', (sampleRate) => {
    // The taps before it are 30, 60, … ms older, counted START_SLACK_S behind (a ms early,
    // for rounding).
    const tail = tailOf('tap', sampleRate);
    const first = Math.round(1000 * (REPEAT_WINDOW_S - START_SLACK_S)) - 1;
    let before = 0;
    for (let ms = first; ms < tail.length; ms += 30) before += tail[ms] ?? 0;
    // Measured: 0.093 at 48 kHz, 0.105 at 44.1 kHz.
    expect(before).toBeGreaterThan(0.05);
    expect(EFFECT_GAIN.tap + before).toBeLessThanOrEqual(TAP_RESERVE);
  });

  it('leaves a miss or completion room at its level beside the other within its window', () => {
    // All a miss or completion cannot fade is the other one in its first REPEAT_WINDOW_S.
    expect(EFFECT_GAIN.miss + EFFECT_GAIN.complete).toBeLessThanOrEqual(others);
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

  it('bounds the fill through its low-pass, however fast its cutoff sweeps', () => {
    // From a long tile of 10 ms to 1 s; slower sweeps are nearer the frozen filter. New
    // coefficients every sample (Chromium's a-rate) or every render quantum (WebKit).
    for (const sampleRate of RATES) {
      for (const seconds of [0.01, 0.03, 0.1, 0.3, 1]) {
        for (const quantum of [1, 128]) {
          expect(sweptLowpassGain(sampleRate, seconds, quantum)).toBeLessThanOrEqual(
            FILL_FILTER_GAIN,
          );
        }
      }
    }
  }, 20_000);

  it.each([0, 1, 5, 10, 16])(
    'plays the round-1 pile-up under full scale, the miss %i ms late at its level',
    (lateMs) => {
      // A tap reaches combo 50; 5120 samples later a held tile completes and another is
      // tapped, and an empty press misses. At round 1 this reached +1.07 dBFS; at round
      // 2 the miss was dropped.
      const run = driven();
      const { judge, wait } = run;
      judge({ unit: 'tap', judgment: 'clear', combo: 50 });
      wait(5120 / 48000);
      judge({ unit: 'tail', judgment: 'clear', combo: 51 });
      judge({ unit: 'tap', judgment: 'clear', combo: 52 });
      wait(lateMs / 1000);
      judge({ unit: 'empty', judgment: 'miss', combo: 0 });
      // Measured: −2.6 dBFS at most.
      expectWithinBudget(run);
      expect(expectGuaranteed(run).started).toBe(4);
      expect(run.played.find((p) => p.effect === 'miss')?.source).toBeDefined();
    },
  );

  it('plays the miss that ends a real Classic run (the round-2 counterexample)', () => {
    // A long tile held from 0; 48 taps; the 50th in a row at 5000 ms; at 5106.67 the hold
    // completes and lane 2 is tapped; 5 ms later an empty lane is pressed. At round 2
    // the budget dropped this miss.
    const run = driven();
    const { player, wait, play, played } = run;
    const holdMs = 5106.666666666667;
    const tiles = [
      { t: 0, lane: 0, pitches: [60], vel: 100, dur: holdMs },
      ...Array.from({ length: 48 }, (_, n) => ({
        t: (n + 1) * 100,
        lane: 1,
        pitches: [60],
        vel: 100,
      })),
      { t: 5000, lane: 1, pitches: [60], vel: 100 },
      { t: holdMs, lane: 2, pitches: [60], vel: 100 },
      { t: 8000, lane: 1, pitches: [60], vel: 100 },
    ];
    const fills = new Map<number, FillVoice>();
    const misses: number[] = [];
    const sim = createTilesSimulation({
      tiles,
      tempo: 1,
      failMode: 'classic',
      durationMs: 9000,
      scrollDurationMs: 1000,
      exitAlong: 0.13,
      onJudgment(event) {
        const cues = effectCues(event, 'tiles');
        if (event.judgment === 'miss') misses.push(played.length);
        for (const effect of cues.oneShots) play(effect);
        if (cues.fill === 'start') fills.set(event.tileIndex, player.fill(holdMs / 1000));
        if (cues.fill === 'stop') fills.get(event.tileIndex)?.stop();
      },
    });
    sim.press('hold', 0, 0);
    for (let n = 1; n <= 48; n += 1) {
      wait(0.1);
      sim.press(`tap${n}`, 1, n * 100);
    }
    wait(0.2);
    sim.press('combo', 1, 5000);
    wait(5120 / 48000);
    sim.press('next', 2, holdMs);
    wait(0.005);
    sim.press('wrong', 3, holdMs + 5);
    expect(sim.status).toBe('failed');
    expect(misses).toHaveLength(1);
    const miss = played[misses[0] ?? -1];
    expect(miss?.effect).toBe('miss');
    expect(miss?.source).toBeDefined();
    // The head's tap, 50 more taps, the completion and the miss.
    expect(expectGuaranteed(run).started).toBe(53);
    // It made room: it starts STEAL_FADE_S after the press (expectGuaranteed).
    expect(miss?.source?.startArgs).toEqual([(miss?.at ?? 0) + STEAL_FADE_S]);
    expectWithinBudget(run);
  });

  it('ducks nothing on a fast run: 20 tiles a second, doubles, long tiles, a combo', () => {
    const run = driven();
    const { player, wait, judge } = run;
    for (let n = 0; n < 60; n += 1) {
      judge({ unit: 'tap', judgment: 'clear', combo: n === 30 ? 50 : 1 });
      if (n % 4 === 0) {
        // A double: the second finger a few ms later.
        wait(0.004);
        judge({ unit: 'tap', judgment: 'clear', combo: 1 });
      }
      if (n % 10 === 5) player.fill(0.45);
      if (n % 10 === 4) judge({ unit: 'tail', judgment: 'clear', combo: 1 });
      wait(n % 4 === 0 ? 0.046 : 0.05);
    }
    expectGuaranteed(run);
    const levels = run.played.flatMap(({ source }) => (source ? [run.levelOf(source)] : []));
    expect(Math.min(...levels)).toBeCloseTo(1, 9);
    // At full Effects and master volume (measured: −5.0 dBFS).
    expect(expectWithinBudget(run).peak).toBeLessThan(0.75);
  });

  it('never clips, and never ducks a miss, completion or tap: a seeded search', () => {
    // Judgments in any order and at any spacing, a combo on any of them, fills of any
    // length, the render up to START_SLACK_S ahead of currentTime: more than the game
    // can produce. At full Effects and master volume.
    const units = ['tap', 'head', 'tail', 'empty'] as const;
    let worst = 0;
    let worstInPhase = 0;
    let started = 0;
    for (let seed = 1; seed <= 100; seed += 1) {
      const next = random(seed);
      const run = driven(seed % 2 ? 48000 : 44100, () => next() * START_SLACK_S);
      const { player, wait, judge, fake } = run;
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
      const mix = expectWithinBudget(run);
      worst = Math.max(worst, mix.peak);
      worstInPhase = Math.max(worstInPhase, mix.inPhase);
      started += expectGuaranteed(run).started;
    }
    // Measured: −3.1 dBFS, and −1.6 dBFS with every phase lined up. About a third of
    // the misses and completions make room.
    expect(worst).toBeLessThan(1);
    expect(worstInPhase).toBeLessThan(EFFECTS_PEAK_BUDGET * MASTER_GAIN);
    expect(started).toBeGreaterThan(2000);
  }, 30_000);
});
