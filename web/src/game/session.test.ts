import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../app/events';
import { createLifecycle } from '../app/lifecycle';
import type { AudioEngineEvents, EnginePhase } from '../audio/engine';
import { createSongClock } from '../audio/clock';
import { createTimeline } from '../audio/timeline';
import type { Chart, Tile } from '../chart/schema';
import {
  COUNTDOWN_BEAT_MS,
  createGameplaySession,
  REWIND_DURATION_MS,
  REWIND_SONG_MS,
  type SessionAudio,
} from './session';
import type { SessionSetup, SessionState } from './session-contract';
import { FINALIZE_GRACE_MS } from './simulation';

const tap = (t: number, lane: number, pitches = [60]): Tile => ({ t, lane, pitches, vel: 100 });
const hold = (t: number, lane: number, dur: number): Tile => ({
  t,
  lane,
  dur,
  pitches: [67, 64],
  vel: 80,
});

function chartWith(tiles: Tile[], durationMs = 4000): Chart {
  const difficulty = { tiles, accompaniment: [{ t: 0, pitch: 40, dur: 200, vel: 60 }] };
  return {
    version: 1,
    id: 'test-song',
    title: 'Test Song',
    composer: 'Nobody',
    arranger: 'Nobody',
    bpm: 120,
    durationMs,
    leadInMs: 1000,
    license: { source: 'https://example.com/', license: 'CC0 1.0', author: 'Nobody' },
    accompaniment: [{ t: 500, pitch: 48, dur: 400, vel: 70 }],
    difficulties: { easy: difficulty, normal: difficulty, hard: difficulty },
  };
}

/** A stand-in for GameAudio: a real song clock and timeline on a manual time source. */
function fakeAudio() {
  let ctxTime = 10;
  let perf = 50_000;
  const events = createEventBus<AudioEngineEvents>();
  const clock = createSongClock(() => ctxTime);
  // Context time and performance time move together in this fake.
  const timeline = createTimeline({
    clock,
    contextTimeAt: (perfMs) => ctxTime + (perfMs - perf) / 1000,
    nowMs: () => perf,
    offsets: () => ({ audioOffsetMs: 0, inputOffsetMs: 0 }),
  });
  const engine = {
    phase: 'running' as EnginePhase,
    events,
    clock,
    timeline,
    context: {
      get currentTime() {
        return ctxTime;
      },
    },
    resumeFromGesture: vi.fn(),
    resumeClock: vi.fn(() => {
      if (engine.phase === 'interrupted' || clock.isRunning) return;
      clock.resume();
      events.emit('resumed', { recreated: false });
    }),
  };
  const voices: { pitch: number; off?: number | 'now' }[] = [];
  const piano = {
    noteOn: vi.fn((pitch: number) => {
      const voice = { pitch, start: ctxTime };
      voices.push({ pitch });
      return voice;
    }),
    noteOff: vi.fn((voice: { pitch: number }, when?: number) => {
      const entry = voices.find((v) => v.pitch === voice.pitch && v.off === undefined);
      if (entry) entry.off = when ?? 'now';
    }),
    stopAll: vi.fn(),
  };
  const accompaniment = { play: vi.fn(), pause: vi.fn(), stopAll: vi.fn() };
  let finishSamples = (): void => undefined;
  const samples = {
    progress: { loaded: 0, failed: 0, total: 88 },
    ready: new Promise<void>((resolve) => {
      finishSamples = resolve;
    }),
  };
  const audio = { engine, piano, accompaniment, samples } as unknown as SessionAudio;
  return {
    audio,
    engine,
    piano,
    voices,
    accompaniment,
    finishSamples: () => {
      finishSamples();
    },
    /** Moves real time on by `ms`; the song moves by ms × tempo while the clock runs. */
    advance(ms: number) {
      ctxTime += ms / 1000;
      perf += ms;
    },
    get perf() {
      return perf;
    },
  };
}

