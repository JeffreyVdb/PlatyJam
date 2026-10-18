import midiPkg from '@tonejs/midi';
import { composeSong, type GenNote } from './compose.ts';
import type { SongParams } from './params.ts';

// @tonejs/midi is CommonJS: Node only exposes its exports object as the default.
const { Midi } = midiPkg;

/**
 * The MIDI file of a generated song: a `melody` track (channel 0, first, so the
 * converter picks it) and an `accompaniment` track (channel 1). Pure: the same
 * parameters always give the same bytes.
 */
export function generateSongMidi(params: SongParams): Uint8Array {
  const song = composeSong(params);
  const midi = new Midi();
  midi.header.tempos = [{ ticks: 0, bpm: params.bpm }];
  midi.header.timeSignatures = [{ ticks: 0, timeSignature: [4, 4] }];
  midi.header.keySignatures = [{ ticks: 0, key: params.key, scale: 'major' }];
  midi.header.update();
  addTrack(midi, 'melody', 0, song.melody);
  addTrack(midi, 'accompaniment', 1, song.accompaniment);
  return midi.toArray();
}

function addTrack(
  midi: InstanceType<typeof Midi>,
  name: string,
  channel: number,
  notes: GenNote[],
) {
  const track = midi.addTrack();
  track.name = name;
  track.channel = channel;
  for (const { tick, dur, pitch, velocity } of notes) {
    track.addNote({ midi: pitch, ticks: tick, durationTicks: dur, velocity });
  }
}
