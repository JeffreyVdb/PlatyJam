import type { InstancedMesh, Object3D, WebGLRenderer } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../app/events';
import { createLifecycle, type Lifecycle } from '../app/lifecycle';
import type { AudioEngineEvents, EnginePhase } from '../audio/engine';
import { createSongClock } from '../audio/clock';
import { createTimeline } from '../audio/timeline';
import { PAUSE_FADE_MS } from '../audio/scheduler';
import type { Chart, Tile } from '../chart/schema';
import {
  COUNTDOWN_BEAT_MS,
  createGameplaySession,
  END_FADE_MS,
  FAIL_FADE_MS,
  QUIT_FADE_MS,
  REWIND_DURATION_MS,
  REWIND_SONG_MS,
  type SessionAudio,
  TAP_NOTE_S,
} from './session';
import type { SessionSetup, SessionState } from './session-contract';
import { FINALIZE_GRACE_MS } from './simulation';
import type { LaneSpot } from './input';
import { POP_MS } from './tiles-simulation';
import { createGameStage, type GameStage } from '../scene/game-stage';

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
  let inputOffsetMs = 0;
  let outputLagMs = 0;
  const events = createEventBus<AudioEngineEvents>();
  const clock = createSongClock(() => ctxTime);
  // Context time and performance time move together in this fake; what is heard
  // trails the context by `outputLagMs`.
  const timeline = createTimeline({
    clock,
    contextTimeAt: (perfMs) => ctxTime + (perfMs - perf - outputLagMs) / 1000,
    nowMs: () => perf,
    offsets: () => ({ audioOffsetMs: 0, inputOffsetMs }),
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
  // The recording: loads at once (as `loaded`) unless `holdBacking` or `failBacking` say otherwise.
  const backingControl = { hold: false, fail: false };
  let releaseBacking: () => void = () => undefined;
  const backing = {
    state: 'none' as 'none' | 'loading' | 'loaded' | 'failed',
    load: vi.fn(async (audio: { src: string } | undefined) => {
      if (!audio) {
        backing.state = 'none';
        return;
      }
      backing.state = 'loading';
      if (backingControl.hold) {
        await new Promise<void>((resolve) => {
          releaseBacking = resolve;
        });
      }
      backing.state = backingControl.fail ? 'failed' : 'loaded';
    }),
    play: vi.fn(),
    pause: vi.fn(),
    stopAll: vi.fn(),
  };
  const setTuning = vi.fn();
  let finishSamples: (samples: { failed: number[] }) => void = () => undefined;
  const samples = {
    progress: { loaded: 0, failed: 0, total: 88 },
    ready: new Promise<{ failed: number[] }>((resolve) => {
      finishSamples = resolve;
    }),
  };
  const audio = {
    engine,
    piano,
    accompaniment,
    backing,
    setTuning,
    samples,
  } as unknown as SessionAudio;
  return {
    audio,
    engine,
    piano,
    voices,
    accompaniment,
    backing,
    setTuning,
    backingControl,
    releaseBacking: () => {
      releaseBacking();
    },
    /** Finishes loading the piano; `failed` lists the MIDI notes that did not load. */
    finishSamples: (failed: number[] = []) => {
      samples.progress = { loaded: 88 - failed.length, failed: failed.length, total: 88 };
      finishSamples({ failed });
    },
    /** Moves real time on by `ms`; the song moves by ms × tempo while the clock runs. */
    advance(ms: number) {
      ctxTime += ms / 1000;
      perf += ms;
    },
    get perf() {
      return perf;
    },
    /** The calibrated input latency, in real ms. */
    set inputOffsetMs(ms: number) {
      inputOffsetMs = ms;
    },
    /** How far the audible (displayed) song time trails the clock's, in real ms. */
    set outputLagMs(ms: number) {
      outputLagMs = ms;
    },
  };
}

describe('game session', () => {
  let fake: ReturnType<typeof fakeAudio>;
  let states: SessionState[];
  let session: ReturnType<typeof createGameplaySession>;
  let bus: Lifecycle;
  let cleared: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fake = fakeAudio();
    bus = createLifecycle();
    session = createGameplaySession({
      audio: fake.audio,
      bus,
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
    mode: 'rhythm',
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

    describe('when piano samples failed', () => {
      // Tiles play 60 and 67/64; the accompaniment plays 48 (common) and 40 (difficulty).
      const tiles = [tap(500, 0), hold(1000, 1, 500)];
      const loadWith = async (failed: number[]) => {
        session.load(setup(tiles));
        fake.finishSamples(failed);
        await vi.advanceTimersByTimeAsync(0);
      };

      it.each([
        ['every key', Array.from({ length: 88 }, (_, i) => 21 + i)],
        ['a tile pitch', [64]],
        ['a common accompaniment pitch', [48]],
        ["the difficulty's accompaniment pitch", [40]],
      ])('does not offer Start when %s is missing', async (_name, failed) => {
        await loadWith(failed);
        expect(session.state).toBe('error');
        expect(session.error).toMatch(/piano/i);
        session.start();
        expect(session.state).toBe('error');
      });

      it('offers Start when only notes the song never plays are missing', async () => {
        await loadWith([21, 61, 108]);
        expect(session.state).toBe('ready');
        session.start();
        expect(session.state).toBe('leadIn');
      });
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

    it('starts the rewind from the song time on screen, not the clock ahead of it', async () => {
      fake.outputLagMs = 40;
      await loaded([tap(1000, 0), tap(3000, 1)]);
      session.start();
      while (session.state !== 'failing') frames(16);
      // The stage showed what was heard: 40 ms behind the clock.
      expect(session.view().songMs).toBeCloseTo(songMs() - 40);
      fake.advance(REWIND_DURATION_MS);
      expect(session.view().songMs).toBeCloseTo(1120 - REWIND_SONG_MS);
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
        mode: 'rhythm',
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

  describe("the song's recording", () => {
    const withAudio = (overrides: Partial<Chart> = {}) => ({
      ...chartWith([tap(1000, 0), tap(3000, 1)]),
      audio: { src: 'songs/test-song.m4a', offsetMs: 300 },
      ...overrides,
    });
    const loadedWithAudio = async (overrides: Partial<SessionSetup> = {}) => {
      await loaded([], { chart: withAudio(), ...overrides });
    };

    it('does not load or play one for a chart without audio', async () => {
      await loaded([tap(1000, 0)]);
      expect(fake.backing.load).toHaveBeenCalledWith(undefined);
      expect(session.loading.backing).toBe('none');
      session.start();
      // Called, as every run does; with nothing loaded the real player does nothing.
      expect(fake.backing.play).toHaveBeenCalledOnce();
      expect(fake.setTuning).toHaveBeenLastCalledWith(1);
    });

    it('loads the recording named by the chart while the piano loads', async () => {
      await loadedWithAudio();
      expect(fake.backing.load).toHaveBeenCalledWith({ src: 'songs/test-song.m4a', offsetMs: 300 });
      expect(session.loading.backing).toBe('loaded');
    });

    it('stays loading until the recording has loaded, however early the piano is in', async () => {
      fake.backingControl.hold = true;
      session.load(setup([], { chart: withAudio() }));
      fake.finishSamples();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.state).toBe('loading');
      expect(session.loading.backing).toBe('loading');
      session.start();
      expect(session.state).toBe('loading');
      fake.releaseBacking();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.state).toBe('ready');
    });

    it('stays loading until the chart is in before it names a recording', async () => {
      let deliver: (chart: Chart) => void = () => undefined;
      session.load({
        ...setup([]),
        chart: new Promise<Chart>((resolve) => {
          deliver = resolve;
        }),
      });
      fake.finishSamples();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.backing.load).not.toHaveBeenCalled();
      expect(session.state).toBe('loading');
      deliver(withAudio());
      await vi.advanceTimersByTimeAsync(0);
      expect(session.state).toBe('ready');
    });

    it('leaves the recording alone when an overtaken load resolves after the next one started', async () => {
      let deliverStale: (chart: Chart) => void = () => undefined;
      session.load({
        ...setup([]),
        chart: new Promise<Chart>((resolve) => {
          deliverStale = resolve;
        }),
      });
      await loadedWithAudio();
      session.start();
      expect(session.state).toBe('leadIn');
      fake.backing.load.mockClear();
      deliverStale(chartWith([tap(1000, 0)]));
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.backing.load).not.toHaveBeenCalled();
      expect(fake.backing.state).toBe('loaded');
      expect(session.state).toBe('leadIn');
    });

    it('plays the song without it when it failed to load', async () => {
      fake.backingControl.fail = true;
      await loadedWithAudio({ tempo: 1.25 });
      expect(session.loading.backing).toBe('failed');
      session.start();
      expect(session.state).toBe('leadIn');
      // Nothing to be in tune with: concert pitch at every speed.
      expect(fake.setTuning).toHaveBeenLastCalledWith(1);
    });

    it('starts it with the run, after the clock', async () => {
      await loadedWithAudio();
      const order: string[] = [];
      fake.backing.play.mockImplementation(() => {
        order.push(fake.engine.clock.isRunning ? 'play on a running clock' : 'play too early');
      });
      session.start();
      expect(order).toEqual(['play on a running clock']);
    });

    it.each([0.75, 1, 1.25, 1.5])(
      'tunes both pianos to the speed (%s×) when a recording plays',
      async (tempo) => {
        await loadedWithAudio({ tempo: tempo as 1 });
        session.start();
        expect(fake.setTuning).toHaveBeenLastCalledWith(tempo);
      },
    );

    it('is back to concert pitch once the run is over', async () => {
      await loadedWithAudio({ tempo: 1.5 });
      session.start();
      expect(fake.setTuning).toHaveBeenLastCalledWith(1.5);
      session.quit();
      expect(fake.setTuning).toHaveBeenLastCalledWith(1);
    });

    it('fades it with the music when the player pauses, and brings it back with the clock', async () => {
      await loadedWithAudio();
      session.start();
      frames(500);
      session.pause();
      expect(fake.backing.pause).toHaveBeenCalledWith(PAUSE_FADE_MS);
      // The engine resumes it (as it does the accompaniment) when the clock restarts:
      // the session does not play it again itself, so the countdown stays silent.
      session.resume();
      await vi.advanceTimersByTimeAsync(3 * COUNTDOWN_BEAT_MS);
      expect(fake.engine.resumeClock).toHaveBeenCalledOnce();
      expect(fake.backing.play).toHaveBeenCalledOnce();
    });

    it('is paused when the audio is interrupted', async () => {
      await loadedWithAudio();
      session.start();
      frames(500);
      fake.engine.phase = 'interrupted';
      fake.engine.events.emit('interrupted', { reason: 'background' });
      expect(session.state).toBe('paused');
      expect(fake.backing.pause).toHaveBeenCalledWith(PAUSE_FADE_MS);
    });

    it('stops with the music on a Classic failure', async () => {
      await loadedWithAudio();
      session.start();
      frames(2600);
      press('a', 0); // an empty lane
      expect(session.state).toBe('failing');
      expect(fake.backing.stopAll).toHaveBeenLastCalledWith(FAIL_FADE_MS);
    });

    it('fades out at the end of the song', async () => {
      await loadedWithAudio({ chart: withAudio(), failMode: 'relaxed' });
      session.start();
      frames(5600);
      expect(session.state).toBe('finished');
      expect(fake.backing.stopAll).toHaveBeenLastCalledWith(END_FADE_MS);
    });

    it('stops on quit and on restart, and plays again from the start on restart', async () => {
      await loadedWithAudio();
      session.start();
      frames(500);
      session.quit();
      expect(fake.backing.stopAll).toHaveBeenLastCalledWith(QUIT_FADE_MS);
      fake.backing.stopAll.mockClear();
      fake.backing.play.mockClear();

      session.start();
      frames(500);
      session.restart();
      expect(fake.backing.stopAll).toHaveBeenCalledWith(QUIT_FADE_MS);
      expect(session.state).toBe('leadIn');
      expect(fake.backing.play).toHaveBeenCalledTimes(2);
    });

    it('stops when something else silences the engine', async () => {
      await loadedWithAudio();
      session.start();
      fake.engine.events.emit('silenced', { fadeMs: 50 });
      expect(fake.backing.stopAll).toHaveBeenCalledWith(QUIT_FADE_MS);
      expect(session.state).toBe('quit');
    });

    it('stops it when another song is loaded over a run', async () => {
      await loadedWithAudio();
      session.start();
      session.load(setup([tap(1000, 0)]));
      expect(fake.backing.stopAll).toHaveBeenCalled();
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

    // The player's piano is not the accompaniment's: pausing the song alone left a
    // held note ringing into the pause screen.
    it.each([
      [
        'the Pause button',
        () => {
          session.pause();
        },
      ],
      [
        'a lost focus',
        () => {
          session.input.blur();
        },
      ],
      [
        'a cancelled touch',
        () => {
          session.input.cancel();
        },
      ],
      [
        'the page going to the background',
        () => {
          bus.emit('pause', { reason: 'hidden' });
        },
      ],
      [
        'an audio interruption',
        () => {
          fake.engine.phase = 'interrupted';
          fake.engine.timeline.pause();
          fake.engine.events.emit('interrupted', { reason: 'background' });
        },
      ],
    ])("fades the player's notes with the song on %s", async (_, pause) => {
      await loaded([hold(1000, 1, 2000), tap(4000, 0)]);
      session.start();
      frames(2000);
      press('a', 1);
      expect(fake.voices).toEqual([{ pitch: 67 }, { pitch: 64 }]);
      fake.piano.stopAll.mockClear();
      pause();
      expect(session.state).toBe('paused');
      expect(fake.accompaniment.pause).toHaveBeenCalledWith(PAUSE_FADE_MS);
      expect(fake.piano.stopAll).toHaveBeenCalledWith(PAUSE_FADE_MS);
    });

    it('recovers interrupted audio while the clock stays paused, then counts down', async () => {
      await loaded([tap(1000, 0), tap(3000, 1)]);
      session.start();
      frames(1500);
      fake.engine.phase = 'interrupted';
      fake.engine.timeline.pause();
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

    describe.each([0.75, 1, 1.5] as const)(
      'with a calibrated input offset at tempo %s',
      (tempo) => {
        /** Renders frames until the song clock reads `target`, landing on it exactly. */
        const toSong = (target: number) => {
          while (songMs() + 16 * tempo < target) frames(16);
          fake.advance((target - songMs()) / tempo);
          session.update();
        };
        /** Song ms of the clock when a tap received now is judged at `judgeMs`. */
        const rawFor = (judgeMs: number, offsetMs: number) => judgeMs + offsetMs * tempo;
        const resumeAll = async () => {
          session.resume();
          await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS * 3);
          expect(session.state).toBe('playing');
        };

        it.each([200, -200])(
          'keeps a head still hittable in input time open across a pause (offset %s)',
          async (offsetMs) => {
            fake.inputOffsetMs = offsetMs;
            await loaded([tap(1000, 0), tap(3000, 1)], { tempo });
            session.start();
            toSong(rawFor(1000, offsetMs));
            session.pause();
            expect(session.state).toBe('paused');
            expect(session.stats()).toMatchObject({ miss: 0 });
            await resumeAll();
            press('a', 0);
            expect(session.stats()).toMatchObject({ perfect: 1, miss: 0 });
          },
        );

        it.each([200, -200])(
          'keeps it open when the audio stopped the clock first (offset %s)',
          async (offsetMs) => {
            fake.inputOffsetMs = offsetMs;
            await loaded([tap(1000, 0), tap(3000, 1)], { tempo });
            session.start();
            toSong(rawFor(1000, offsetMs));
            fake.engine.phase = 'interrupted';
            fake.engine.timeline.pause();
            fake.engine.events.emit('interrupted', { reason: 'background' });
            expect(session.state).toBe('paused');
            expect(session.stats()).toMatchObject({ miss: 0 });
          },
        );

        it.each([200, -200])(
          'settles a Miss already due in input time when pausing (offset %s)',
          async (offsetMs) => {
            fake.inputOffsetMs = offsetMs;
            await loaded([tap(1000, 0), tap(3000, 1)], { tempo });
            session.start();
            // Just past the tap's late boundary (1000 + 120 real ms) in input time.
            toSong(rawFor(1000 + 130 * tempo, offsetMs));
            expect(session.state).toBe('playing');
            session.pause();
            expect(session.state).toBe('failing');
            expect(session.stats()).toMatchObject({ miss: 1 });
          },
        );

        it.each([200, -200])(
          'completes a hold held past its tail in input time when pausing (offset %s)',
          async (offsetMs) => {
            fake.inputOffsetMs = offsetMs;
            await loaded([hold(1000, 0, 1000)], { tempo });
            session.start();
            toSong(rawFor(1000, offsetMs));
            press('a', 0);
            toSong(rawFor(2000 + 20 * tempo, offsetMs));
            expect(session.stats()).toMatchObject({ perfect: 1 });
            session.pause();
            expect(session.stats()).toMatchObject({ perfect: 2, miss: 0 });
            expect(session.pauseInfo?.heldLanes).toEqual([]);
            await resumeAll();
            expect(session.stats()).toMatchObject({ perfect: 2, miss: 0 });
          },
        );

        describe.each([200, -200, 0])(
          'when the audio stops the clock, heard 40 ms late (offset %s)',
          (offsetMs) => {
            const lagMs = 40;
            /** Song ms of the clock when a tap received now is judged at `judgeMs`. */
            const clockFor = (judgeMs: number) => judgeMs + (offsetMs + lagMs) * tempo;
            /** What the engine does on an interruption: it stops the clock, then says so. */
            const interrupt = () => {
              fake.engine.phase = 'interrupted';
              fake.engine.timeline.pause();
              fake.engine.events.emit('interrupted', { reason: 'background' });
            };
            const recoverAll = async () => {
              session.resume();
              fake.engine.phase = 'running';
              fake.engine.events.emit('recovered', { recreated: false });
              await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS * 3);
              expect(session.state).toBe('playing');
            };
            beforeEach(() => {
              fake.inputOffsetMs = offsetMs;
              fake.outputLagMs = lagMs;
            });

            it('keeps a head still inside its window open, then judges it normally', async () => {
              await loaded([tap(1000, 0), tap(3000, 1)], { tempo });
              session.start();
              // 100 real ms late in input time: inside the window, under the lag past it.
              toSong(clockFor(1000 + 100 * tempo));
              interrupt();
              expect(session.state).toBe('paused');
              expect(session.stats()).toMatchObject({ miss: 0 });
              await recoverAll();
              press('a', 0);
              expect(session.stats()).toMatchObject({ good: 1, miss: 0 });
            });

            it('settles a Miss already due in input time', async () => {
              await loaded([tap(1000, 0), tap(3000, 1)], { tempo });
              session.start();
              toSong(clockFor(1000 + 130 * tempo));
              expect(session.state).toBe('playing');
              interrupt();
              expect(session.state).toBe('failing');
              expect(session.stats()).toMatchObject({ miss: 1 });
            });

            it('completes a hold held past its tail in input time', async () => {
              await loaded([hold(1000, 0, 1000)], { tempo });
              session.start();
              toSong(clockFor(1000));
              press('a', 0);
              toSong(clockFor(2000 + 20 * tempo));
              expect(session.stats()).toMatchObject({ perfect: 1 });
              interrupt();
              expect(session.stats()).toMatchObject({ perfect: 2, miss: 0 });
              expect(session.pauseInfo?.heldLanes).toEqual([]);
              await recoverAll();
              expect(session.stats()).toMatchObject({ perfect: 2, miss: 0 });
            });
          },
        );
      },
    );

    it.each(['press', 'pause', 'interrupt'] as const)(
      'keeps the late boundary of input time through a %s, 40 ms output lag and +200 ms input',
      async (action) => {
        fake.inputOffsetMs = 200;
        fake.outputLagMs = 40;
        await loaded([tap(1000, 0), tap(3000, 1)]);
        session.start();
        while (songMs() + 16 < 1340) frames(16);
        fake.advance(1340 - songMs());
        session.update();
        // The clock reads 1340; a tap received now is judged at 1100, inside the late
        // boundary (1120) of the tile at 1000.
        expect(fake.engine.timeline.judgeSongTime(fake.perf)).toBeCloseTo(1100, 6);
        if (action === 'press') {
          press('a', 0);
          expect(session.stats()).toMatchObject({ good: 1, miss: 0 });
          expect(session.state).toBe('playing');
          return;
        }
        if (action === 'pause') {
          session.pause();
        } else {
          fake.engine.phase = 'interrupted';
          fake.engine.timeline.pause();
          fake.engine.events.emit('interrupted', { reason: 'background' });
        }
        expect(session.state).toBe('paused');
        expect(session.stats()).toMatchObject({ miss: 0 });
      },
    );

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

  describe('Tiles', () => {
    const SCROLL_MS = 1600;
    const loadTiles = (tiles: Tile[], overrides: Partial<SessionSetup> = {}) =>
      loaded(tiles, { mode: 'tiles', scrollDurationMs: SCROLL_MS, ...overrides });
    /** The song ms the stage shows now (it trails the clock by `outputLagMs`). */
    const shownMs = () => fake.engine.timeline.shownSongTime(fake.perf);
    /** A finger on the tile at chart ms `t`, where the stage shows it now (1×). */
    const on = (t: number): LaneSpot => ({
      lane: 0,
      along: (shownMs() - t) / SCROLL_MS,
      reach: 0.02,
    });
    /**
     * Frames of `step` ms until the stage shows song ms `target` (1×), the last one
     * landing on it, each followed by `draw`.
     */
    const playTo = (target: number, step = 16, draw?: (ms: number) => void) => {
      while (shownMs() + step < target) {
        fake.advance(step);
        session.update();
        draw?.(step);
      }
      const rest = target - shownMs();
      if (rest > 0) {
        fake.advance(rest);
        session.update();
        draw?.(rest);
      }
    };
    const stages: GameStage[] = [];
    afterEach(() => {
      for (const stage of stages.splice(0)) stage.dispose();
    });
    /** A real stage on this session, wired as `main.ts` wires it. */
    const withStage = (width: number, height: number) => {
      const stage = createGameStage({
        surface: document.createElement('div'),
        reducedMotion: () => false,
      });
      stages.push(stage);
      stage.resize(width, height);
      session.setExitAlong(stage.exitAlong());
      session.events.on('judgment', (event) => {
        stage.onJudgment(event);
      });
      let drawn: Object3D | undefined;
      const renderer = {
        render: (scene: Object3D) => {
          drawn = scene;
        },
      } as unknown as WebGLRenderer;
      return {
        exitAlong: stage.exitAlong(),
        draw: (ms: number) => {
          stage.render(session.view(), ms / 1000, renderer);
        },
        /** Instances drawn last frame as `name`. */
        count: (name: string) => (drawn?.getObjectByName(name) as InstancedMesh | undefined)?.count,
      };
    };
    const LAYOUTS = [
      ['handheld', 390, 844],
      ['tabletop', 1024, 768],
    ] as const;
    const touch = (input: string, lane: number, spot: LaneSpot) => {
      session.input.press(input, lane, fake.perf, { ...spot, lane });
    };
    const noteOns = () => fake.piano.noteOn.mock.calls as unknown[][];

    // A handheld tile: its head and slack reach 64 ms either side of its centre.
    describe.each([-100, 0, 100])('with an input offset of %s ms', (offsetMs) => {
      it.each([
        ['its centre', 0],
        ['its near edge', -60],
        ['its far edge', 60],
      ])('clears the tile drawn under the finger, pressed on %s', async (_, edgeMs) => {
        await loadTiles([tap(500, 0), tap(900, 1)]);
        fake.inputOffsetMs = offsetMs;
        const judged: number[] = [];
        session.events.on('judgment', (event) => judged.push(event.songMs));
        session.start();
        frames(1200); // song 200 on screen: the tile is 300 ms up the lane
        touch('a', 0, { ...on(500 + edgeMs), reach: 64 / SCROLL_MS });
        expect(session.stats()).toMatchObject({ clear: 1, miss: 0 });
        expect(session.state).toBe('playing');
        // Read from the board, and counted when it was shown: no calibration.
        expect(judged).toHaveLength(1);
        expect(judged[0]).toBeCloseTo(200, 6);
      });
    });

    it('plays a tile claimed early on its beat, on the song clock', async () => {
      await loadTiles([tap(500, 0), tap(900, 1)]);
      session.start();
      frames(800); // song -200
      touch('a', 0, on(500));
      expect(session.stats()).toMatchObject({ clear: 1, perfect: 0, combo: 1, score: 100 });
      const beat = fake.engine.timeline.startTimeFor(500);
      expect(beat).toBeGreaterThan(fake.engine.context.currentTime + 0.6);
      expect(noteOns()).toEqual([[60, 100, beat]]);
      expect(fake.piano.noteOff).toHaveBeenCalledWith(expect.anything(), beat + TAP_NOTE_S);
    });

    it('plays a tile claimed late at once', async () => {
      await loadTiles([tap(500, 0)]);
      session.start();
      frames(1600); // song 600: past its beat, still on screen
      touch('a', 0, on(500));
      expect(noteOns()).toEqual([[60, 100]]);
    });

    it('never plays a tile nobody claimed, and fails Classic at the exit line', async () => {
      await loadTiles([tap(500, 0), tap(2500, 1)]);
      session.setExitAlong(0.25); // lost 400 ms past the line
      session.start();
      frames(1880); // song 880
      expect(session.state).toBe('playing');
      frames(400 + FINALIZE_GRACE_MS + 32);
      expect(session.state).toBe('failing');
      expect(fake.piano.noteOn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      expect(session.results).toMatchObject({
        mode: 'tiles',
        outcome: 'failed',
        failure: { kind: 'missedTile', lane: 0, tileIndex: 0 },
        clear: 0,
        miss: 1,
      });
    });

    it('cancels waiting notes on pause and schedules them again on resume', async () => {
      await loadTiles([tap(500, 0), tap(900, 1)]);
      session.start();
      frames(800);
      touch('a', 0, on(500));
      expect(noteOns()).toHaveLength(1);
      session.pause();
      expect(fake.piano.stopAll).toHaveBeenLastCalledWith(PAUSE_FADE_MS);
      frames(2000);
      session.resume();
      await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS * 3);
      expect(session.state).toBe('leadIn');
      // The clock moved on in context time: the beat is due later than first planned.
      expect(noteOns()).toEqual([
        [60, 100, expect.any(Number)],
        [60, 100, fake.engine.timeline.startTimeFor(500)],
      ]);
      // Once it has sounded, a pause has nothing left to bring back.
      frames(800);
      session.pause();
      session.resume();
      await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS * 3);
      expect(noteOns()).toHaveLength(2);
    });

    it('brings back a long tile’s waiting note only if it is held again', async () => {
      for (const reclaim of [true, false]) {
        fake.piano.noteOn.mockClear();
        await loadTiles([hold(500, 2, 400)], { failMode: 'relaxed' });
        session.start();
        frames(800);
        touch('a', 2, on(500));
        session.pause();
        session.resume();
        if (reclaim) press('b', 2);
        await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS * 3);
        expect(noteOns().map((call) => call.length)).toEqual(reclaim ? [3, 3, 3, 3] : [3, 3]);
        session.quit();
      }
    });

    it('quit and restart cancel waiting notes for good', async () => {
      await loadTiles([tap(500, 0), tap(900, 1)]);
      session.start();
      frames(800);
      touch('a', 0, on(500));
      session.restart();
      expect(fake.piano.stopAll).toHaveBeenCalledWith(QUIT_FADE_MS);
      frames(800);
      session.pause();
      session.resume();
      await vi.advanceTimersByTimeAsync(COUNTDOWN_BEAT_MS * 3);
      expect(noteOns()).toHaveLength(1);
      session.quit();
      expect(fake.piano.stopAll).toHaveBeenLastCalledWith(QUIT_FADE_MS);
    });

    it('shakes a later tile instead of claiming it, and fails Classic on the water', async () => {
      await loadTiles([tap(500, 0), tap(900, 1)]);
      const notYet: unknown[] = [];
      session.events.on('notyet', (event) => notYet.push(event));
      session.start();
      frames(800);
      touch('a', 1, on(900));
      expect(notYet).toEqual([{ lane: 1, tileIndex: 1 }]);
      expect(session.stats()).toMatchObject({ clear: 0, miss: 0 });
      frames(400); // song 200
      touch('b', 3, on(700));
      expect(session.state).toBe('failing');
      expect(session.stats()).toMatchObject({ miss: 1 });
    });

    it('claims with keys, and reports Tiles results: cleared ÷ resolved, badge for no Miss', async () => {
      await loadTiles([tap(500, 0), hold(1500, 1, 500)]);
      session.start();
      frames(1200); // song 200
      press('kD', 0);
      press('kF', 1);
      frames(4200);
      expect(session.state).toBe('finished');
      expect(session.results).toMatchObject({
        mode: 'tiles',
        outcome: 'cleared',
        clear: 3,
        perfect: 0,
        good: 0,
        miss: 0,
        accuracy: 100,
        perfectBadge: true,
        score: 300,
      });
    });

    // Tiles has no timing to judge, so the input calibration never decides whether a
    // tile can still be claimed: everything goes by the board as it was shown.
    describe.each(LAYOUTS)('on the %s stage', (_, width, height) => {
      describe.each([-100, 0, 100])('with an input offset of %s ms', (offsetMs) => {
        let stage: ReturnType<typeof withStage>;
        let tails: number[];
        /** Starts a Classic run; the stage shows the song 40 ms behind the clock. */
        const start = async (tiles: Tile[]) => {
          await loadTiles(tiles);
          stage = withStage(width, height);
          tails = [];
          session.events.on('judgment', (event) => {
            if (event.unit === 'tail') tails.push(event.songMs);
          });
          fake.inputOffsetMs = offsetMs;
          fake.outputLagMs = 40;
          session.start();
        };
        const failure = () => session.view().simulation?.failure;

        it('clears the next tile tapped just before it crosses the exit line', async () => {
          await start([tap(500, 0), tap(3000, 1)]);
          playTo(500 + stage.exitAlong * SCROLL_MS - 8);
          touch('a', 0, on(500));
          expect(session.stats()).toMatchObject({ clear: 1, miss: 0 });
          expect(session.state).toBe('playing');
        });

        it('loses it once it has crossed, and Classic fails on that tile', async () => {
          await start([tap(500, 0), tap(3000, 1)]);
          playTo(500 + stage.exitAlong * SCROLL_MS + 8);
          // The Miss still waits for the finalization grace; the tap brings it in.
          expect(session.state).toBe('playing');
          touch('a', 0, on(500));
          expect(session.state).toBe('failing');
          expect(failure()).toEqual({ kind: 'missedTile', lane: 0, tileIndex: 0 });
          expect(session.stats()).toMatchObject({ clear: 0, miss: 1 });
        });

        it('fails a long tile let go just before it shows full', async () => {
          await start([hold(500, 2, 400), tap(3000, 1)]);
          playTo(-200);
          touch('a', 2, on(500));
          playTo(900 - 8);
          release('a');
          expect(session.state).toBe('failing');
          expect(failure()).toEqual({ kind: 'missedTile', lane: 2, tileIndex: 0 });
        });

        it('clears a long tile let go just after it shows full', async () => {
          await start([hold(500, 2, 400), tap(3000, 1)]);
          playTo(-200);
          touch('a', 2, on(500));
          playTo(900 + 8);
          release('a');
          expect(session.state).toBe('playing');
          expect(session.stats()).toMatchObject({ clear: 2, miss: 0 });
        });

        // What can be pressed and what is drawn agree: a cleared tile is a harmless
        // target exactly while its pop shows, whenever its judgment is delivered.
        describe.each([8, 16, 33])('at %s ms a frame', (step) => {
          it('pops a tap from its claim; a touch there is harmless only while it shows', async () => {
            await start([tap(500, 0), tap(3000, 1)]);
            playTo(200, step, stage.draw);
            touch('a', 0, on(500));
            stage.draw(0);
            expect(stage.count('flashes')).toBe(1);
            playTo(200 + POP_MS - 10, step, stage.draw);
            expect(stage.count('flashes')).toBe(1);
            touch('b', 0, on(500));
            expect(session.stats()).toMatchObject({ clear: 1, miss: 0 });
            playTo(200 + POP_MS + 10, step, stage.draw);
            expect(stage.count('flashes')).toBe(0);
            touch('c', 0, on(500));
            expect(session.state).toBe('failing');
            expect(failure()).toEqual({ kind: 'emptyTap', lane: 0 });
          });

          it('pops a long tile once it shows full, before its judgment arrives; a touch on it then is harmless', async () => {
            await start([hold(500, 2, 400), tap(3000, 1)]);
            playTo(-200, step, stage.draw);
            touch('a', 2, on(500));
            playTo(880, step, stage.draw);
            expect(stage.count('hold-bodies')).toBe(2);
            playTo(900 + POP_MS - 10, step, stage.draw);
            expect(stage.count('hold-bodies')).toBe(0);
            expect(stage.count('flashes')).toBe(1);
            expect(tails).toEqual([]);
            touch('b', 2, on(700));
            expect(session.state).toBe('playing');
            expect(session.stats()).toMatchObject({ clear: 2, miss: 0 });
            // Its judgment came in with that touch; it pops no second time.
            expect(tails).toEqual([900]);
            stage.draw(0);
            expect(stage.count('flashes')).toBe(1);
          });

          it.each([
            ['once its pop is over', POP_MS + 10],
            ['after its judgment arrived', FINALIZE_GRACE_MS + 34],
          ])('lets a full long tile go %s: a touch there is an empty tap', async (_, afterMs) => {
            await start([hold(500, 2, 400), tap(3000, 1)]);
            playTo(-200, step, stage.draw);
            touch('a', 2, on(500));
            playTo(900 + afterMs, step, stage.draw);
            expect(stage.count('hold-bodies')).toBe(0);
            expect(stage.count('flashes')).toBe(0);
            touch('b', 2, on(700));
            expect(session.state).toBe('failing');
            expect(failure()).toEqual({ kind: 'emptyTap', lane: 2 });
            expect(session.stats()).toMatchObject({ clear: 2, miss: 1 });
          });
        });
      });
    });
  });
});
