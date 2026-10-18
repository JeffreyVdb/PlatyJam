import type { SongClock } from './clock';

/** How far ahead a backing track is started, so `start()` is never in the past. */
export const BACKING_LEAD_S = 0.05;

export interface BackingPlanInput {
  /** Context time now, seconds. The clock must be running. */
  now: number;
  leadSec: number;
  clock: SongClock;
  /** Chart ms at which the file's first sample plays. */
  trackStartMs: number;
  durationSec: number;
  audioOffsetMs: number;
}

/** Arguments for `AudioBufferSourceNode.start(when, offset)`. */
export interface BackingStart {
  when: number;
  /** Buffer seconds. The file is chart time at 1×, so buffer seconds are chart seconds. */
  offset: number;
}

/**
 * Where to start the file so that what is heard matches the song clock: at its
 * beginning if the track start is still ahead, otherwise as soon as possible from
 * the buffer position that will be audible then (after a resume or a seek).
 */
export function planBackingStart({
  now,
  leadSec,
  clock,
  trackStartMs,
  durationSec,
  audioOffsetMs,
}: BackingPlanInput): BackingStart | null {
  const audio = audioOffsetMs / 1000;
  const earliest = now + leadSec;
  const startAtBeginning = clock.ctxTimeFor(trackStartMs) - audio;
  if (startAtBeginning >= earliest) return { when: startAtBeginning, offset: 0 };
  // Started at `earliest`, the sound reaches the ear A later.
  const offset = (clock.songTimeAt(earliest + audio) - trackStartMs) / 1000;
  return offset < durationSec ? { when: earliest, offset } : null;
}

/** `url` as given when it is absolute (`/…`, `https:`, `blob:`), otherwise under the app `base`. */
export function backingTrackUrl(base: string, url: string): string {
  return url.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(url) ? url : `${base}${url}`;
}

export interface BackingLoadOptions {
  /** The audio file: absolute, or relative to `base`. */
  url: string;
  /** App base URL (`import.meta.env.BASE_URL`), ending in a slash. */
  base: string;
  /** `fetch` rather than `<audio>`, as for the piano: the service worker caches whole responses. */
  fetch?: (url: string) => Promise<Response>;
  /** Decodes into the current context. Works while the context is still suspended. */
  decode: (data: ArrayBuffer) => Promise<AudioBuffer>;
}

/**
 * Loads a backing file for `createBackingTrack`. Never rejects: on a network or
 * decode failure it logs and resolves null, and the song plays without it.
 */
export async function loadBackingTrack({
  url,
  base,
  fetch = (input) => window.fetch(input),
  decode,
}: BackingLoadOptions): Promise<AudioBuffer | null> {
  const resolved = backingTrackUrl(base, url);
  try {
    const response = await fetch(resolved);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await decode(await response.arrayBuffer());
  } catch (error) {
    console.warn(`[platyjam] backing track ${resolved} did not load`, error);
    return null;
  }
}

export interface BackingTrack {
  /** Starts (or restarts) the file in sync with the running clock. */
  play(): void;
  stop(fadeMs: number): void;
  readonly playing: boolean;
}

export interface BackingTrackOptions {
  target: { readonly context: BaseAudioContext; readonly output: AudioNode };
  clock: SongClock;
  audioOffsetMs: () => number;
  buffer: AudioBuffer;
  trackStartMs?: number;
}

/**
 * An optional audio file under the song (for audio-file songs later). It plays at
 * `playbackRate = tempo`, so its pitch shifts with the tempo; a time-stretch would
 * keep the pitch but is not worth the cost yet. Changing the tempo mid-song needs
 * `play()` again.
 */
export function createBackingTrack({
  target,
  clock,
  audioOffsetMs,
  buffer,
  trackStartMs = 0,
}: BackingTrackOptions): BackingTrack {
  let current: { source: AudioBufferSourceNode; gain: GainNode } | undefined;

  const stop = (fadeMs: number) => {
    if (!current) return;
    const { source, gain } = current;
    current = undefined;
    const now = target.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
    try {
      source.stop(now + fadeMs / 1000);
    } catch {
      // Already stopped.
    }
  };

  return {
    play() {
      stop(10);
      if (!clock.isRunning) return;
      const ctx = target.context;
      const plan = planBackingStart({
        now: ctx.currentTime,
        leadSec: BACKING_LEAD_S,
        clock,
        trackStartMs,
        durationSec: buffer.duration,
        audioOffsetMs: audioOffsetMs(),
      });
      if (!plan) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = clock.tempo;
      const gain = ctx.createGain();
      source.connect(gain).connect(target.output);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        if (current?.source === source) current = undefined;
      };
      source.start(plan.when, plan.offset);
      current = { source, gain };
    },
    stop,
    get playing() {
      return current !== undefined;
    },
  };
}
