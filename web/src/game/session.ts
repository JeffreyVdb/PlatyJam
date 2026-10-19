import { createEventBus } from '../app/events';
import type { Lifecycle } from '../app/lifecycle';
import type { AudioEngine } from '../audio/engine';
import type { LoadProgress } from '../audio/piano-samples';
import type { PianoVoice, Sampler } from '../audio/sampler';
import { type Accompaniment, PAUSE_FADE_MS } from '../audio/scheduler';
import type { Chart } from '../chart/schema';
import type { LaneInputSink } from './input';
import { accuracyOf, earnsPerfectBadge, starsFor } from './scoring';
import type {
  AudioRecovery,
  CountdownInfo,
  FinalResults,
  GameSession,
  JudgmentEvent,
  LiveStats,
  LoadingInfo,
  PauseInfo,
  PauseReason,
  SessionConfig,
  SessionEvents,
  SessionState,
} from './session-contract';
import { createSimulation, finalizationHorizon, type Simulation } from './simulation';

// Tunable presentation and audio timings.

/** One countdown beat, real ms. */
export const COUNTDOWN_BEAT_MS = 1000;
export const COUNTDOWN_BEATS = 3;
/** A hit tap plays this long (real seconds) before its key is released. */
export const TAP_NOTE_S = 0.45;
/** How long Start waits for the audio to run before giving up. */
export const START_TIMEOUT_MS = 3000;
/** Fade when a Classic failure silences the song. */
export const FAIL_FADE_MS = 120;
/** Fade on quit and restart. */
export const QUIT_FADE_MS = 150;
/** Fade for anything still ringing when a song completes. */
export const END_FADE_MS = 800;
/** The visual rewind after a failure: how far back (real ms of song) and how long it takes. */
export const REWIND_SONG_MS = 450;
export const REWIND_DURATION_MS = 650;
/** From the failure to handing over the results. */
export const FAIL_RESULTS_DELAY_MS = 1600;

/** The parts of `GameAudio` a session uses. */
export interface SessionAudio {
  engine: Pick<
    AudioEngine,
    'phase' | 'events' | 'clock' | 'timeline' | 'context' | 'resumeFromGesture' | 'resumeClock'
  >;
  piano: Pick<Sampler, 'noteOn' | 'noteOff' | 'stopAll'>;
  accompaniment: Pick<Accompaniment, 'play' | 'pause' | 'stopAll'>;
  samples: { readonly progress: LoadProgress; readonly ready: Promise<unknown> };
}

export interface GameplaySessionOptions {
  audio: SessionAudio;
  bus: Lifecycle;
  /** `performance.now()`. */
  now?: () => number;
}

/** What the stage draws this frame. */
export interface StageView {
  readonly config: SessionConfig | undefined;
  readonly simulation: Simulation | undefined;
  /** The song ms to draw at (the visual rewind included). */
  readonly songMs: number;
  readonly state: SessionState;
}

/**
 * The session plus what the rest of PLA-6 (input, stage) needs. PLA-7 only uses
 * the `GameSession` part.
 */