describe('game session', () => {
  let fake: ReturnType<typeof fakeAudio>;
  let states: SessionState[];
  let session: ReturnType<typeof createGameplaySession>;
  let cleared: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fake = fakeAudio();
    session = createGameplaySession({
      audio: fake.audio,
      bus: createLifecycle(),
      now: () => fake.perf,
    });
    states = [];
    cleared = 0;
    session.attachInput({
      clear: () => {
        cleared += 1;
      },
    });
    session.events.on('statechange', ({ state }) => states.push(state));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (tiles: Tile[], overrides: Partial<SessionSetup> = {}): SessionSetup => ({
    chart: chartWith(tiles),
    difficulty: 'normal',
    tempo: 1,
    failMode: 'classic',
    scrollDurationMs: 1600,
    ...overrides,
  });

  const loaded = async (tiles: Tile[], overrides: Partial<SessionSetup> = {}) => {
    session.load(setup(tiles, overrides));
    fake.finishSamples();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe('ready');
  };

  /** Moves time on and renders a frame. */
  const frames = (ms: number, step = 16) => {
    for (let done = 0; done < ms; done += step) {
      fake.advance(step);
      session.update();
    }
  };

  const songMs = () => fake.engine.clock.position();
  /** Presses at the current moment. */
  const press = (input: string, lane: number) => {
    session.input.press(input, lane, fake.perf);
  };
  const release = (input: string) => {
    session.input.release(input, fake.perf);
  };

  describe('loading and start', () => {
    it('waits for the chart and the piano samples before showing Start', async () => {
      let deliver: (chart: Chart) => void = () => undefined;
      session.load({
        ...setup([tap(0, 0)]),
        chart: new Promise<Chart>((resolve) => {
          deliver = resolve;
        }),
      });
      expect(session.state).toBe('loading');
      fake.finishSamples();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.loading.chartLoaded).toBe(false);
      expect(session.state).toBe('loading');
      deliver(chartWith([tap(0, 0)]));
      await vi.advanceTimersByTimeAsync(0);
      expect(session.state).toBe('ready');
      expect(session.config?.chart.id).toBe('test-song');
    });

    it('reports a chart that failed to load', async () => {
      session.load({ ...setup([]), chart: Promise.reject(new Error('HTTP 404')) });
      fake.finishSamples();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.state).toBe('error');
      expect(session.error).toContain('HTTP 404');
    });

    it('starts the clock at minus the lead-in, at the tempo, with all the accompaniment', async () => {
      await loaded([tap(500, 0)], { tempo: 1.25 });
      states.length = 0;
      session.start();
      expect(states).toEqual(['starting', 'leadIn']);
      expect(fake.engine.clock.tempo).toBe(1.25);
      expect(songMs()).toBe(-1000);
      expect(fake.accompaniment.play).toHaveBeenCalledWith([
        { t: 500, pitch: 48, dur: 400, vel: 70 },
        { t: 0, pitch: 40, dur: 200, vel: 60 },
      ]);
      // Never the melody: no piano note until a tile is hit.
      expect(fake.piano.noteOn).not.toHaveBeenCalled();
    });

    it('waits for a locked context to unlock, and gives up after a while', async () => {
      await loaded([tap(500, 0)]);
      fake.engine.phase = 'locked';
      session.start();
      expect(session.state).toBe('starting');
      fake.engine.phase = 'running';
      fake.engine.events.emit('unlocked', {});
      expect(session.state).toBe('leadIn');

      session.quit();
      fake.engine.phase = 'locked';
      session.start();
      await vi.advanceTimersByTimeAsync(5000);
      // Back where Start was pressed.
      expect(session.state).toBe('quit');
    });

    it('recovers an interrupted context from the Start gesture without starting the old clock', async () => {
      await loaded([tap(500, 0)]);
      fake.engine.phase = 'interrupted';
      session.start();
      expect(fake.engine.resumeFromGesture).toHaveBeenCalledWith({ resumeClock: false });
      fake.engine.phase = 'running';
      fake.engine.events.emit('recovered', { recreated: false });
      expect(session.state).toBe('leadIn');
    });

    it('accepts early hits in the lead-in window and ignores other lead-in presses', async () => {
      await loaded([tap(50, 2, [72, 76])]);
      session.start();
      frames(800); // song ≈ -200
      press('p1', 0);
      expect(session.stats().miss).toBe(0);
      frames(176); // song ≈ -24
      press('p2', 2);
      expect(session.stats().good).toBe(1);
      expect(fake.piano.noteOn.mock.calls.map(([pitch]) => pitch)).toEqual([72, 76]);
      frames(48);
      expect(session.state).toBe('playing');
    });
  });

  describe('play', () => {
    it('plays a hit tile now, releases a tap after a short note and a hold on release', async () => {
      await loaded([tap(1000, 0), hold(1500, 1, 1000)]);
      session.start();
      frames(2000);
      press('a', 0);
      expect(fake.voices).toEqual([{ pitch: 60, off: expect.any(Number) as number }]);
      frames(496);
      press('b', 1);
      expect(fake.voices.slice(1)).toEqual([{ pitch: 67 }, { pitch: 64 }]);
      frames(992);
      release('b');
      expect(fake.voices.slice(1)).toEqual([
        { pitch: 67, off: 'now' },
        { pitch: 64, off: 'now' },
      ]);
      expect(session.stats()).toMatchObject({ perfect: 3, combo: 3 });
    });

    it('fails Classic on an empty tap: silences, rewinds, then reports the failure', async () => {
      await loaded([tap(1000, 0), tap(3000, 1)]);
      session.start();
      frames(2600); // song ≈ 1600: past one third of 4000
      press('a', 0); // lane 0 is empty now: the tile at 1000 expired
      expect(session.state).toBe('failing');
      expect(fake.accompaniment.stopAll).toHaveBeenCalled();
      expect(fake.piano.stopAll).toHaveBeenCalled();
      expect(session.results).toBeUndefined();
      await vi.advanceTimersByTimeAsync(3000);
      expect(session.state).toBe('finished');
      expect(session.results).toMatchObject({
        outcome: 'failed',
        failure: { kind: 'missedTile', lane: 0, tileIndex: 0 },
        miss: 1,
        // The song had passed a third before the Miss was finalized: that star stays.
        stars: 1,
        perfectBadge: false,
      });
    });

    it('rewinds the stage from where the clock stopped to just before the failure', async () => {
      await loaded([tap(1000, 0), tap(3000, 1)]);
      session.start();
      while (session.state !== 'failing') frames(16);
      const stoppedAt = songMs();
      // The Miss is finalized a grace after its late boundary.
      expect(stoppedAt).toBeGreaterThan(1120 + FINALIZE_GRACE_MS);
      expect(session.view().songMs).toBeCloseTo(stoppedAt);
      fake.advance(REWIND_DURATION_MS);
      // The failure is the expiry of the tile at 1000, at its late boundary.
      expect(session.view().songMs).toBeCloseTo(1120 - REWIND_SONG_MS);
      expect(songMs()).toBe(stoppedAt);
    });

    it('never takes back progress or stars shown before a failure', async () => {
      // One third of 3000 is 1000; the tap at 870 expires at 990.
      await loaded([tap(870, 0), tap(3000, 1)], {
        chart: chartWith([tap(870, 0), tap(3000, 1)], 3000),
      });
      session.start();
      while (songMs() < 1000) frames(16);
      expect(session.state).toBe('playing');
      const shown = { ...session.stats() };
      expect(shown.stars).toBe(1);
      while (session.state === 'playing') frames(16);
      expect(session.state).toBe('failing');
      const failing = { ...session.stats() };
      expect(failing.stars).toBeGreaterThanOrEqual(shown.stars);
      expect(failing.progress).toBeGreaterThanOrEqual(shown.progress);
      await vi.advanceTimersByTimeAsync(3000);
      expect(session.results?.outcome).toBe('failed');
      expect(session.results?.stars).toBe(failing.stars);
      expect(session.results?.progress).toBe(failing.progress);
    });

    it('keeps stars earned before a failure and names an empty tap', async () => {
      await loaded([tap(1000, 0), tap(3000, 1)]);
      session.start();
      frames(2000);
      press('a', 0);
      frames(1000); // song ≈ 2000: half way
      press('b', 3);
      await vi.advanceTimersByTimeAsync(3000);
      expect(session.results).toMatchObject({
        outcome: 'failed',
        failure: { kind: 'emptyTap', lane: 3 },
        stars: 1,
        perfect: 1,
        miss: 1,
      });
    });

    it('lets Relaxed play through misses to the end', async () => {
      await loaded([tap(1000, 0), tap(3000, 1)], { failMode: 'relaxed' });
      session.start();
      frames(4000);
      press('a', 1);
      frames(1300);
      expect(session.state).toBe('finished');
      expect(session.results).toMatchObject({ outcome: 'cleared', stars: 3, miss: 1, perfect: 1 });
    });

    it('finishes after durationMs with every unit resolved, with the Perfect badge', async () => {
      await loaded([tap(1000, 0)]);
      session.start();
      frames(2000);
      press('a', 0);
      frames(2900);
      expect(session.state).toBe('playing');
      // Completion waits for the finalization grace past durationMs.
      frames(150 + FINALIZE_GRACE_MS);
      expect(session.state).toBe('finished');
      expect(session.results).toMatchObject({
        outcome: 'cleared',
        songId: 'test-song',
        songTitle: 'Test Song',
        difficulty: 'normal',
        tempo: 1,
        failMode: 'classic',
        score: 100,
        accuracy: 100,
        maxCombo: 1,
        progress: 1,
        stars: 3,
        perfectBadge: true,
      });
    });
  });

  describe('pause and countdown', () => {
    it('freezes the song, silences it and forgets inputs; resume counts down before the clock moves', async () => {
      await loaded([tap(1000, 0), tap(3000, 1)]);
      session.start();
      frames(1500);
      session.pause();
      expect(session.state).toBe('paused');
      expect(session.pauseInfo).toEqual({ reason: 'player', audio: 'running', heldLanes: [] });
      expect(fake.accompaniment.pause).toHaveBeenCalled();
      expect(cleared).toBe(1);
      const held = songMs();
      frames(5000);
      expect(songMs()).toBe(held);
      // Presses while paused are not gameplay.
      expect(session.acceptsInput()).toBe(false);

      session.resume();
      expect(session.state).toBe('countdown');
      const beats: number[] = [];
      session.events.on('countdown', ({ beat }) => beats.push(beat));
      expect(session.countdown?.beat).toBe(3);
      await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS * 2);
      expect(beats).toEqual([2, 1]);
      expect(fake.engine.clock.isRunning).toBe(false);
      await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS);
      expect(fake.engine.resumeClock).toHaveBeenCalledOnce();
      expect(fake.engine.clock.isRunning).toBe(true);
      expect(session.state).toBe('playing');
      expect(songMs()).toBe(held);
    });

    it('recovers interrupted audio while the clock stays paused, then counts down', async () => {
      await loaded([tap(1000, 0), tap(3000, 1)]);
      session.start();
      frames(1500);
      fake.engine.phase = 'interrupted';
      fake.engine.clock.pause();
      fake.engine.events.emit('interrupted', { reason: 'background' });
      expect(session.pauseInfo?.reason).toBe('interrupted');
      expect(session.pauseInfo?.audio).toBe('interrupted');

      session.resume();
      expect(fake.engine.resumeFromGesture).toHaveBeenCalledWith({ resumeClock: false });
      expect(session.pauseInfo?.audio).toBe('recovering');
      fake.engine.events.emit('needsgesture', { recreate: true });
      expect(session.pauseInfo?.audio).toBe('needsGesture');
      expect(session.state).toBe('paused');

      session.resume();
      fake.engine.phase = 'running';
      fake.engine.events.emit('recovered', { recreated: true });
      expect(session.state).toBe('countdown');
      expect(fake.engine.clock.isRunning).toBe(false);
      await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS * 3);
      expect(session.state).toBe('playing');
    });

    it('lets held lanes be reclaimed during the countdown; others become tail Misses', async () => {
      await loaded([hold(1000, 0, 2000), hold(1000, 3, 2000)], { failMode: 'relaxed' });
      session.start();
      frames(2000);
      press('a', 0);
      press('b', 3);
      frames(500);
      session.pause('inputcancel');
      expect(session.pauseInfo?.heldLanes).toEqual([0, 3]);
      session.resume();
      expect(session.acceptsInput()).toBe(true);
      press('c', 3);
      expect(session.countdown?.reclaimedLanes).toEqual([3]);
      await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS * 3);
      expect(session.stats()).toMatchObject({ perfect: 2, miss: 1, combo: 0 });
      frames(1600 + FINALIZE_GRACE_MS);
      expect(session.stats()).toMatchObject({ perfect: 3, miss: 1 });
    });

    it('completes a hold still held at its tail when pausing just after it', async () => {
      await loaded([hold(1000, 0, 1000)]);
      session.start();
      frames(2000);
      press('a', 0);
      frames(1020); // song ≈ 2020: past the tail, still held, not yet finalized
      expect(session.stats()).toMatchObject({ perfect: 1 });
      session.pause();
      expect(session.stats()).toMatchObject({ perfect: 2, miss: 0 });
      expect(session.pauseInfo?.heldLanes).toEqual([]);
      session.resume();
      await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS * 3);
      expect(session.state).toBe('playing');
      expect(session.stats()).toMatchObject({ perfect: 2, miss: 0 });
    });

    it('settles a Miss already due when pausing, then fails instead of pausing', async () => {
      await loaded([tap(1000, 0), tap(3000, 1)]);
      session.start();
      frames(2200); // song ≈ 1200: the tap at 1000 is past its late boundary
      expect(session.state).toBe('playing');
      session.pause();
      expect(session.state).toBe('failing');
      expect(session.pauseInfo).toBeUndefined();
    });

    it('fails Classic on resume when a held lane was not reclaimed', async () => {
      await loaded([hold(1000, 0, 2000)]);
      session.start();
      frames(2000);
      press('a', 0);
      frames(500);
      session.pause();
      session.resume();
      await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS * 3);
      expect(session.state).toBe('failing');
      expect(fake.engine.clock.isRunning).toBe(false);
    });

    it('pauses again if interrupted during the countdown', async () => {
      await loaded([tap(3000, 0)]);
      session.start();
      frames(1500);
      session.pause();
      session.resume();
      session.pause('blur');
      await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS * 5);
      expect(session.state).toBe('paused');
      expect(session.pauseInfo?.reason).toBe('blur');
    });
  });

  describe('quit and restart', () => {
    it('quit silences everything and returns to a startable state', async () => {
      await loaded([tap(1000, 0)]);
      session.start();
      frames(500);
      session.quit();
      expect(session.state).toBe('quit');
      expect(fake.accompaniment.stopAll).toHaveBeenCalled();
      expect(fake.engine.clock.isRunning).toBe(false);
      expect(session.results).toBeUndefined();
      session.start();
      expect(session.state).toBe('leadIn');
      expect(session.stats().score).toBe(0);
    });

    it('restart begins a fresh run from a pause', async () => {
      await loaded([tap(1000, 0), tap(2000, 0)]);
      session.start();
      frames(2000);
      press('a', 0);
      session.pause();
      session.restart();
      expect(session.state).toBe('leadIn');
      expect(songMs()).toBe(-1000);
      expect(session.stats()).toMatchObject({ score: 0, perfect: 0 });
    });

    it('quits when something else silences the engine (the calibration)', async () => {
      await loaded([tap(1000, 0)]);
      session.start();
      fake.engine.events.emit('silenced', { fadeMs: 50 });
      expect(session.state).toBe('quit');
    });
  });
});
