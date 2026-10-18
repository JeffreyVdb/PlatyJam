import type { Midi } from '@tonejs/midi';
import type { SongConfig } from './config.ts';

/** A note as read from the MIDI file, before timing. */
export interface SourceNote {
  pitch: number;
  /** Onset, MIDI ticks. */
  tick: number;
  durTicks: number;
  /** MIDI velocity, 1–127. */
  vel: number;
}

export interface TrackInfo {
  /** Index in the file's tracks, as `melody.track` takes it. */
  index: number;
  name: string;
  /** 0-based MIDI channel. */
  channel: number;
  notes: number;
  percussion: boolean;
  melody: boolean;
}

export interface SplitNotes {
  melody: SourceNote[];
  accompaniment: SourceNote[];
  tracks: TrackInfo[];
}

/** 0-based channel 9 is General MIDI channel 10, the drum kit. */
const PERCUSSION_CHANNEL = 9;

/** @tonejs/midi velocity (0–1) to a MIDI velocity, never 0 (which means note off). */
export function velocityToMidi(velocity: number): number {
  return Math.min(127, Math.max(1, Math.round(velocity * 127)));
}

/**
 * Splits the file's notes into melody (future tiles) and accompaniment, following
 * the song's `melody` selection. Drum tracks are dropped unless `includePercussion`.
 * Throws when the selection matches no notes.
 */
export function splitMelody(
  midi: Pick<Midi, 'tracks'>,
  { melody: select, includePercussion }: Pick<SongConfig, 'melody' | 'includePercussion'>,
): SplitNotes {
  const hasSelector =
    select.track !== undefined || select.trackName !== undefined || select.channel !== undefined;
  const firstWithNotes = midi.tracks.findIndex(
    (track) => track.notes.length > 0 && !isPercussion(track),
  );

  const result: SplitNotes = { melody: [], accompaniment: [], tracks: [] };
  midi.tracks.forEach((track, index) => {
    const percussion = isPercussion(track);
    const isMelody =
      !percussion &&
      (hasSelector
        ? (select.track === undefined || select.track === index) &&
          (select.trackName === undefined || select.trackName === track.name) &&
          (select.channel === undefined || select.channel === track.channel)
        : index === firstWithNotes);
    result.tracks.push({
      index,
      name: track.name,
      channel: track.channel,
      notes: track.notes.length,
      percussion,
      melody: isMelody,
    });
    if (percussion && !includePercussion) return;

    for (const note of track.notes) {
      const source: SourceNote = {
        pitch: note.midi,
        tick: note.ticks,
        durTicks: note.durationTicks,
        vel: velocityToMidi(note.velocity),
      };
      const toMelody =
        isMelody && (select.splitPitch === undefined || note.midi >= select.splitPitch);
      (toMelody ? result.melody : result.accompaniment).push(source);
    }
  });

  if (result.melody.length === 0) {
    throw new Error(`The melody selection ${JSON.stringify(select)} matches no notes`);
  }
  return result;
}

function isPercussion(track: Midi['tracks'][number]): boolean {
  return track.instrument.percussion || track.channel === PERCUSSION_CHANNEL;
}
