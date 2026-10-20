/**
 * Tiles' sound effects (PLA-15), synthesised at runtime: nothing to download or
 * cache, so they work offline from the first launch, and nothing to license.
 *
 * The rendering is pure: `renderEffect` and `renderFillLoop` turn a sample rate into
 * sample data, with no Web Audio, so tests can measure them. `createEffectsPlayer`
 * copies them into `AudioBuffer`s and plays them on the Effects submix. AudioBuffers
 * work in any context, so they survive a recreated one.
 *
 * Guidelines: nothing pitched may clash with the song. The tap and the fill are
 * tuned noise (a band, no pitch class), the clears are inharmonic partials above
 * 3.9 kHz that read as sparkle, and the miss and combo are glides with no fixed
 * pitch. Each sits below the music, and a fast run of them cannot clip the
 * Effects bus (`effects.test.ts` mixes the worst cases).
 *
 * The recipes are a starting point from research, not yet tuned by ear: each
 * effect's level is one constant in `EFFECT_GAIN`.
 */

/** The one-shot effects. `fill` is separate: it lasts as long as a long tile fills. */
export const EFFECTS = ['tap', 'clear', 'complete', 'miss', 'combo'] as const;
export type Effect = (typeof EFFECTS)[number];

/**
 * Each effect's peak, linear, before the Effects volume (default 0.7) and the master
 * gain: the rendered sound is scaled to exactly this. For the fill, its level once
 * the long tile is full. The research's starting levels, 2 dB lower (× 0.8), so that
 * even every effect starting at once stays under full scale through the master gain
 * (`sfx.test.ts`, "headroom"). Tune them here after listening on the iPad.
 */
export const EFFECT_GAIN: Readonly<Record<Effect | 'fill', number>> = {
  tap: 0.28,
  clear: 0.24,
  complete: 0.32,
  miss: 0.44,
  combo: 0.32,
  fill: 0.12,
};

/** Each one-shot's length, seconds. */
export const EFFECT_LENGTH_S: Readonly<Record<Effect, number>> = {
  tap: 0.045,
  clear: 0.09,
  complete: 0.22,
  miss: 0.16,
  combo: 0.26,
};

/**
 * Voices sounding at once, one-shots and fills together. A new one beyond this fades
 * the oldest out over `STEAL_FADE_S`: the safety net under a fast run. (No
 * compressor: its look-ahead would delay the tap.)
 */
export const MAX_EFFECT_VOICES = 6;
/**
 * The same effect started again within this many seconds plays once: a double's two
 * taps, or the head and tail Miss of a long tile lost whole, are one sound, not one
 * twice as loud.
 */
export const REPEAT_WINDOW_S = 0.03;
/** Fade for a voice stolen to stay under the cap. */
export const STEAL_FADE_S = 0.01;
/** Fade for a fill when its long tile is let go or completes. */
export const FILL_STOP_FADE_S = 0.02;

/** Raised-cosine ramps at both ends, so no sound begins or ends on a step (a click). */
const EDGE_IN_S = 0.001;
const EDGE_OUT_S = 0.004;
/** A fill's own fade in and out. */
const FILL_FADE_IN_S = 0.15;
const FILL_FADE_OUT_S = 0.02;
/** The fill opens a low-pass from here to here (Hz) while the tile fills. */
const FILL_SWEEP_HZ = [1500, 6000] as const;
/** The fill's noise is high-passed here, so it is a hiss, never a rumble. */
const FILL_FLOOR_HZ = 800;
/** The fill's low-pass resonance, dB: about Q 0.7, no peak. */
const FILL_LOWPASS_Q_DB = -3;
/** The fill's noise loop, and the crossfade that hides its seam. */
const FILL_LOOP_S = 2;
const FILL_SEAM_S = 0.05;

const TAU = 2 * Math.PI;

/** Deterministic noise in [-1, 1) (mulberry32), so an effect renders the same every time. */
function noise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 31 - 1;
  };
}

