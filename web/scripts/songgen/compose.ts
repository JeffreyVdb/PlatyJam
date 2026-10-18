import { KEYS, type SongParams } from './params.ts';
import { chance, mulberry32, pick, type Random } from './random.ts';

/** Ticks per quarter note (@tonejs/midi's default). */
export const PPQ = 480;
const EIGHTH = PPQ / 2;
/** Ticks per bar: the generator writes 4/4 only. */
export const BAR = PPQ * 4;

export interface GenNote {
  tick: number;
  /** Length in ticks. */
  dur: number;
  pitch: number;
  /** 0–1, as @tonejs/midi takes it. */
  velocity: number;
}

export interface Composition {
  bars: number;
  durationSeconds: number;
  /** Every melody pitch lies in [low, high]. */
  range: { low: number; high: number };
  melody: GenNote[];
  accompaniment: GenNote[];
}

/** Semitones above the tonic of the major scale's seven degrees. */
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

/**
 * Four-bar progressions, one chord per bar, as scale degrees (0 = I, 4 = V). A
 * phrases start at home; B phrases start away from it.
 */
const A_PROGRESSIONS = [
  [0, 4, 5, 3],
  [0, 5, 3, 4],
  [0, 3, 4, 0],
  [0, 3, 0, 4],
  [0, 5, 1, 4],
];
const B_PROGRESSIONS = [
  [3, 4, 2, 5],
  [5, 1, 3, 4],
  [3, 0, 3, 4],
  [1, 4, 0, 5],
  [5, 3, 1, 4],
];

/** Melody rhythms of one bar, in eighths (eight per bar). */
const RHYTHMS = [
  [2, 2, 2, 2],
  [2, 1, 1, 2, 2],
  [1, 1, 2, 1, 1, 2],
  [3, 1, 2, 2],
  [2, 2, 1, 1, 2],
  [4, 2, 2],
  [2, 2, 4],
];
/** Rhythms of a phrase's last bar: they come to rest on a long note. */
const CADENCE_RHYTHMS = [
  [2, 2, 4],
  [4, 4],
  [3, 1, 4],
];

/** Melody velocity on the downbeat, elsewhere, and of the harmony note under it. */
const VELOCITY = { downbeat: 0.8, other: 0.7, harmony: 0.6 };
/** Left-hand pattern per beat: which chord tone, and how loud. */
const BASS_PATTERN = [
  { tone: 'root', velocity: 0.55 },
  { tone: 'fifth', velocity: 0.45 },
  { tone: 'tenth', velocity: 0.5 },
  { tone: 'fifth', velocity: 0.45 },
] as const;

interface Key {
  tonic: number;
  /** The tonic the melody starts from, A3 to G#4. */
  home: number;
  /** Diatonic pitches the melody may use, low to high. */
  scale: number[];
}

/** Where the melody is: an index into `Key.scale`, and which way it is moving. */
interface MelodyState {
  index: number;
  dir: 1 | -1;
}

interface Phrase {
  melody: GenNote[];
  accompaniment: GenNote[];
}

/**
 * Writes a short piano piece from the parameters. Pure and deterministic: every
 * choice comes from a PRNG seeded with `params.seed`.
 *
 * Each letter of `form` is one phrase of `phraseBars` bars, composed once and
 * repeated wherever the letter recurs. The harmony is one chord per bar from a
 * common progression; A phrases end with a V–I cadence, B phrases on V. The melody
 * puts chord tones on beats 1 and 3 and moves by scale steps in between, with a
 * harmony note under the first note and the last note of each phrase. The left hand
 * plays the chord as root, fifth, tenth, fifth. The last bar is a whole-note tonic
 * chord in both hands.
 */
