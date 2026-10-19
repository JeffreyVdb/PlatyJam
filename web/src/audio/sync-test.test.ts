import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../app/events';
import { createSongClock } from './clock';
import type { AudioEngineEvents } from './engine';
import type { GameAudio } from './game-audio';
import { createSyncTest, syncTestNotes } from './sync-test';
import { createTimeline, ZERO_OFFSETS } from './timeline';

describe('syncTestNotes', () => {
  it('puts a metronome note on every beat of a 3-minute, 120 BPM song', () => {
    const notes = syncTestNotes();
    const metronome = notes.filter((n) => n.pitch === 84 || n.pitch === 79);
    expect(metronome).toHaveLength(360);
    expect(metronome.slice(0, 5).map((n) => n.t)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(metronome.at(-1)?.t).toBe(179_500);
  });

  it('starts a chord on each downbeat, cycling C, G, Am, F', () => {
    const roots = syncTestNotes()
      .filter((n) => n.pitch < 50)
      .slice(0, 5)
      .map((n) => [n.t, n.pitch]);
    expect(roots).toEqual([
      [0, 48],
      [2000, 43],
      [4000, 45],
      [6000, 41],
      [8000, 48],
    ]);
  });
});

describe('createSyncTest', () => {
  it('stops when the engine is silenced, so the panel shows it stopped', () => {
    const context = { currentTime: 1 };
    const events = createEventBus<AudioEngineEvents>();
    const clock = createSongClock(() => context.currentTime);
    const timeline = createTimeline({
      clock,
      contextTimeAt: () => context.currentTime,
      nowMs: () => 0,
      offsets: () => ZERO_OFFSETS,
    });
    const accompaniment = {
      play: vi.fn(),
      stopAll: vi.fn(),
      stats: () => ({ active: true, scheduled: 0, skipped: 0, lastLeadMs: 0 }),
    };
    const audio = {
      engine: { context, events, clock, timeline, offsets: ZERO_OFFSETS },
      accompaniment,
    } as unknown as GameAudio;
    const sync = createSyncTest(audio, { nowMs: () => 0 });
    sync.start({ tempo: 1, source: 'piano' });
    expect(sync.readout().running).toBe(true);

    events.emit('silenced', { fadeMs: 40 });
    expect(sync.readout().running).toBe(false);
    expect(accompaniment.stopAll).toHaveBeenLastCalledWith(40);
    expect(clock.isRunning).toBe(false);
  });

  describe('with the recording file as its source', () => {
    function setup(loadFile: () => Promise<AudioBuffer | null>) {
      const started: { source: { playbackRate: { value: number } }; args: number[] }[] = [];
      const param = {
        value: 1,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      };
      const context = {
        currentTime: 1,
        createBufferSource() {
          const source = {
            playbackRate: { value: 1 },
            buffer: null as AudioBuffer | null,
            onended: null,
            connect: <T>(node: T) => node,
            disconnect: vi.fn(),
            start: (...args: number[]) => started.push({ source, args }),
            stop: vi.fn(),
          };
          return source;
        },
        createGain: () => ({ gain: param, connect: <T>(node: T) => node, disconnect: vi.fn() }),
      };
      const events = createEventBus<AudioEngineEvents>();
      const clock = createSongClock(() => context.currentTime);
      const timeline = createTimeline({
        clock,
        contextTimeAt: () => context.currentTime,
        nowMs: () => 0,
        offsets: () => ZERO_OFFSETS,
      });
      const setTuning = vi.fn();
      const audio = {
        engine: { context, output: {}, events, clock, timeline, offsets: ZERO_OFFSETS },
        accompaniment: {
          play: vi.fn(),
          stopAll: vi.fn(),
          stats: () => ({ active: false, scheduled: 0, skipped: 0, lastLeadMs: 0 }),
        },
        setTuning,
      } as unknown as GameAudio;
      return { sync: createSyncTest(audio, { loadFile }), started, clock, setTuning };
    }
    const decoded = { duration: 66 } as AudioBuffer;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('loads the file, then plays it from the lead-in at the chosen speed, tuning the pad to it', async () => {
      const loadFile = vi.fn(() => Promise.resolve(decoded));
      const { sync, started, clock, setTuning } = setup(loadFile);
      sync.start({ tempo: 1.25, source: 'file' });
      expect(sync.readout()).toMatchObject({ running: false, file: 'loading' });
      await settle();
      expect(sync.readout()).toMatchObject({
        running: true,
        source: 'file',
        file: 'idle',
        tempo: 1.25,
      });
      expect(sync.readout().durationMs).toBe(66_000);
      expect(started).toHaveLength(1);
      expect(started[0]?.source.playbackRate.value).toBe(1.25);
      expect(started[0]?.args[1]).toBe(0);
      expect(setTuning).toHaveBeenLastCalledWith(1.25);

      sync.stop();
      expect(setTuning).toHaveBeenLastCalledWith(1);
      expect(clock.isRunning).toBe(false);
    });

    it('decodes the file once, however often the test is started', async () => {
      const loadFile = vi.fn(() => Promise.resolve(decoded));
      const { sync, started } = setup(loadFile);
      sync.start({ tempo: 1, source: 'file' });
      await settle();
      sync.stop();
      sync.start({ tempo: 1, source: 'file' });
      await settle();
      expect(loadFile).toHaveBeenCalledOnce();
      expect(started).toHaveLength(2);
    });

    it('does not start when stopped while the file was still loading', async () => {
      const { sync, started } = setup(() => Promise.resolve(decoded));
      sync.start({ tempo: 1, source: 'file' });
      sync.stop();
      await settle();
      expect(started).toHaveLength(0);
      expect(sync.readout()).toMatchObject({ running: false, file: 'idle' });
    });

    it('says so when the file did not load, and tries again on the next start', async () => {
      const loadFile = vi.fn(() => Promise.resolve(null));
      const { sync, started } = setup(loadFile);
      sync.start({ tempo: 1, source: 'file' });
      await settle();
      expect(sync.readout()).toMatchObject({ running: false, file: 'failed' });
      expect(started).toHaveLength(0);
      sync.start({ tempo: 1, source: 'file' });
      expect(loadFile).toHaveBeenCalledTimes(2);
    });
  });
});
