import { createBackingTrack, type BackingTrack } from './backing-track';
import type { GameAudio } from './game-audio';
import type { AccompanimentNote } from './scheduler';

/**
 * The ?debug 3-minute sync test: generated accompaniment through the real
 * scheduler and song clock, so audible sync can be judged against a beat
 * indicator drawn from `songTime()`. Its third source plays the recorded fixture
 * (`public/songs/debug-backing.m4a`: a click per beat at the same 120 BPM over a D4
 * tone), fetched and decoded as a song's recording is, so the real file path can be
 * checked by ear too.
 */
export const SYNC_TEST_BPM = 120;
export const SYNC_TEST_MS = 180_000;
/** The backing-file variant is shorter: a generated buffer costs memory. */
export const SYNC_BACKING_MS = 60_000;
const LEAD_IN_MS = 1500;

// C, G, Am, F, one bar each.
const CHORDS = [
  [48, 55, 60, 64],
  [43, 55, 59, 62],
  [45, 57, 60, 64],
  [41, 53, 57, 60],
] as const;

/** A metronome on the piano (high C on the downbeat) over a four-chord loop. */
export function syncTestNotes(bpm = SYNC_TEST_BPM, durationMs = SYNC_TEST_MS): AccompanimentNote[] {
  const beatMs = 60_000 / bpm;
  const notes: AccompanimentNote[] = [];
  for (let beat = 0; beat * beatMs < durationMs; beat += 1) {
    const t = beat * beatMs;
    const downbeat = beat % 4 === 0;
    notes.push({ t, pitch: downbeat ? 84 : 79, dur: beatMs * 0.25, vel: downbeat ? 110 : 80 });
    if (downbeat) {
      const chord = CHORDS[(beat / 4) % CHORDS.length] ?? CHORDS[0];
      for (const pitch of chord) notes.push({ t, pitch, dur: beatMs * 3.6, vel: 55 });
    }
  }
  return notes;
}

/** A backing "file": a low tick on every beat, for the backing-track path. */
export function renderBackingTicks(
  ctx: BaseAudioContext,
  bpm = SYNC_TEST_BPM,
  durationMs = SYNC_BACKING_MS,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.round((durationMs / 1000) * rate), rate);
  const data = buffer.getChannelData(0);
  const beatFrames = (60 / bpm) * rate;
  const tickFrames = Math.round(0.04 * rate);
  for (let start = 0; start < data.length; start += beatFrames) {
    const first = Math.round(start);
    for (let i = 0; i < tickFrames && first + i < data.length; i += 1) {
      const t = i / rate;
      data[first + i] = Math.sin(2 * Math.PI * 660 * t) * Math.exp(-t / 0.012) * 0.6;
    }
  }
  return buffer;
}

/** `piano`: the scheduler; `backing`: a generated tick buffer; `file`: the decoded fixture file. */
export type SyncSource = 'piano' | 'backing' | 'file';

export interface SyncTestReadout {
  running: boolean;
  source: SyncSource;
  tempo: number;
  songMs: number;
  durationMs: number;
  beatMs: number;
  /** How far the audible output trails the context clock, real ms (≈ output latency). */
  outputLagMs: number;
  /** Context clock minus performance clock since the last (re)start, ms. Should stay near 0. */
  clockDriftMs: number;
  scheduled: number;
  skipped: number;
  lastLeadMs: number;
  /** The `file` source is downloading, or did not load. */
  file: 'idle' | 'loading' | 'failed';
}

export interface SyncTest {
  start(options: { tempo: number; source: SyncSource }): void;
  stop(): void;
  readout(): SyncTestReadout;
}

export interface SyncTestOptions {
  nowMs?: () => number;
  /** Fetches and decodes the fixture file for the `file` source; null when it failed. */
  loadFile?: () => Promise<AudioBuffer | null>;
}