export function composeSong(params: SongParams): Composition {
  const random = mulberry32(params.seed);
  const key = keyOf(params.key);
  const progressions = { A: pick(random, A_PROGRESSIONS), B: pick(random, B_PROGRESSIONS) };
  const state: MelodyState = { index: key.scale.indexOf(key.home + 4), dir: 1 };

  const phrases = new Map<string, Phrase>();
  for (const letter of params.form) {
    if (phrases.has(letter)) continue;
    const home = letter === 'A';
    const chords = phraseChords(progressions[home ? 'A' : 'B'], params.phraseBars, home);
    phrases.set(letter, composePhrase(random, key, chords, state, home));
  }

  const phraseTicks = params.phraseBars * BAR;
  const bars = params.form.length * params.phraseBars;
  const lastBar = (bars - 1) * BAR;
  const melody: GenNote[] = [];
  const accompaniment: GenNote[] = [];
  for (let i = 0; i < params.form.length; i += 1) {
    const phrase = phrases.get(params.form.charAt(i));
    if (!phrase) continue;
    const shift = (note: GenNote) => ({ ...note, tick: note.tick + i * phraseTicks });
    melody.push(...phrase.melody.map(shift).filter((note) => note.tick < lastBar));
    accompaniment.push(...phrase.accompaniment.map(shift).filter((note) => note.tick < lastBar));
  }

  // The final bar: the tonic nearest the melody's last note, as a whole-note chord.
  const lastTick = Math.max(...melody.map((note) => note.tick));
  const lastPitch = Math.max(...melody.filter((n) => n.tick === lastTick).map((n) => n.pitch));
  const top = nearestIndex(key, key.scale.indexOf(lastPitch), new Set([key.tonic]));
  const tonicChord = chordTones(key, 0);
  melody.push(...withHarmony(key, top, tonicChord, lastBar, BAR, VELOCITY.downbeat));
  const root = bassRoot(key, 0);
  for (const pitch of [root, root + 7, root + 12]) {
    accompaniment.push({ tick: lastBar, dur: BAR, pitch, velocity: 0.55 });
  }

  const sortNotes = (a: GenNote, b: GenNote) => a.tick - b.tick || a.pitch - b.pitch;
  return {
    bars,
    durationSeconds: (bars * 4 * 60) / params.bpm,
    range: { low: key.scale[0] ?? key.home, high: key.scale.at(-1) ?? key.home },
    melody: melody.sort(sortNotes),
    accompaniment: accompaniment.sort(sortNotes),
  };
}

function keyOf(name: SongParams['key']): Key {
  const tonic = KEYS[name];
  const home = 57 + ((tonic - 9 + 12) % 12);
  const scale: number[] = [];
  // A tenth above the tonic leaves room for a phrase to climb and come back.
  for (let pitch = home; pitch <= home + 16; pitch += 1) {
    if (MAJOR_SCALE.includes((pitch - tonic + 12) % 12)) scale.push(pitch);
  }
  return { tonic, home, scale };
}

/** Pitch classes of the triad on a scale degree. */
function chordTones(key: Key, degree: number): Set<number> {
  return new Set(
    [0, 2, 4].map((steps) => (key.tonic + (MAJOR_SCALE[(degree + steps) % 7] ?? 0)) % 12),
  );
}

/**
 * The progression repeated over the phrase. It ends V–I (a full cadence) or, when
 * the phrase leads back home, on V (a half cadence).
 */
function phraseChords(progression: readonly number[], bars: number, full: boolean): number[] {
  const chords = Array.from({ length: bars }, (_, bar) => progression[bar % 4] ?? 0);
  if (full) {
    chords[bars - 2] = 4;
    chords[bars - 1] = 0;
  } else {
    chords[bars - 1] = 4;
  }
  return chords;
}

/** Rhythms for each bar: the second half of an 8-bar phrase echoes the first. */
function phraseRhythms(random: Random, bars: number): number[][] {
  const rhythms: number[][] = [];
  for (let bar = 0; bar < bars - 1; bar += 1) {
    rhythms.push(bar >= 4 ? (rhythms[bar - 4] ?? [8]) : pick(random, RHYTHMS));
  }
  rhythms.push(pick(random, CADENCE_RHYTHMS));
  return rhythms;
}

