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
 * pitch. Each sits below the music, and no pile-up of them can clip: the player
 * keeps every voice within `EFFECTS_PEAK_BUDGET`, and a miss, a completion or a tap
 * always plays at its level while the sounds that matter less make way
 * (`MAKES_ROOM`; `sfx.test.ts` mixes the worst cases).
 *
 * The recipes are a starting point from research, not yet tuned by ear: each
 * effect's level is one constant in `EFFECT_GAIN`.
 */

import { MASTER_GAIN } from './engine';

/** The one-shot effects. `fill` is separate: it lasts as long as a long tile fills. */
export const EFFECTS = ['tap', 'clear', 'complete', 'miss', 'combo'] as const;
export type Effect = (typeof EFFECTS)[number];

/**
 * Each effect's peak, linear, before the Effects volume (default 0.7) and the master
 * gain: the rendered sound is scaled to exactly this. For the fill, its level once
 * the long tile is full. The research's starting levels, 2 dB lower (× 0.8). The
 * miss, complete and tap always play at this level; the combo, clear and fill do
 * unless they land on a pile-up the budget has no room for (`EFFECTS_PEAK_BUDGET`).
 * Tune them here after listening on the iPad: `sfx.test.ts` says if that guarantee
 * no longer holds.
 */
export const EFFECT_GAIN: Readonly<Record<Effect | 'fill', number>> = {
  tap: 0.28,
  clear: 0.24,
  complete: 0.32,
  miss: 0.44,
  combo: 0.32,
  fill: 0.15,
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
 * Voices sounding at once, one-shots and fills together, for the CPU's sake (the level
 * is kept by `EFFECTS_PEAK_BUDGET`). A new one beyond this fades out, over
 * `STEAL_FADE_S`, the first voice below it in priority (`MAKES_ROOM`); with none, it
 * goes over.
 */
export const MAX_EFFECT_VOICES = 6;
/**
 * The most the Effects bus may reach: the peaks every voice can still play, summed,
 * stay within this. Through the master gain at full volume that is 0.96 (−0.35
 * dBFS), at any timing of any effects, so nothing clips. (No compressor: its
 * look-ahead would delay the tap.) It is split in two: `TAP_RESERVE` for taps, the
 * rest for everything else.
 */
export const EFFECTS_PEAK_BUDGET = 0.96 / MASTER_GAIN;
/**
 * The part of the budget only taps use. A tap cannot wait for room (it plays in the
 * tap), so room is kept for it: taps still to come stay within this, every other
 * voice within the rest, 0.8. The taps before a new one are 30, 60, … ms older
 * (`REPEAT_WINDOW_S`): counted `START_SLACK_S` behind, their tails add up to 0.11 at
 * most, so with its own 0.28 a tap always plays at its level, at once (`sfx.test.ts`
 * sums them).
 */
export const TAP_RESERVE = 0.4;
/**
 * How much later a voice may really start than it was asked to (`start(0)` begins at
 * the next render quantum, up to a 1024-frame callback after the `currentTime` read
 * before it). A voice is counted as this much less far along than it seems, so its
 * peak still to come is never underestimated. An assumption, not a Web Audio
 * guarantee: a main thread stalled for longer between reading `currentTime` and
 * `start()` would undercount a decaying tail. It is the only one: fades and starts
 * that make room are scheduled in context time, so a late render cuts them short but
 * never overlaps them.
 */
export const START_SLACK_S = 0.025;
/**
 * A low-pass with no resonance still overshoots a little: noise of peak 1 through the
 * fill's comes out at most this, its cutoff sweeping as fast as the shortest long tile
 * makes it (`sfx.test.ts` sums the swept filter's impulse response).
 */
export const FILL_FILTER_GAIN = 1.15;
/** A new voice the budget would duck below this is dropped: the rest would mask it. */
const MIN_DUCK = 0.1;
/**
 * Sounds that must be heard at their level. One that would be ducked makes room
 * instead: it fades out the voices that yield (`YIELDING`, in that order, then misses
 * and completions that have sounded for `REPEAT_WINDOW_S`) over `STEAL_FADE_S`, and
 * starts as they fall silent. The tap needs no room made: it has `TAP_RESERVE`.
 * Priority, highest first: miss and complete (the newer wins once the older has
 * sounded `REPEAT_WINDOW_S`), tap, fill, clear, combo.
 */