export function createSyncTest(
  audio: GameAudio,
  { nowMs = () => performance.now(), loadFile = () => Promise.resolve(null) }: SyncTestOptions = {},
): SyncTest {
  const { engine, accompaniment } = audio;
  const beatMs = 60_000 / SYNC_TEST_BPM;
  let running = false;
  let source: SyncSource = 'piano';
  let durationMs = SYNC_TEST_MS;
  let backing: BackingTrack | undefined;
  let fileBuffer: AudioBuffer | undefined;
  let file: SyncTestReadout['file'] = 'idle';
  // Bumped by every start and stop, to drop a file download that was overtaken.
  let startToken = 0;
  let tuned = false;
  let anchor = { ctx: 0, perf: 0 };
  // Held while paused: a suspended context clock stands still.
  let clockDriftMs = 0;

  const reanchor = () => {
    anchor = { ctx: engine.context.currentTime, perf: nowMs() };
  };

  engine.events.on('interrupted', () => {
    backing?.stop(30);
  });
  engine.events.on('resumed', () => {
    if (!running) return;
    reanchor();
    backing?.play();
  });

  const stop = (fadeMs = 150) => {
    startToken += 1;
    if (file === 'loading') file = 'idle';
    running = false;
    if (tuned) audio.setTuning(1);
    tuned = false;
    accompaniment.stopAll(fadeMs);
    backing?.stop(fadeMs);
    backing = undefined;
    engine.clock.pause();
  };
  // The calibration needs quiet: end the test, so the debug panel shows it stopped.
  engine.events.on('silenced', ({ fadeMs }) => {
    if (running || file === 'loading') stop(fadeMs);
  });

  const begin = (
    options: { tempo: number; source: SyncSource },
    buffer: AudioBuffer | undefined,
  ) => {
    source = options.source;
    durationMs =
      source === 'piano' ? SYNC_TEST_MS : buffer ? buffer.duration * 1000 : SYNC_BACKING_MS;
    engine.clock.setTempo(options.tempo);
    engine.clock.start(-LEAD_IN_MS);
    reanchor();
    clockDriftMs = 0;
    running = true;
    if (source === 'piano') {
      accompaniment.play(syncTestNotes());
    } else {
      // Like a song's recording, the file's pitch follows the speed; so does the tap
      // pad's piano, which keeps it in tune with the tone.
      if (source === 'file') {
        audio.setTuning(options.tempo);
        tuned = true;
      }
      backing = createBackingTrack({
        target: engine,
        clock: engine.clock,
        audioOffsetMs: () => engine.offsets.audioOffsetMs,
        buffer: buffer ?? renderBackingTicks(engine.context),
      });
      backing.play();
    }
  };

  return {
    start(options) {
      stop();
      if (options.source !== 'file') {
        begin(options, undefined);
        return;
      }
      const token = startToken;
      source = 'file';
      file = fileBuffer ? 'idle' : 'loading';
      void (fileBuffer ? Promise.resolve(fileBuffer) : loadFile()).then((buffer) => {
        if (token !== startToken) return;
        if (!buffer) {
          file = 'failed';
          return;
        }
        fileBuffer = buffer;
        file = 'idle';
        begin(options, buffer);
      });
    },
    stop() {
      stop();
    },
    readout() {
      const { clock, timeline } = engine;
      const songMs = timeline.songTime();
      if (running && songMs > durationMs + 2000) stop();
      const ctxNow = engine.context.currentTime;
      const stats = accompaniment.stats();
      if (running && clock.isRunning) {
        clockDriftMs = (ctxNow - anchor.ctx) * 1000 - (nowMs() - anchor.perf);
      }
      return {
        running,
        source,
        tempo: clock.tempo,
        songMs,
        durationMs,
        beatMs,
        outputLagMs: clock.isRunning ? (clock.songTimeAt(ctxNow) - songMs) / clock.tempo : 0,
        clockDriftMs,
        scheduled: stats.scheduled,
        skipped: stats.skipped,
        lastLeadMs: stats.lastLeadMs,
        file,
      };
    },
  };
}