function composePhrase(
  random: Random,
  key: Key,
  chords: readonly number[],
  state: MelodyState,
  endOnTonic: boolean,
): Phrase {
  const rhythms = phraseRhythms(random, chords.length);
  const melody: GenNote[] = [];
  const accompaniment: GenNote[] = [];
  chords.forEach((degree, bar) => {
    const tones = chordTones(key, degree);
    const rhythm = rhythms[bar] ?? [8];
    let pos = 0;
    rhythm.forEach((len, i) => {
      const tick = bar * BAR + pos * EIGHTH;
      const first = bar === 0 && i === 0;
      const final = bar === chords.length - 1 && i === rhythm.length - 1;
      if (final) {
        state.index = nearestIndex(key, state.index, endOnTonic ? new Set([key.tonic]) : tones);
      } else if (pos % 4 === 0) {
        state.index = chordToneNear(random, key, state.index, tones);
      } else {
        state.index = step(random, key, state);
      }
      const velocity = pos === 0 ? VELOCITY.downbeat : VELOCITY.other;
      if (first || final) {
        melody.push(...withHarmony(key, state.index, tones, tick, len * EIGHTH, velocity));
      } else {
        melody.push({ tick, dur: len * EIGHTH, pitch: pitchAt(key, state.index), velocity });
      }
      pos += len;
    });

    const root = bassRoot(key, degree);
    const pitches = {
      root,
      fifth: root + degreeInterval(degree, 4),
      tenth: root + 12 + degreeInterval(degree, 2),
    };
    BASS_PATTERN.forEach(({ tone, velocity }, beat) => {
      accompaniment.push({
        tick: bar * BAR + beat * PPQ,
        dur: PPQ,
        pitch: pitches[tone],
        velocity,
      });
    });
  });
  return { melody, accompaniment };
}

/** On a strong beat: one of the two chord tones closest to the current note. */
function chordToneNear(random: Random, key: Key, index: number, tones: Set<number>): number {
  const candidates = key.scale
    .map((pitch, i) => ({ i, distance: Math.abs(i - index), tone: tones.has(pitch % 12) }))
    .filter(({ tone }) => tone)
    .sort((a, b) => a.distance - b.distance || a.i - b.i)
    .slice(0, 2)
    .map(({ i }) => i);
  return pick(random, candidates);
}

/** Off the strong beats: a scale step, mostly onward, turning back at the edges. */
function step(random: Random, key: Key, state: MelodyState): number {
  if (chance(random, 0.25)) state.dir = state.dir === 1 ? -1 : 1;
  if (state.index + state.dir < 0 || state.index + state.dir >= key.scale.length) {
    state.dir = state.dir === 1 ? -1 : 1;
  }
  return state.index + state.dir;
}

/** The scale index nearest `index` whose pitch class is in `tones`; lower on a tie. */
function nearestIndex(key: Key, index: number, tones: Set<number>): number {
  let best = -1;
  key.scale.forEach((pitch, i) => {
    if (!tones.has(pitch % 12)) return;
    if (best < 0 || Math.abs(i - index) < Math.abs(best - index)) best = i;
  });
  return best < 0 ? index : best;
}

/** The note at `index`, plus the next chord tone below it when there is one. */
function withHarmony(
  key: Key,
  index: number,
  tones: Set<number>,
  tick: number,
  dur: number,
  velocity: number,
): GenNote[] {
  const notes = [{ tick, dur, pitch: pitchAt(key, index), velocity }];
  for (let below = index - 2; below >= 0; below -= 1) {
    const pitch = pitchAt(key, below);
    if (tones.has(pitch % 12)) {
      notes.push({ tick, dur, pitch, velocity: VELOCITY.harmony });
      break;
    }
  }
  return notes;
}

function pitchAt(key: Key, index: number): number {
  const pitch = key.scale[index];
  if (pitch === undefined) throw new Error(`melody index ${index} is out of range`);
  return pitch;
}

/** The chord's root, one to two octaves below the melody's home tonic. */
function bassRoot(key: Key, degree: number): number {
  return key.home - 24 + (MAJOR_SCALE[degree] ?? 0);
}

/** Semitones from a scale degree up to the degree `steps` scale steps above it. */
function degreeInterval(degree: number, steps: number): number {
  const from = MAJOR_SCALE[degree % 7] ?? 0;
  return ((MAJOR_SCALE[(degree + steps) % 7] ?? 0) - from + 12) % 12;
}