export interface GameplaySession extends GameSession {
  /** Feed lane input here (`installLaneInput`'s sink). Timestamps are performance ms. */
  readonly input: LaneInputSink;
  /** Whether lane presses are gameplay right now (lead-in, play, countdown). */
  acceptsInput(): boolean;
  /** The input layer, so pausing can forget held fingers and keys. */
  attachInput(input: { clear(): void }): void;
  /** Call every render frame: finalizes misses and completions, runs transitions. */
  update(): void;
  /** Call after `update()` to get what to draw. */
  view(): StageView;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
/** Ease-out cubic. */
const easeOut = (t: number) => 1 - (1 - clamp01(t)) ** 3;

export function createGameplaySession({
  audio,
  bus,
  now = () => performance.now(),
}: GameplaySessionOptions): GameplaySession {
  const { engine, piano, accompaniment, samples } = audio;
  const events = createEventBus<SessionEvents>();

  let state: SessionState = 'loading';
  let config: SessionConfig | undefined;
  let chartLoaded = false;
  let error: string | undefined;
  let sim: Simulation | undefined;
  let pauseInfo: PauseInfo | undefined;
  let countdown: CountdownInfo | undefined;
  let results: FinalResults | undefined;
  let input: { clear(): void } | undefined;
  // Bumped to abandon a load, a start or a countdown that was overtaken.
  let loadToken = 0;
  let startToken = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Voices of the hold being held, per tile index. */
  const holdVoices = new Map<number, PianoVoice[]>();
  /** The furthest progress this run has reached; a failure never takes it back. */
  let furthest = 0;
  /** When the run failed (performance ms) and where the clock stopped, for the rewind. */
  let failedAt = 0;
  let failedSongMs = 0;

  const live: LiveStats = {
    score: 0,
    combo: 0,
    maxCombo: 0,
    perfect: 0,
    good: 0,
    miss: 0,
    accuracy: 0,
    progress: 0,
    stars: 0,
  };

  const setState = (next: SessionState) => {
    if (next === state) return;
    const previous = state;
    state = next;
    events.emit('statechange', { state: next, previous });
  };

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const tiles = () => (config ? config.chart.difficulties[config.difficulty].tiles : []);

  const onJudgment = (event: Readonly<JudgmentEvent>) => {
    const tile = tiles()[event.tileIndex];
    if (tile && event.judgment !== 'miss' && (event.unit === 'tap' || event.unit === 'head')) {
      const voices: PianoVoice[] = [];
      for (const pitch of tile.pitches) {
        const voice = piano.noteOn(pitch, tile.vel);
        if (voice) voices.push(voice);
      }
      if (event.unit === 'tap') {
        const off = engine.context.currentTime + TAP_NOTE_S;
        for (const voice of voices) piano.noteOff(voice, off);
      } else {
        holdVoices.set(event.tileIndex, voices);
      }
    }
    if (event.unit === 'tail') {
      for (const voice of holdVoices.get(event.tileIndex) ?? []) piano.noteOff(voice);
      holdVoices.delete(event.tileIndex);
    }
    events.emit('judgment', { ...event });
  };

  const newSimulation = () => {
    holdVoices.clear();
    furthest = 0;
    if (!config) return undefined;
    return createSimulation({
      tiles: tiles(),
      tempo: config.tempo,
      failMode: config.failMode,
      durationMs: config.chart.durationMs,
      onJudgment,
    });
  };

  const progressAt = (songMs: number) =>
    config && config.chart.durationMs > 0 ? clamp01(songMs / config.chart.durationMs) : 0;
  /** Progress at `songMs`, or further if the run already got further. */
  const reach = (songMs: number) => (furthest = Math.max(furthest, progressAt(songMs)));

  const buildResults = (current: Simulation, cfg: SessionConfig): FinalResults => {
    const cleared = current.status === 'complete';
    // A failed run keeps the furthest progress it reached, and the stars that earned.
    const progress = cleared ? 1 : reach(current.endMs ?? 0);
    const outcome = cleared ? 'cleared' : 'failed';
    return {
      ...current.score,
      accuracy: accuracyOf(current.score),
      outcome,
      ...(current.failure ? { failure: { ...current.failure } } : {}),
      songId: cfg.chart.id,
      songTitle: cfg.chart.title,
      difficulty: cfg.difficulty,
      tempo: cfg.tempo,
      failMode: cfg.failMode,
      progress,
      stars: starsFor(progress, cleared),
      perfectBadge: earnsPerfectBadge(outcome, current.score),
    };
  };

  const silence = (fadeMs: number) => {
    accompaniment.stopAll(fadeMs);
    piano.stopAll(fadeMs);
    holdVoices.clear();
  };

  /** Runs state transitions the simulation calls for. */
  const afterSimulation = () => {
    if (!sim || !config || (state !== 'leadIn' && state !== 'playing' && state !== 'countdown')) {
      return;
    }
    if (sim.status === 'failed') {
      clearTimer();
      engine.clock.pause();
      silence(FAIL_FADE_MS);
      input?.clear();
      countdown = undefined;
      failedAt = now();
      failedSongMs = engine.clock.position();
      const final = buildResults(sim, config);
      setState('failing');
      timer = setTimeout(() => {
        timer = undefined;
        results = final;
        setState('finished');
      }, FAIL_RESULTS_DELAY_MS);
    } else if (sim.status === 'complete') {
      engine.clock.pause();
      silence(END_FADE_MS);
      input?.clear();
      results = buildResults(sim, config);
      setState('finished');
    }
  };

  const judgeTime = (timeStamp: number) => engine.timeline.judgeSongTime(timeStamp);

  // ---- start ----

  const beginRun = () => {
    if (!config) return;
    clearTimer();
    sim = newSimulation();
    results = undefined;
    pauseInfo = undefined;
    countdown = undefined;
    const { chart, difficulty, tempo } = config;
    // Quiet anything left over (another run's tail, the debug sync test).
    silence(0);
    engine.clock.setTempo(tempo);
    engine.clock.start(-chart.leadInMs);
    accompaniment.play([
      ...chart.accompaniment,
      ...(chart.difficulties[difficulty].accompaniment ?? []),
    ]);
    setState('leadIn');
  };

  /** Waits for audio to run (unlock, recovery), then begins; falls back on timeout. */
  const startWhenAudioRuns = (fallback: SessionState) => {
    const token = (startToken += 1);
    setState('starting');
    if (engine.phase === 'running') {
      beginRun();
      return;
    }
    // A locked context is being unlocked by this very gesture (the engine's
    // capture-phase listener); an interrupted one needs recovering inside it.
    if (engine.phase === 'interrupted') engine.resumeFromGesture({ resumeClock: false });
    const offs = [
      engine.events.on('unlocked', () => {
        finish(true);
      }),
      engine.events.on('recovered', () => {
        finish(true);
      }),
    ];
    timer = setTimeout(() => {
      timer = undefined;
      finish(engine.phase === 'running');
    }, START_TIMEOUT_MS);
    function finish(ok: boolean) {
      for (const off of offs) off();
      if (token !== startToken || state !== 'starting') return;
      clearTimer();
      if (ok) beginRun();
      else setState(fallback);
    }
  };

  // ---- pause, countdown, resume ----

  const audioState = (): AudioRecovery =>
    engine.phase === 'interrupted' ? 'interrupted' : 'running';

  const enterPause = (reason: PauseReason) => {
    if (!sim) return;
    clearTimer();
    engine.clock.pause();
    if (isPlaying()) {
      // Every input made before the pause has been dispatched by now, so what is due
      // by the pause is decided: holds still down at their tail complete, and Misses
      // whose window closed count, before anything is suspended.
      sim.advance(engine.clock.position());
      afterSimulation();
      if (sim.status !== 'running') return;
    }
    accompaniment.pause(PAUSE_FADE_MS);
    holdVoices.clear();
    sim.pause();
    input?.clear();
    countdown = undefined;
    pauseInfo = { reason, audio: audioState(), heldLanes: sim.suspendedLanes() };
    setState('paused');
    events.emit('pause', pauseInfo);
  };

  const updatePause = (audioStatus: AudioRecovery) => {
    if (!pauseInfo) return;
    pauseInfo = { ...pauseInfo, audio: audioStatus };
    events.emit('pause', pauseInfo);
  };

  const emitCountdown = () => {
    if (!countdown || !sim) return;
    countdown = {
      ...countdown,
      heldLanes: sim.suspendedLanes(),
      reclaimedLanes: sim.reclaimedLanes(),
    };
    events.emit('countdown', countdown);
  };

  const beginCountdown = () => {
    if (!sim || state !== 'paused') return;
    clearTimer();
    pauseInfo = undefined;
    countdown = { beat: COUNTDOWN_BEATS, heldLanes: sim.suspendedLanes(), reclaimedLanes: [] };
    setState('countdown');
    events.emit('countdown', countdown);
    const tick = () => {
      timer = undefined;
      if (!countdown || state !== 'countdown') return;
      if (countdown.beat > 1) {
        countdown = { ...countdown, beat: countdown.beat - 1 };
        emitCountdown();
        timer = setTimeout(tick, COUNTDOWN_BEAT_MS);
        return;
      }
      finishCountdown();
    };
    timer = setTimeout(tick, COUNTDOWN_BEAT_MS);
  };

  const finishCountdown = () => {
    if (!sim) return;
    sim.resume(engine.clock.position());
    afterSimulation();
    if (state !== 'countdown') return;
    countdown = undefined;
    engine.resumeClock();
    setState(engine.clock.position() < 0 ? 'leadIn' : 'playing');
  };

  // ---- quitting ----

  const endRun = () => {
    startToken += 1;
    clearTimer();
    engine.clock.pause();
    silence(QUIT_FADE_MS);
    input?.clear();
    pauseInfo = undefined;
    countdown = undefined;
    results = undefined;
  };

  // ---- engine and lifecycle ----

  engine.events.on('interrupted', () => {
    if (state === 'leadIn' || state === 'playing' || state === 'countdown') {
      enterPause('interrupted');
    } else if (state === 'paused') {
      updatePause('interrupted');
    }
  });
  engine.events.on('needsgesture', () => {
    if (state === 'paused') updatePause('needsGesture');
  });
  engine.events.on('recovered', () => {
    if (state === 'paused' && pauseInfo?.audio !== 'running') {
      updatePause('running');
      beginCountdown();
    }
  });
  // Something else needed quiet (the calibration): the run cannot go on under it.
  engine.events.on('silenced', () => {
    if (state !== 'loading' && state !== 'ready' && state !== 'error' && state !== 'quit') {
      endRun();
      setState('quit');
    }
  });
  bus.on('pause', () => {
    if (state === 'leadIn' || state === 'playing' || state === 'countdown') {
      enterPause('interrupted');
    }
  });

  const isPlaying = () => state === 'leadIn' || state === 'playing';

  const sink: LaneInputSink = {
    press(id, lane, timeStamp) {
      if (!sim) return;
      if (state === 'countdown') {
        if (sim.reclaim(id, lane)) emitCountdown();
        return;
      }
      if (!isPlaying()) return;
      sim.press(id, lane, judgeTime(timeStamp));
      afterSimulation();
    },
    release(id, timeStamp) {
      if (!sim) return;
      if (state === 'countdown') {
        sim.unclaim(id);
        emitCountdown();
        return;
      }
      if (!isPlaying()) return;
      sim.release(id, judgeTime(timeStamp));
      afterSimulation();
    },
    cancel() {
      session.pause('inputcancel');
    },
    blur() {
      session.pause('blur');
    },
  };

  const session: GameplaySession = {
    get state() {
      return state;
    },
    events,
    get config() {
      return config;
    },
    get loading(): LoadingInfo {
      const { loaded, failed, total } = samples.progress;
      return { chartLoaded, samples: { loaded, failed, total } };
    },
    get pauseInfo() {
      return pauseInfo;
    },
    get countdown() {
      return countdown;
    },
    get results() {
      return results;
    },
    get error() {
      return error;
    },

    stats() {
      const score = sim?.score;
      live.score = score?.score ?? 0;
      live.combo = score?.combo ?? 0;
      live.maxCombo = score?.maxCombo ?? 0;
      live.perfect = score?.perfect ?? 0;
      live.good = score?.good ?? 0;
      live.miss = score?.miss ?? 0;
      live.accuracy = score ? accuracyOf(score) : 0;
      if (results) {
        live.progress = results.progress;
        live.stars = results.stars;
      } else if (state === 'failing' && sim?.endMs !== undefined) {
        live.progress = reach(sim.endMs);
        live.stars = starsFor(live.progress, false);
      } else {
        live.progress = isRunActiveState() ? reach(engine.timeline.songTime()) : 0;
        live.stars = starsFor(live.progress, false);
      }
      return live;
    },

    load(setup) {
      if (state !== 'loading' && state !== 'ready' && state !== 'error' && state !== 'quit') {
        endRun();
      }
      const token = (loadToken += 1);
      config = undefined;
      sim = undefined;
      chartLoaded = false;
      error = undefined;
      setState('loading');
      const { chart, ...rest } = setup;
      const chartReady = Promise.resolve(chart).then((loaded: Chart) => {
        if (token === loadToken) chartLoaded = true;
        return loaded;
      });
      Promise.all([chartReady, samples.ready]).then(
        ([loaded]) => {
          if (token !== loadToken) return;
          config = { ...rest, chart: loaded };
          sim = newSimulation();
          setState('ready');
        },
        (reason: unknown) => {
          if (token !== loadToken) return;
          error = reason instanceof Error ? reason.message : String(reason);
          setState('error');
        },
      );
    },

    start() {
      if (!config || (state !== 'ready' && state !== 'quit' && state !== 'finished')) return;
      startWhenAudioRuns(state === 'finished' ? 'quit' : state);
    },

    pause(reason = 'player') {
      if (state === 'leadIn' || state === 'playing' || state === 'countdown') enterPause(reason);
    },

    resume() {
      if (state !== 'paused' || !pauseInfo) return;
      if (engine.phase === 'interrupted') {
        updatePause('recovering');
        engine.resumeFromGesture({ resumeClock: false });
        return;
      }
      beginCountdown();
    },

    restart() {
      if (!config || state === 'loading' || state === 'error' || state === 'ready') return;
      endRun();
      setState('quit');
      startWhenAudioRuns('quit');
    },

    quit() {
      if (state === 'loading' || state === 'ready' || state === 'error' || state === 'quit') return;
      endRun();
      sim = newSimulation();
      setState('quit');
    },

    input: sink,
    acceptsInput: () => isPlaying() || state === 'countdown',
    attachInput(next) {
      input = next;
    },

    update() {
      if (!sim || !config || !isPlaying()) return;
      reach(engine.timeline.songTime());
      const horizon = finalizationHorizon(judgeTime(now()), config.tempo);
      sim.advance(horizon);
      afterSimulation();
      if (state === 'leadIn' && engine.clock.position() >= 0) setState('playing');
    },

    view() {
      return stageView;
    },
  };

  function isRunActiveState() {
    return state === 'leadIn' || state === 'playing' || state === 'paused' || state === 'countdown';
  }

  const displaySongMs = () => {
    if (!config) return 0;
    switch (state) {
      case 'leadIn':
      case 'playing':
        return engine.timeline.songTime();
      case 'paused':
      case 'countdown':
        return engine.clock.position();
      case 'failing':
      case 'finished': {
        const end = sim?.endMs ?? engine.clock.position();
        if (sim?.status !== 'failed') return end;
        // From where the clock stopped back to a little before the failure.
        const target = end - REWIND_SONG_MS * config.tempo;
        const eased = easeOut((now() - failedAt) / REWIND_DURATION_MS);
        return failedSongMs + (target - failedSongMs) * eased;
      }
      default:
        return -config.chart.leadInMs;
    }
  };

  const stageView: StageView = {
    get config() {
      return config;
    },
    get simulation() {
      return sim;
    },
    get songMs() {
      return displaySongMs();
    },
    get state() {
      return state;
    },
  };

  return session;
}