/** A one-pole low-pass whose cutoff (Hz) can change every sample. */
function lowpass(sampleRate: number) {
  let y = 0;
  return (x: number, hz: number) => (y += (1 - Math.exp((-TAU * hz) / sampleRate)) * (x - y));
}

/** A sine whose frequency follows `hz(t)`, its phase accumulated so it never jumps. */
function sweep(sampleRate: number) {
  let phase = 0;
  return (hz: number) => {
    phase += (TAU * hz) / sampleRate;
    return phase;
  };
}

/**
 * Finishing every render: raised-cosine ramps at both ends, the DC offset removed and
 * the peak scaled to `gain`. The offset `c` is taken out under the same ramp,
 * `r·(x − c)` with `c = Σrx / Σr`, so the ends stay exactly zero and the mean is zero.
 */
function finish(data: Float32Array, sampleRate: number, gain: number): Float32Array {
  const edgeIn = Math.max(1, Math.round(EDGE_IN_S * sampleRate));
  const edgeOut = Math.max(1, Math.round(EDGE_OUT_S * sampleRate));
  const rise = (n: number, of: number) => 0.5 - 0.5 * Math.cos((Math.PI * Math.min(n, of)) / of);
  const ramp = (i: number) => Math.min(rise(i, edgeIn), rise(data.length - 1 - i, edgeOut));
  let weighted = 0;
  let weights = 0;
  for (let i = 0; i < data.length; i += 1) {
    weighted += ramp(i) * (data[i] ?? 0);
    weights += ramp(i);
  }
  const offset = weights > 0 ? weighted / weights : 0;
  let peak = 0;
  for (let i = 0; i < data.length; i += 1) {
    const x = ramp(i) * ((data[i] ?? 0) - offset);
    data[i] = x;
    peak = Math.max(peak, Math.abs(x));
  }
  if (peak > 0) for (let i = 0; i < data.length; i += 1) data[i] = ((data[i] ?? 0) * gain) / peak;
  return data;
}

/** The clears' sparkle: inharmonic partials above 3.9 kHz, [Hz, level]. */
const SPARKLE: readonly (readonly [number, number])[] = [
  [5200, 1],
  [6900, 0.6],
  [8300, 0.4],
  [10100, 0.25],
];

/** A clear: the sparkle ringing for `tau` s, with a tick of hiss above 6 kHz on its onset. */
function sparkle(
  data: Float32Array,
  sampleRate: number,
  { partials, tau, hissTau }: { partials: typeof SPARKLE; tau: number; hissTau: number },
) {
  const white = noise(2);
  const lp = lowpass(sampleRate);
  for (let i = 0; i < data.length; i += 1) {
    const t = i / sampleRate;
    let ring = 0;
    for (const [hz, level] of partials) {
      if (hz < sampleRate * 0.45) ring += Math.sin(TAU * hz * t) * level;
    }
    const n = white();
    const hiss = (n - lp(n, 6000)) * 0.15 * Math.exp(-t / hissTau);
    data[i] = ring * Math.exp(-t / tau) + hiss;
  }
}