const MAKES_ROOM: ReadonlySet<Effect | 'fill'> = new Set(['miss', 'complete']);
/**
 * The voices that yield, first to go first: the combo (the longest and least news),
 * the clear's sparkle, then a fill (its long tile may still be held, and a faded fill
 * does not come back). They never make room themselves: one that does not fit plays
 * quieter, or not at all below `MIN_DUCK`.
 */
const YIELDING: readonly (Effect | 'fill')[] = ['combo', 'clear', 'fill'];
/**
 * The same effect started again within this many seconds plays once: a double's two
 * taps, or the head and tail Miss of a long tile lost whole, are one sound, not one
 * twice as loud.
 */
export const REPEAT_WINDOW_S = 0.03;
/** Fade for a voice that makes room for a miss or completion, or is stolen for the cap. */
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

/**
 * The peak still to come in `data` from each millisecond on: entry `k` is the largest
 * |sample| from `k` ms to the end. It only falls, so the budget can sum it.
 */
export function remainingPeaks(data: Float32Array, sampleRate: number): Float32Array {
  const ms = Math.ceil((data.length * 1000) / sampleRate);
  const tail = new Float32Array(ms);
  let peak = 0;
  let i = data.length - 1;
  for (let k = ms - 1; k >= 0; k -= 1) {
    for (const from = Math.floor((k * sampleRate) / 1000); i >= from; i -= 1) {
      peak = Math.max(peak, Math.abs(data[i] ?? 0));
    }
    tail[k] = peak;
  }
  return tail;
}

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

/** The highest gain a piecewise-linear envelope reaches from `t` on. */
function envelopeFrom(points: readonly Point[], t: number): number {
  return points.reduce(
    (max, point) => (point.t > t ? Math.max(max, point.v) : max),
    envelopeAt(points, t),
  );
}

/** What the budget knows of a voice, or of one about to start. */
interface Shape {
  readonly kind: Effect | 'fill';
  /** Context seconds: when it was asked to start. It never starts earlier. */
  readonly start: number;
  /** Context seconds: when it is surely silent (its stop, or its length and `START_SLACK_S`). */
  end: number;
  /** The gain's automation, mirrored, so a fade starts from the level it is at. */
  envelope: Point[];
  /** A one-shot's `remainingPeaks`. A fill is noise of peak 1 through its low-pass. */
  readonly tail?: Float32Array;
}

interface Voice extends Shape {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  stopping: boolean;
}

/**
 * The most `voice` can add to the bus at `t` or after: its gain from then on times the
 * peak still to come in its sound, counted `START_SLACK_S` behind in case it started
 * late. Nothing before it starts or once it ends. Between starts and ends it only falls.
 */
function peakFrom(voice: Shape, t: number): number {
  if (t < voice.start || t >= voice.end) return 0;
  const gain = envelopeFrom(voice.envelope, t);
  if (!voice.tail) return gain * FILL_FILTER_GAIN;
  const ms = Math.max(0, Math.floor((t - voice.start - START_SLACK_S) * 1000));
  return gain * (voice.tail[ms] ?? 0);
}

function toBuffer(ctx: BaseAudioContext, data: Float32Array): AudioBuffer {
  const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buffer.getChannelData(0).set(data);
  return buffer;
}

/** Whether a newcomer of `kind` may fade `voice` out, to make room or stay under the cap. */
function outranks(kind: Effect | 'fill', voice: Voice, now: number): boolean {
  if (voice.kind === 'tap') return false;
  if (MAKES_ROOM.has(voice.kind)) {
    return MAKES_ROOM.has(kind) && now - voice.start >= REPEAT_WINDOW_S;
  }
  const rank = YIELDING.indexOf(kind);
  return rank < 0 || YIELDING.indexOf(voice.kind) <= rank;
}

/** The order voices are faded in: `YIELDING`'s, then misses and completions; oldest first. */
function fadeOrder(a: Voice, b: Voice): number {
  const rank = (voice: Voice) => {
    const index = YIELDING.indexOf(voice.kind);
    return index < 0 ? YIELDING.length : index;
  };
  return rank(a) - rank(b) || a.start - b.start;
}

