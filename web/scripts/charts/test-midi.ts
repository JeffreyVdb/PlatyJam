// Test helpers: small MIDI files built in memory with @tonejs/midi.
import midiPkg from '@tonejs/midi';

const { Midi } = midiPkg;

export const PPQ = 480;

export interface FixtureNote {
  /** Onset in quarter notes from the start. */
  beat: number;
  /** Length in quarter notes. */
  len: number;
  pitch: number;
  /** 0–1, as @tonejs/midi takes it. */
  velocity?: number;
}

export interface FixtureTrack {
  name?: string;
  /** 0-based; 9 is the drum channel. */
  channel?: number;
  notes: FixtureNote[];
}

export interface FixtureOptions {
  /** Tempo changes; default 120 BPM throughout. */
  tempos?: { beat: number; bpm: number }[];
  timeSignatures?: { beat: number; sig: [number, number] }[];
}

/** A MIDI file (ppq 480) with the given tracks. */
export function midiBytes(tracks: FixtureTrack[], options: FixtureOptions = {}): Uint8Array {
  const midi = new Midi();
  const { tempos = [{ beat: 0, bpm: 120 }], timeSignatures = [] } = options;
  midi.header.tempos = tempos.map(({ beat, bpm }) => ({ ticks: beat * PPQ, bpm }));
  midi.header.timeSignatures = timeSignatures.map(({ beat, sig }) => ({
    ticks: beat * PPQ,
    timeSignature: sig,
  }));
  midi.header.update();
  for (const { name = '', channel = 0, notes } of tracks) {
    const track = midi.addTrack();
    track.name = name;
    track.channel = channel;
    for (const { beat, len, pitch, velocity = 0.7 } of notes) {
      track.addNote({
        midi: pitch,
        ticks: Math.round(beat * PPQ),
        durationTicks: Math.round(len * PPQ),
        velocity,
      });
    }
  }
  return midi.toArray();
}

/** Deterministic pseudo-random numbers in [0, 1) (a small LCG), for generated melodies. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * A 32-bar 4/4 piece at 120 BPM in the style of an easy piano piece: bars of
 * quarters, eighths, sixteenth runs, and half notes, with chords on downbeats and
 * on some weak beats,
 * over a left hand of broken chords.
 */
export function realisticPiece(seed = 7): FixtureTrack[] {
  const random = seededRandom(seed);
  const right: FixtureNote[] = [];
  const left: FixtureNote[] = [];
  let pitch = 72;
  const step = () => {
    pitch += Math.floor(random() * 7) - 3;
    pitch = Math.min(84, Math.max(62, pitch));
    return pitch;
  };
  const bars: number[][] = [
    [1, 1, 1, 1],
    [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1],
    [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 1, 1],
    [2, 1, 0.5, 0.5],
  ];
  for (let bar = 0; bar < 32; bar += 1) {
    let beat = bar * 4;
    const rhythm = bars[bar % bars.length] ?? [4];
    rhythm.forEach((len, i) => {
      const p = step();
      right.push({ beat, len, pitch: p, velocity: 0.5 + random() * 0.4 });
      if (i === 0 && bar % 2 === 0) right.push({ beat, len, pitch: p - 4 });
      if (i === 0 && bar % 4 === 0) right.push({ beat, len, pitch: p - 7 });
      if (i === 1 && bar % 2 === 1) right.push({ beat, len, pitch: p - 3 });
      beat += len;
    });
    const root = 48 + (bar % 4) * 2;
    for (let i = 0; i < 4; i += 1)
      left.push({ beat: bar * 4 + i, len: 1, pitch: root + ([0, 7, 4, 7][i] ?? 0) });
  }
  return [
    { name: 'right', channel: 0, notes: right },
    { name: 'left', channel: 1, notes: left },
  ];
}