const RENDERERS: Readonly<Record<Effect, (data: Float32Array, sampleRate: number) => void>> = {
  /**
   * A soft knock: a burst of noise in a 250 Hz–1.2 kHz band, with a faint sine body
   * gliding 240 → 150 Hz under it. Noise-led, so it has no pitch to clash with the note.
   */
  tap(data, sampleRate) {
    const white = noise(1);
    const high = lowpass(sampleRate);
    const low = lowpass(sampleRate);
    const body = sweep(sampleRate);
    for (let i = 0; i < data.length; i += 1) {
      const t = i / sampleRate;
      const n = white();
      const band = (high(n, 1200) - low(n, 250)) * Math.exp(-t / 0.006);
      const phase = body(240 - 90 * Math.min(1, t / 0.008));
      data[i] = band + Math.sin(phase) * Math.exp(-t / 0.008) * 0.1;
    }
  },
  /** A quick sparkle. */
  clear(data, sampleRate) {
    sparkle(data, sampleRate, { partials: SPARKLE, tau: 0.018, hissTau: 0.004 });
  },
  /** A long tile completed: the clear's sparkle, longer and fuller. */
  complete(data, sampleRate) {
    const partials = [...SPARKLE, [3900, 0.3] as const];
    sparkle(data, sampleRate, { partials, tau: 0.035, hissTau: 0.008 });
  },
  /**
   * A low, muted thud: a sine gliding 260 → 130 Hz and a puff of low-passed noise.
   * Its energy is above 130 Hz, where an iPad's speaker still plays.
   */
  miss(data, sampleRate) {
    const white = noise(4);
    const lp = lowpass(sampleRate);
    const body = sweep(sampleRate);
    for (let i = 0; i < data.length; i += 1) {
      const t = i / sampleRate;
      const phase = body(130 + 130 * Math.exp(-t / 0.035));
      data[i] =
        Math.sin(phase) * Math.exp(-t / 0.045) + lp(white(), 400) * Math.exp(-t / 0.012) * 0.25;
    }
  },
  /** A rising flourish: a glide from 400 to 1600 Hz in 200 ms, never resting on a note. */
  combo(data, sampleRate) {
    const glide = sweep(sampleRate);
    for (let i = 0; i < data.length; i += 1) {
      const t = i / sampleRate;
      const phase = glide(400 * 4 ** (Math.min(t, 0.2) / 0.2));
      const env = Math.min(1, t / 0.005) * (t < 0.2 ? 1 : Math.exp(-(t - 0.2) / 0.03));
      data[i] = (Math.sin(phase) + 0.3 * Math.sin(2 * phase)) * env;
    }
  },
};

/** One effect at `sampleRate`: mono samples, peak `EFFECT_GAIN[effect]`. */
export function renderEffect(effect: Effect, sampleRate: number): Float32Array {
  const data = new Float32Array(Math.round(EFFECT_LENGTH_S[effect] * sampleRate));
  RENDERERS[effect](data, sampleRate);
  return finish(data, sampleRate, EFFECT_GAIN[effect]);
}

/**
 * The fill's texture: `FILL_LOOP_S` of noise high-passed at `FILL_FLOOR_HZ`, peak 1,
 * that loops without a seam (its end is crossfaded into its start). The player opens
 * a low-pass over it and raises its level as a long tile fills, with automation
 * rather than a render per long tile, so starting one costs nothing in the tap and
 * a long tile of any length is covered.
 */
export function renderFillLoop(sampleRate: number): Float32Array {
  const length = Math.round(FILL_LOOP_S * sampleRate);
  const overlap = Math.round(FILL_SEAM_S * sampleRate);
  const raw = new Float32Array(length + overlap);
  const white = noise(3);
  const lp = lowpass(sampleRate);
  for (let i = 0; i < raw.length; i += 1) {
    const n = white();
    raw[i] = n - lp(n, FILL_FLOOR_HZ);
  }
  // The loop's last `overlap` samples fade into its first, so the wrap is continuous.
  const data = raw.slice(0, length);
  for (let i = 0; i < overlap; i += 1) {
    const w = i / overlap;
    data[i] = (raw[i] ?? 0) * w + (raw[length + i] ?? 0) * (1 - w);
  }
  let sum = 0;
  for (const x of data) sum += x;
  const mean = sum / length;
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const x = (data[i] ?? 0) - mean;
    data[i] = x;
    peak = Math.max(peak, Math.abs(x));
  }
  if (peak > 0) for (let i = 0; i < length; i += 1) data[i] = (data[i] ?? 0) / peak;
  return data;
}

/** The fill's low-pass cutoff (Hz) at `progress` (0 to 1) through its long tile. */
export function fillCutoffAt(progress: number): number {
  const [low, high] = FILL_SWEEP_HZ;
  return low * (high / low) ** Math.min(1, Math.max(0, progress));
}