/**
 * Plays the effects into `target.output` (the Effects submix): one
 * AudioBufferSourceNode and GainNode per voice. A one-shot's gain stays at its level
 * (its peak is in its samples) until it is faded; a fill also runs through a low-pass.
 *
 * Why the bus stays within `EFFECTS_PEAK_BUDGET`: the bus at any time is at most the
 * sum of `peakFrom` over the voices, and the player keeps that sum, for taps and for the
 * rest, within its share of the budget at every time to come:
 * - a voice is admitted only at a gain that keeps its share within budget at its start
 *   and at every later start already scheduled (`roomFor`); between starts every
 *   `peakFrom` only falls, so that is every time;
 * - a miss or completion that makes room starts at `now + STEAL_FADE_S`, the time the
 *   voices it fades reach 0 and stop, so they are left out from its start on. Both are
 *   scheduled in context time, so a render running late only cuts the fades short;
 * - fades and steals only lower gains, and nothing raises one. Nor does a fade end a
 *   voice later than its `end`, where `peakFrom` counts it silent: it only shortens it.
 *
 * And why a miss, a completion and a tap are never ducked:
 * - a tap only shares `TAP_RESERVE`, with taps at least `REPEAT_WINDOW_S` apart;
 * - a miss or completion can fade every other voice in the rest of the budget but a
 *   tap and a miss or completion younger than `REPEAT_WINDOW_S`. Within that window
 *   there is at most one other (the same effect plays once), so the room left is at
 *   least 0.8 − 0.44 = 0.36 for a completion (0.32) and 0.8 − 0.32 = 0.48 for a miss
 *   (0.44). `sfx.test.ts` checks these sums from the rendered tails.
 */
