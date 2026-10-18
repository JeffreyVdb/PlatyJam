import type { Instrument } from './instrument';

/** Pitch 1 plays the accented click, anything else the normal one. */
export const ACCENT = 1;

const CLICK_S = 0.03;

/**
 * A synthesised click: a short sine burst with a fast exponential decay, sharp
 * enough to tap to. The attack is at sample 0, so the scheduled time is the onset.
 */
export function renderClick(ctx: BaseAudioContext, frequency: number): AudioBuffer {
  const length = Math.round(CLICK_S * ctx.sampleRate);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    const t = i / ctx.sampleRate;
    data[i] = Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t / 0.006) * 0.9;
  }
  return buffer;
}

/** The metronome click as an Instrument, so calibration schedules it like gameplay audio. */
export function createClick(target: {
  readonly context: BaseAudioContext;
  readonly output: AudioNode;
}): Instrument<AudioBufferSourceNode> {
  // AudioBuffers work in any context, so these survive a recreated context.
  let buffers: { normal: AudioBuffer; accent: AudioBuffer } | undefined;
  let sources = new Set<AudioBufferSourceNode>();

  return {
    noteOn(pitch, _velocity, when) {
      const ctx = target.context;
      buffers ??= { normal: renderClick(ctx, 1500), accent: renderClick(ctx, 2400) };
      const source = ctx.createBufferSource();
      source.buffer = pitch === ACCENT ? buffers.accent : buffers.normal;
      source.connect(target.output);
      source.onended = () => {
        source.disconnect();
        sources.delete(source);
      };
      source.start(Math.max(when ?? ctx.currentTime, ctx.currentTime));
      sources.add(source);
      return source;
    },
    noteOff() {
      // The click ends by itself.
    },
    stopAll() {
      const now = target.context.currentTime;
      for (const source of sources) {
        try {
          source.stop(now);
        } catch {
          // Already stopped.
        }
      }
      sources = new Set();
    },
  };
}