/** The fill's level at `progress`, before its fades: it grows as the tile fills. */
export function fillLevelAt(progress: number): number {
  return EFFECT_GAIN.fill * (0.4 + 0.6 * Math.min(1, Math.max(0, progress)));
}

// ---- playback ----

export interface FillVoice {
  /** Fades the fill out (`FILL_STOP_FADE_S` by default). */
  stop(fadeMs?: number): void;
}

/**
 * Plays nothing while the context is not running (suspended, or WebKit's
 * `interrupted`): an effect is feedback for now, so it is skipped, never queued to
 * burst out on resume.
 */
export interface EffectsPlayer {
  /** Plays an effect now: never scheduled, so a tap sounds at the tap. */
  play(effect: Effect): void;
  /**
   * A long tile's fill, `durationS` long: from `when` (context seconds; now if
   * omitted), starting `offsetS` into it (to pick up a fill a pause cut short).
   */
  fill(durationS: number, options?: { when?: number; offsetS?: number }): FillVoice;
  /** Renders every buffer now, so the first tap does not wait for it. */
  prepare(): void;
  /** Fades out every fill, playing or scheduled. One-shots ring on. */
  stopFills(fadeMs: number): void;
  /** Fades out everything, playing or scheduled. */
  stopAll(fadeMs: number): void;
  /** Drops every voice without touching it: their context was closed and replaced. */
  reset(): void;
  activeVoices(): number;
}

interface Point {
  t: number;
  v: number;
}

/** Gain of a piecewise-linear envelope at `t`: what Web Audio computes for our events. */
function envelopeAt(points: readonly Point[], t: number): number {
  let previous: Point | undefined;
  for (const point of points) {
    if (t < point.t) {
      if (!previous) return 0;
      return previous.v + ((point.v - previous.v) * (t - previous.t)) / (point.t - previous.t);
    }
    previous = point;
  }
  return previous?.v ?? 0;
}

interface Voice {
  readonly kind: Effect | 'fill';
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  /** Context seconds. */
  readonly start: number;
  /** The gain's automation, mirrored, so a fade starts from the level it is at. */
  readonly envelope: Point[];
  stopping: boolean;
}

function toBuffer(ctx: BaseAudioContext, data: Float32Array): AudioBuffer {
  const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buffer.getChannelData(0).set(data);
  return buffer;
}

/**
 * Plays the effects into `target.output` (the Effects submix): one
 * AudioBufferSourceNode and GainNode per voice. A one-shot's gain stays at 1 (its
 * level is in its samples) until it is faded; a fill also runs through a band-pass.
 */
