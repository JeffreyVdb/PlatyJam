import midiPkg from '@tonejs/midi';
import {
  DIFFICULTIES,
  parseChart,
  tileEnd,
  type Chart,
  type Difficulty,
  type DifficultyName,
  type Note,
} from '../../src/chart/schema.ts';
import { clusterNotes, compareNotes, selectClusters, type Cluster } from './clusters.ts';
import { thresholdsFor, type SongConfig, type Thresholds } from './config.ts';
import { splitMelody, type TrackInfo } from './extract.ts';
import { placeTiles } from './lanes.ts';
import { laneRuleIssues } from './rules.ts';
import { strengthAt, timeNotes, type TimedNote } from './timing.ts';

// @tonejs/midi is CommonJS: Node only exposes its exports object as the default.
const { Midi } = midiPkg;

export interface DifficultyStats {
  tiles: number;
  holds: number;
  /** Times with two tiles. */
  doubles: number;
  /** Tiles per second of song. */
  nps: number;
}

export interface Conversion {
  chart: Chart;
  stats: Record<DifficultyName, DifficultyStats>;
  tracks: TrackInfo[];
}

/**
 * Converts a MIDI file into a validated chart. Pure and deterministic: the same
 * bytes and config always give the same chart. Throws if the result breaks the
 * chart schema or a lane rule.
 */
export function convertMidi(
  data: Uint8Array | ArrayBuffer,
  config: SongConfig,
  id: string,
): Conversion {
  const midi = new Midi(data);
  const { header } = midi;
  const split = splitMelody(midi, config);
  const ticksToMs = (tick: number) => header.ticksToSeconds(tick) * 1000;
  const quantize = {
    step: header.ppq / config.quantize.grid,
    tolerance: config.quantize.tolerance,
  };
  const melody = timeNotes(split.melody, ticksToMs, quantize);
  const accompaniment = timeNotes(split.accompaniment, ticksToMs, quantize);

  // t = 0 is the first note of the song, melody or accompaniment.
  const start = Math.min(...[...melody, ...accompaniment].map((note) => note.t));
  for (const note of [...melody, ...accompaniment]) note.t -= start;

  const meter = {
    ppq: header.ppq,
    timeSignatures: [...header.timeSignatures].sort((a, b) => a.ticks - b.ticks),
  };
  const clusters = clusterNotes(melody, config.mergeWindowMs, (tick) => strengthAt(tick, meter));
  const pitches = melody.map((note) => note.pitch);
  const pitchRange = { low: Math.min(...pitches), high: Math.max(...pitches) };

  const thresholds = Object.fromEntries(
    DIFFICULTIES.map((name) => [name, thresholdsFor(config, name)]),
  ) as Record<DifficultyName, Thresholds>;
  const difficulties = Object.fromEntries(
    DIFFICULTIES.map((name) => [name, buildDifficulty(clusters, thresholds[name], pitchRange)]),
  ) as Record<DifficultyName, Difficulty>;

  const topNotes = [...accompaniment].sort(compareNotes).map(toNote);
  const ends = [
    ...topNotes.map((note) => note.t + note.dur),
    ...Object.values(difficulties).flatMap(({ tiles, accompaniment: notes = [] }) => [
      ...tiles.map(tileEnd),
      ...notes.map((note) => note.t + note.dur),
    ]),
  ];
  const { license } = config;
  const chart = parseChart({
    version: 1,
    id,
    title: config.title,
    composer: config.composer,
    arranger: config.arranger,
    bpm: Math.round((header.tempos[0]?.bpm ?? 120) * 100) / 100,
    durationMs: Math.max(...ends),
    leadInMs: config.leadInMs,
    license: {
      source: license.source,
      license: license.license,
      licenseUrl: license.licenseUrl,
      author: license.author,
    },
    audio: config.audio && { src: config.audio.src, offsetMs: config.audio.offsetMs },
    accompaniment: topNotes,
    difficulties,
  } satisfies Chart);

  const problems = DIFFICULTIES.flatMap((name) =>
    laneRuleIssues(chart.difficulties[name].tiles, thresholds[name].minLaneGapMs).map(
      ({ index, message }) => `${name} tile ${index}: ${message}`,
    ),
  );
  if (problems.length > 0) throw new Error(`Lane rules broken:\n${problems.join('\n')}`);

  const stats = Object.fromEntries(
    DIFFICULTIES.map((name) => [name, difficultyStats(chart.difficulties[name], chart.durationMs)]),
  ) as Record<DifficultyName, DifficultyStats>;
  return { chart, stats, tracks: split.tracks };
}

/**
 * One difficulty: thin the clusters, place the rest as tiles, and give every melody
 * note that did not become a tile to this difficulty's accompaniment.
 */
export function buildDifficulty(
  clusters: readonly Cluster[],
  thresholds: Thresholds,
  pitchRange: { low: number; high: number },
): Difficulty {
  const keep = selectClusters(clusters, thresholds.minStrength, thresholds.minIntervalMs);
  const dropped = clusters.filter((_, i) => !keep[i]).flatMap((cluster) => cluster.notes);
  const { tiles, leftover } = placeTiles(
    clusters.filter((_, i) => keep[i]),
    { ...thresholds, pitchRange },
  );
  const notes = [...dropped, ...leftover].sort(compareNotes).map(toNote);
  return notes.length > 0 ? { tiles, accompaniment: notes } : { tiles };
}

export function difficultyStats({ tiles }: Difficulty, durationMs: number): DifficultyStats {
  const doubles = tiles.filter((tile, i) => tiles[i - 1]?.t === tile.t).length;
  const seconds = durationMs / 1000;
  return {
    tiles: tiles.length,
    holds: tiles.filter((tile) => tile.dur !== undefined).length,
    doubles,
    nps: seconds > 0 ? Math.round((tiles.length / seconds) * 100) / 100 : 0,
  };
}

function toNote({ t, pitch, dur, vel }: TimedNote): Note {
  return { t, pitch, dur, vel };
}
