/** FluidR3_GM acoustic grand piano: one MP3 per key, A0 to C8. See public/soundfonts/. */
export const PIANO_RANGE = { low: 21, high: 108 } as const;

export const PIANO_SAMPLE_DIR = 'soundfonts/fluidr3-gm/acoustic_grand_piano/';

/** Six parallel requests: enough to fill the pipe, few enough to keep a tap's sound first in line. */
export const LOAD_CONCURRENCY = 6;

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** MIDI note number to the sample's name: 60 → "C4", 61 → "Db4" (the files use flats only). */
export function noteName(midi: number): string {
  return `${NAMES[midi % 12] ?? 'C'}${Math.floor(midi / 12) - 1}`;
}

/** `base` is the app base URL (`import.meta.env.BASE_URL`), ending in a slash. */
export function pianoSampleUrl(base: string, midi: number): string {
  return `${base}${PIANO_SAMPLE_DIR}${noteName(midi)}.mp3`;
}

export interface LoadProgress {
  loaded: number;
  failed: number;
  total: number;
}

export interface PianoSamples {
  buffers: Map<number, AudioBuffer>;
  /** MIDI notes that could not be fetched or decoded. */
  failed: number[];
}

export interface LoadOptions {
  base: string;
  /**
   * `fetch` rather than an `<audio>` element: the service worker caches only whole
   * 200 responses, which is what makes the piano work offline after the first load.
   */
  fetch?: (url: string) => Promise<Response>;
  /** Decodes into the current context. Works while the context is still suspended. */
  decode: (data: ArrayBuffer) => Promise<AudioBuffer>;
  concurrency?: number;
  onProgress?: (progress: LoadProgress) => void;
  /** Filled as keys arrive, so notes play before the whole set is in. */
  buffers?: Map<number, AudioBuffer>;
}

/** Loads all 88 keys. Never rejects: failed keys are listed and the rest still play. */
export async function loadPianoSamples({
  base,
  fetch = (url) => window.fetch(url),
  decode,
  concurrency = LOAD_CONCURRENCY,
  onProgress,
  buffers = new Map(),
}: LoadOptions): Promise<PianoSamples> {
  const queue: number[] = [];
  for (let midi: number = PIANO_RANGE.low; midi <= PIANO_RANGE.high; midi += 1) queue.push(midi);
  const total = queue.length;
  const failed: number[] = [];

  const loadOne = async (midi: number) => {
    try {
      const response = await fetch(pianoSampleUrl(base, midi));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      buffers.set(midi, await decode(await response.arrayBuffer()));
    } catch (error) {
      failed.push(midi);
      console.warn(`[platyjam] piano sample ${noteName(midi)} did not load`, error);
    }
    onProgress?.({ loaded: buffers.size, failed: failed.length, total });
  };

  const worker = async () => {
    for (let midi = queue.shift(); midi !== undefined; midi = queue.shift()) await loadOne(midi);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return { buffers, failed };
}