export function createEffectsPlayer(target: {
  readonly context: BaseAudioContext;
  readonly output: AudioNode;
}): EffectsPlayer {
  // AudioBuffers work in any context, so these survive a recreated context.
  const buffers = new Map<Effect, AudioBuffer>();
  let fillLoop: AudioBuffer | undefined;
  let voices: Voice[] = [];

  const forget = (voice: Voice) => {
    voices = voices.filter((v) => v !== voice);
  };

  const fade = (voice: Voice, fadeS: number) => {
    if (voice.stopping) return;
    voice.stopping = true;
    const now = target.context.currentTime;
    if (voice.start > now) {
      // Not started yet: stopping at its start means it never sounds.
      voice.source.stop(voice.start);
      return;
    }
    const param = voice.gain.gain;
    // As in the sampler: ramping to the mirrored level at `now` redraws that stretch
    // exactly, so the gain never steps.
    param.cancelScheduledValues(now);
    param.linearRampToValueAtTime(envelopeAt(voice.envelope, now), now);
    param.linearRampToValueAtTime(0, now + fadeS);
    voice.source.stop(now + fadeS);
  };

  const start = (
    kind: Voice['kind'],
    source: AudioBufferSourceNode,
    gain: GainNode,
    envelope: Point[],
    when: number,
  ) => {
    const voice: Voice = { kind, source, gain, start: when, envelope, stopping: false };
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      forget(voice);
    };
    voices.push(voice);
    return voice;
  };

  /** Makes room for one more voice under the cap, fading the oldest out. */
  const makeRoom = () => {
    const live = voices.filter((voice) => !voice.stopping);
    if (live.length < MAX_EFFECT_VOICES) return;
    const oldest = live.reduce((a, b) => (b.start < a.start ? b : a));
    fade(oldest, STEAL_FADE_S);
  };

  const bufferFor = (effect: Effect) => {
    const ctx = target.context;
    let buffer = buffers.get(effect);
    if (!buffer) {
      buffer = toBuffer(ctx, renderEffect(effect, ctx.sampleRate));
      buffers.set(effect, buffer);
    }
    return buffer;
  };

  const loop = () => {
    const ctx = target.context;
    fillLoop ??= toBuffer(ctx, renderFillLoop(ctx.sampleRate));
    return fillLoop;
  };

  const running = () => target.context.state === 'running';

  return {
    play(effect) {
      const ctx = target.context;
      const now = ctx.currentTime;
      if (!running()) return;
      if (voices.some((v) => v.kind === effect && !v.stopping && now - v.start < REPEAT_WINDOW_S)) {
        return;
      }
      makeRoom();
      const source = ctx.createBufferSource();
      source.buffer = bufferFor(effect);
      const gain = ctx.createGain();
      source.connect(gain).connect(target.output);
      start(effect, source, gain, [{ t: now, v: 1 }], now);
      // 0 is "at once", with no stale `currentTime` in the way.
      source.start(0);
    },

    fill(durationS, { when, offsetS = 0 } = {}) {
      const ctx = target.context;
      const now = ctx.currentTime;
      const remaining = durationS - Math.max(0, offsetS);
      if (!(remaining > 0) || !running()) return { stop: () => undefined };
      makeRoom();
      const begin = Math.max(when ?? now, now);
      const end = begin + remaining;
      const from = Math.max(0, offsetS) / durationS;

      const source = ctx.createBufferSource();
      source.buffer = loop();
      source.loop = true;
      const opening = ctx.createBiquadFilter();
      opening.type = 'lowpass';
      // No resonance (Q is in dB for a low-pass): a hiss that brightens, not a whistle.
      opening.Q.value = FILL_LOWPASS_Q_DB;
      opening.frequency.setValueAtTime(fillCutoffAt(from), begin);
      opening.frequency.exponentialRampToValueAtTime(fillCutoffAt(1), end);
      const gain = ctx.createGain();
      const fadeIn = Math.min(FILL_FADE_IN_S, remaining / 3);
      const fadeOut = Math.min(FILL_FADE_OUT_S, remaining / 3);
      const envelope = [
        { t: begin, v: 0 },
        { t: begin + fadeIn, v: fillLevelAt(from + ((1 - from) * fadeIn) / remaining) },
        { t: end - fadeOut, v: fillLevelAt(1 - fadeOut / durationS) },
        { t: end, v: 0 },
      ];
      gain.gain.setValueAtTime(0, begin);
      for (const { t, v } of envelope.slice(1)) gain.gain.linearRampToValueAtTime(v, t);
      source.connect(opening).connect(gain).connect(target.output);
      const voice = start('fill', source, gain, envelope, begin);
      source.start(begin);
      source.stop(end);
      return {
        stop(fadeMs = FILL_STOP_FADE_S * 1000) {
          fade(voice, fadeMs / 1000);
        },
      };
    },

    prepare() {
      for (const effect of EFFECTS) bufferFor(effect);
      loop();
    },

    stopFills(fadeMs) {
      for (const voice of voices) if (voice.kind === 'fill') fade(voice, fadeMs / 1000);
    },

    stopAll(fadeMs) {
      for (const voice of voices) fade(voice, fadeMs / 1000);
    },

    reset() {
      voices = [];
    },

    activeVoices: () => voices.filter((voice) => !voice.stopping).length,
  };
}