export function createEffectsPlayer(target: {
  readonly context: BaseAudioContext;
  readonly output: AudioNode;
}): EffectsPlayer {
  // AudioBuffers work in any context, so these survive a recreated context.
  const buffers = new Map<Effect, { buffer: AudioBuffer; tail: Float32Array }>();
  let fillLoop: AudioBuffer | undefined;
  let voices: Voice[] = [];

  const forget = (voice: Voice) => {
    voices = voices.filter((v) => v !== voice);
  };

  /**
   * Fades a voice out over `fadeS`, or sooner if it was already fading faster or ends
   * sooner. It never ends a voice later: the budget counts it silent from `end` on.
   */
  const fade = (voice: Voice, fadeS: number) => {
    const now = target.context.currentTime;
    const end = Math.min(Math.max(now, voice.start) + fadeS, voice.end);
    if (voice.stopping && voice.end <= end) return;
    voice.stopping = true;
    if (voice.start > now) {
      // Not started yet: stopping at its start means it never sounds.
      voice.end = voice.start;
      voice.source.stop(voice.start);
      return;
    }
    // It is silent by then anyway: its envelope or its sound ends there.
    if (voice.end <= end) return;
    const param = voice.gain.gain;
    const from = envelopeAt(voice.envelope, now);
    // As in the sampler: ramping to the mirrored level at `now` redraws that stretch
    // exactly, so the gain never steps.
    param.cancelScheduledValues(now);
    param.linearRampToValueAtTime(from, now);
    param.linearRampToValueAtTime(0, end);
    voice.envelope = [
      ...voice.envelope.filter((point) => point.t < now),
      { t: now, v: from },
      { t: end, v: 0 },
    ];
    voice.end = end;
    voice.source.stop(end);
  };

  const start = (voice: Voice) => {
    const { source, gain } = voice;
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      forget(voice);
    };
    voices.push(voice);
  };

  /**
   * The gain a newcomer shaped like `shape` (at gain 1) may play at, with the voices
   * in `fading` silent by its start: the most that keeps its share of the budget (taps
   * `TAP_RESERVE`, the rest the remainder) within budget then and at every later start.
   * At most 1; below 0 when it is over already.
   */
  const roomFor = (shape: Shape, fading: ReadonlySet<Voice> = new Set()) => {
    const tap = shape.kind === 'tap';
    const budget = tap ? TAP_RESERVE : EFFECTS_PEAK_BUDGET - TAP_RESERVE;
    const sharing = voices.filter((v) => !fading.has(v) && (v.kind === 'tap') === tap);
    const times = [shape.start, ...sharing.map((v) => v.start).filter((t) => t > shape.start)];
    let gain = 1;
    for (const t of times) {
      const own = peakFrom(shape, t);
      if (own <= 0) continue;
      const used = sharing.reduce((sum, v) => sum + peakFrom(v, t), 0);
      gain = Math.min(gain, (budget - used) / own);
    }
    return gain;
  };

  /**
   * For a miss or completion starting at `shape.start`: the voices to fade out by then,
   * in `fadeOrder` and no more than it needs, and the gain it gets.
   */
  const makeRoom = (shape: Shape) => {
    const now = target.context.currentTime;
    const fading = new Set<Voice>();
    for (const voice of voices.filter((v) => outranks(shape.kind, v, now)).sort(fadeOrder)) {
      if (roomFor(shape, fading) >= 1) break;
      fading.add(voice);
    }
    const level = roomFor(shape, fading);
    // Spare the last ones added that it can do without.
    for (const voice of [...fading].reverse()) {
      fading.delete(voice);
      if (roomFor(shape, fading) < level) fading.add(voice);
    }
    return { fading, level };
  };

  /** Keeps one more voice under the cap, fading out the first one `kind` outranks. */
  const steal = (kind: Effect | 'fill') => {
    const now = target.context.currentTime;
    const live = voices.filter((voice) => !voice.stopping);
    if (live.length < MAX_EFFECT_VOICES) return;
    const victim = live.filter((voice) => outranks(kind, voice, now)).sort(fadeOrder)[0];
    if (victim) fade(victim, STEAL_FADE_S);
  };

  const bufferFor = (effect: Effect) => {
    const ctx = target.context;
    let rendered = buffers.get(effect);
    if (!rendered) {
      const data = renderEffect(effect, ctx.sampleRate);
      rendered = { buffer: toBuffer(ctx, data), tail: remainingPeaks(data, ctx.sampleRate) };
      buffers.set(effect, rendered);
    }
    return rendered;
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
      // A voice faded since still counts: the same effect plays once per window.
      if (voices.some((v) => v.kind === effect && now - v.start < REPEAT_WINDOW_S)) return;
      const { buffer, tail } = bufferFor(effect);
      const shapeAt = (at: number): Shape => ({
        kind: effect,
        start: at,
        end: at + buffer.length / buffer.sampleRate + START_SLACK_S,
        envelope: [{ t: at, v: 1 }],
        tail,
      });
      let at = now;
      let level = roomFor(shapeAt(now));
      if (level < 1 && MAKES_ROOM.has(effect)) {
        const room = makeRoom(shapeAt(now + STEAL_FADE_S));
        if (room.level > level) {
          for (const voice of room.fading) fade(voice, STEAL_FADE_S);
          at = now + STEAL_FADE_S;
          level = room.level;
        }
      }
      if (level < MIN_DUCK) return;
      steal(effect);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = level;
      source.connect(gain).connect(target.output);
      const shape = shapeAt(at);
      start({ ...shape, envelope: [{ t: at, v: level }], source, gain, stopping: false });
      // 0 is "at once", with no stale `currentTime` in the way.
      source.start(at === now ? 0 : at);
    },

    fill(durationS, { when, offsetS = 0 } = {}) {
      const ctx = target.context;
      const now = ctx.currentTime;
      const remaining = durationS - Math.max(0, offsetS);
      if (!(remaining > 0) || !running()) return { stop: () => undefined };
      const begin = Math.max(when ?? now, now);
      const end = begin + remaining;
      const from = Math.max(0, offsetS) / durationS;
      const fadeIn = Math.min(FILL_FADE_IN_S, remaining / 3);
      const fadeOut = Math.min(FILL_FADE_OUT_S, remaining / 3);
      // Its envelope at gain 1, before the budget's share.
      const shape: Shape = {
        kind: 'fill',
        start: begin,
        end,
        envelope: [
          { t: begin, v: 0 },
          { t: begin + fadeIn, v: fillLevelAt(from + ((1 - from) * fadeIn) / remaining) },
          { t: end - fadeOut, v: fillLevelAt(1 - fadeOut / durationS) },
          { t: end, v: 0 },
        ],
      };
      const level = Math.min(1, roomFor(shape));
      if (level < MIN_DUCK) return { stop: () => undefined };
      steal('fill');

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
      const envelope = shape.envelope.map(({ t, v }) => ({ t, v: v * level }));
      gain.gain.setValueAtTime(0, begin);
      for (const { t, v } of envelope.slice(1)) gain.gain.linearRampToValueAtTime(v, t);
      source.connect(opening).connect(gain).connect(target.output);
      const voice: Voice = { ...shape, envelope, source, gain, stopping: false };
      start(voice);
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
