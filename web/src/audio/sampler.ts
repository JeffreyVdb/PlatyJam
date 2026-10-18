import type { Instrument } from './instrument';

/** Piano-like release when a key is let go. */
export const RELEASE_S = 0.25;
/** The samples stop after ~3.13 s, some still audible: fade this much before the end. */
export const TAIL_FADE_S = 0.04;
/** Fade for a voice stolen to stay under the cap. */
export const STEAL_FADE_S = 0.02;
/** Fade for the previous voice of a pitch that is struck again. */
export const RESTRIKE_FADE_S = 0.08;
export const MAX_VOICES = 48;

/**
 * MIDI velocity to linear gain: (v / 127)². Squared because loudness is roughly
 * logarithmic, so velocity 64 is about −12 dB, a clearly softer note, not a
 * barely quieter one. Clamped to 1–127.
 */
export function velocityGain(velocity: number): number {
  const v = Math.min(127, Math.max(1, velocity));
  return (v / 127) ** 2;
}

interface Point {
  t: number;
  v: number;
}

export interface PianoVoice {
  readonly pitch: number;
  /** Context seconds. */
  readonly start: number;
}

interface Voice extends PianoVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** When the source stops: the buffer end, or the end of a release. */
  stopAt: number;
  /** Mirror of the gain automation, so a release can start from the right level. */
  envelope: Point[];
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

export interface Sampler extends Instrument<PianoVoice> {
  activeVoices(): number;
  /** Drops every voice without touching it: their context was closed and replaced. */
  reset(): void;
}

export interface SamplerOptions {
  /** Read on every note: the engine replaces both when it recreates the context. */
  target: { readonly context: BaseAudioContext; readonly output: AudioNode };
  /** Decoded samples by MIDI note. They outlive any context, so they are reused. */
  buffers: ReadonlyMap<number, AudioBuffer>;
}

/**
 * Plays the piano samples: one AudioBufferSourceNode and GainNode per voice,
 * created per note. A hit (`noteOn` without `when`) starts at `currentTime` with
 * nothing asynchronous in the way.
 */
export function createSampler({ target, buffers }: SamplerOptions): Sampler {
  let voices: Voice[] = [];

  const forget = (voice: Voice) => {
    voices = voices.filter((v) => v !== voice);
  };

  /** Ramps the voice to silence from its level at `at`, then stops it. */
  const release = (voice: Voice, at: number, fadeSec: number) => {
    if (at >= voice.stopAt) return;
    if (at <= voice.start) {
      // Not started yet: stopping before the start time means it never sounds.
      voice.source.stop(voice.start);
      voice.stopAt = voice.start;
      return;
    }
    const level = envelopeAt(voice.envelope, at);
    const end = Math.min(at + fadeSec, voice.stopAt);
    const param = voice.gain.gain;
    // Cancelling drops any ramp still running at `at` (an earlier release, the tail
    // fade). Ramping to the mirrored level at `at` redraws that stretch exactly, so
    // the gain never steps; a setValueAtTime here would hold the old value until `at`.
    // (cancelAndHoldAtTime would do the same, but not every browser has it.)
    param.cancelScheduledValues(at);
    param.linearRampToValueAtTime(level, at);
    param.linearRampToValueAtTime(0, end);
    voice.envelope = [
      ...voice.envelope.filter((p) => p.t < at),
      { t: at, v: level },
      { t: end, v: 0 },
    ];
    voice.source.stop(end);
    voice.stopAt = end;
  };

  return {
    noteOn(pitch, velocity, when) {
      const buffer = buffers.get(pitch);
      if (!buffer) return null;
      const ctx = target.context;
      const now = ctx.currentTime;
      const start = Math.max(when ?? now, now);

      for (const other of voices) {
        if (other.pitch === pitch && other.start <= start) release(other, start, RESTRIKE_FADE_S);
      }
      if (voices.length >= MAX_VOICES) {
        const oldest = voices.reduce((a, b) => (b.start < a.start ? b : a));
        release(oldest, Math.max(now, oldest.start), STEAL_FADE_S);
        forget(oldest);
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      const peak = velocityGain(velocity);
      const end = start + buffer.duration;
      const envelope = [
        { t: start, v: peak },
        { t: end - TAIL_FADE_S, v: peak },
        { t: end, v: 0 },
      ];
      gain.gain.setValueAtTime(peak, start);
      gain.gain.setValueAtTime(peak, end - TAIL_FADE_S);
      gain.gain.linearRampToValueAtTime(0, end);
      source.connect(gain).connect(target.output);

      const voice: Voice = { pitch, start, source, gain, stopAt: end, envelope };
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        forget(voice);
      };
      source.start(start);
      voices.push(voice);
      return voice;
    },

    noteOff(handle, when) {
      const voice = voices.find((v) => v === handle);
      if (!voice) return;
      const now = target.context.currentTime;
      release(voice, Math.max(when ?? now, now, voice.start + 0.001), RELEASE_S);
    },

    stopAll(fadeMs) {
      const now = target.context.currentTime;
      for (const voice of voices) release(voice, now, fadeMs / 1000);
      voices = [];
    },

    activeVoices: () => voices.length,

    reset() {
      voices = [];
    },
  };
}
