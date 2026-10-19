import { createEventBus, type EventBus } from '../app/events';
import type { Lifecycle } from '../app/lifecycle';
import { type AudioSessionResult, requestPlaybackSession } from './audio-session';
import { clampOffsets } from './calibration';
import { createSongClock, type SongClock } from './clock';
import { contextTimeAt, sampleOutputTime } from './output-time';
import { createTimeline, type LatencyOffsets, type Timeline, ZERO_OFFSETS } from './timeline';

/** How long scheduled audio gets to fade out before the context is suspended. */
export const INTERRUPT_FADE_MS = 30;
/** Silent recovery on return: suspend, wait this long, resume (WebKit 281566). */
export const RECOVERY_DELAY_MS = 200;
/** Fade for `silence()` when the caller gives none. */
export const SILENCE_FADE_MS = 50;
/** A resume() that has not settled by then is treated as stuck. */
export const RESUME_TIMEOUT_MS = 300;
/** After resuming, `currentTime` must move within this window (WebKit 263627). */
export const ADVANCE_PROBE_MS = 100;

const MASTER_GAIN = 0.8;

export type EnginePhase =
  /** The context has never run: waiting for the first user gesture. */
  | 'locked'
  | 'running'
  /** Paused by the engine; waits for `resumeFromGesture()` ("Tap to resume"). */
  | 'interrupted';

export type InterruptReason = 'background' | 'context' | 'simulated';

export interface AudioEngineEvents {
  /** The context's own state changed. */
  statechange: { state: AudioContextState };
  /** Audio started for the first time. */
  unlocked: Record<string, never>;
  /**
   * The song clock is paused and audio is fading out. Stop scheduling and show
   * "Tap to resume"; call `resumeFromGesture()` from that tap.
   */
  interrupted: { reason: InterruptReason };
  /** The resume tap did not bring audio back; ask for one more tap (it recreates the context). */
  needsgesture: { recreate: boolean };
  /**
   * The resume tap brought audio back. The song clock is still paused unless
   * `resumed` follows; with `resumeFromGesture({ resumeClock: false })` it waits for
   * `resumeClock()` (the game runs its countdown in between).
   */
  recovered: { recreated: boolean };
  /** The song clock continues. Re-plan scheduled audio now. */
  resumed: { recreated: boolean };
  /**
   * A new AudioContext replaced a stuck one. Every node is gone (decoded
   * AudioBuffers still work); `context` and `output` already point at the new ones.
   */
  recreated: { context: AudioContext; count: number };
  /**
   * Something needs quiet (the calibration): fade out every sound and forget the
   * song, as on quit. Whoever plays audio on the engine subscribes.
   */
  silenced: { fadeMs: number };
}

export interface AudioEngineDebugState {
  phase: EnginePhase;
  contextState: AudioContextState;
  sampleRate: number;
  baseLatency: number | undefined;
  outputLatency: number | undefined;
  currentTime: number;
  /** The session type read back after asking for `playback`, or `unsupported`. */
  audioSession: AudioSessionType | 'unsupported';
  unlockAttempts: Record<string, number>;
  unlockedBy: string | undefined;
  recreations: number;
  needsRecreate: boolean;
}

/**
 * Owns the one AudioContext: its master gain, unlocking, interruptions and
 * recreation, and the song clock and timeline built on it.
 */
export interface AudioEngine {
  /** The current context. It changes after a recreation, so never cache it. */
  readonly context: AudioContext;
  /** Master gain; connect voices here. Rebuilt with the context. */
  readonly output: GainNode;
  readonly events: EventBus<AudioEngineEvents>;
  readonly phase: EnginePhase;
  /** The gameplay song clock. The engine pauses it on interruptions and resumes it on the tap. */
  readonly clock: SongClock;
  /** `clock` with the calibrated offsets: `songTime()`, `judgeSongTime()`, `startTimeFor()`. */
  readonly timeline: Timeline;
  readonly offsets: Readonly<LatencyOffsets>;
  setOffsets(offsets: LatencyOffsets): void;
  /** Maps a performance.now()-based time to the context time audible then. */
  contextTimeAt(perfMs: number): number;
  /** Starts audio on the first user gesture. Returns a function that removes the listeners. */
  installUnlock(doc?: Document): () => void;
  /**
   * Call synchronously from the "Tap to resume" gesture handler. Resumes the
   * context there (or recreates it when it is known to be stuck) and emits
   * `recovered`; then resumes the clock and emits `resumed`, unless `resumeClock`
   * is false, which leaves the song paused for `resumeClock()`.
   */
  resumeFromGesture(options?: { resumeClock?: boolean }): void;
  /**
   * Resumes a paused song clock and emits `resumed` (the accompaniment re-plans on
   * it). Ignored while the audio is interrupted or the clock already runs.
   */
  resumeClock(): void;
  /** Stops everything playing on the engine, with a short fade (emits `silenced`). */
  silence(fadeMs?: number): void;
  /** Debug: interrupts as backgrounding would. `stuck` makes the next tap recreate. */
  simulateInterruption(options?: { stuck?: boolean }): void;
  debugState(): AudioEngineDebugState;
  dispose(): void;
}

export interface AudioEngineOptions {
  bus: Lifecycle;
  createContext?: () => AudioContext;
  nav?: { audioSession?: AudioSession };
  nowMs?: () => number;
}

/**
 * The events that grant user activation (HTML spec), so `resume()` may start
 * audio. Touch `pointerdown` is deliberately not one of them.
 */
const UNLOCK_EVENTS = ['touchend', 'pointerup', 'pointerdown', 'mousedown', 'keydown', 'click'];

function isActivation(event: Event): boolean {
  const { pointerType } = event as Partial<PointerEvent>;
  if (event.type === 'pointerup') return pointerType !== 'mouse';
  if (event.type === 'pointerdown') return pointerType === 'mouse';
  return true;
}

const noop = () => undefined;

// A function, not an inline comparison, so TypeScript does not narrow `state` across an await.
const isRunning = (ctx: BaseAudioContext) => ctx.state === 'running';

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Resolves true if `promise` fulfils within `ms`, false if it rejects or takes longer. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

export function createAudioEngine({
  bus,
  createContext = () => new AudioContext({ latencyHint: 'interactive' }),
  nav = navigator,
  nowMs = () => performance.now(),
}: AudioEngineOptions): AudioEngine {
  const events = createEventBus<AudioEngineEvents>();
  // Before the context exists: the session type decides how WebKit routes it.
  const session: AudioSessionResult = requestPlaybackSession(nav);

  let ctx!: AudioContext;
  let output!: GainNode;
  let unlocked = false;
  let interrupted = false;
  let needsRecreate = false;
  let recreations = 0;
  // Bumped to abandon an in-flight resume or recovery when the situation changed.
  let attempt = 0;
  let resuming = false;
  // Whether the context was recreated since the clock last resumed, for `resumed`.
  let recreatedSinceResume = false;
  let offsets: LatencyOffsets = { ...ZERO_OFFSETS };
  let removeUnlock = noop;
  let unlockedBy: string | undefined;
  const unlockAttempts: Record<string, number> = {};

  const clock = createSongClock(() => ctx.currentTime);
  const mapToContext = (perfMs: number) => contextTimeAt(perfMs, sampleOutputTime(ctx, nowMs()));
  const timeline = createTimeline({
    clock,
    contextTimeAt: mapToContext,
    nowMs,
    offsets: () => offsets,
  });

  const phase = (): EnginePhase => (!unlocked ? 'locked' : interrupted ? 'interrupted' : 'running');

  const onStateChange = () => {
    const { state } = ctx;
    events.emit('statechange', { state });
    if (state === 'running' && !unlocked) {
      unlocked = true;
      removeUnlock();
      events.emit('unlocked', {});
      return;
    }
    if (!unlocked || interrupted) return;
    // While running, only the platform suspends us: a call, Siri, another app's audio.
    if (state === 'interrupted' || state === 'suspended') interrupt('context');
    if (state === 'closed') {
      needsRecreate = true;
      interrupt('context');
    }
  };

  const build = () => {
    ctx = createContext();
    ctx.addEventListener('statechange', onStateChange);
    output = ctx.createGain();
    output.gain.value = MASTER_GAIN;
    output.connect(ctx.destination);
  };

  /** Close the stuck context and build a new one. Must run synchronously inside a gesture. */
  const recreate = () => {
    const stale = ctx;
    stale.removeEventListener('statechange', onStateChange);
    build();
    recreations += 1;
    needsRecreate = false;
    void stale.close().catch(noop);
    events.emit('recreated', { context: ctx, count: recreations });
  };

  const suspendAfterFade = (token: number) => {
    const target = ctx;
    setTimeout(() => {
      if (token !== attempt || !interrupted || target !== ctx) return;
      void target.suspend().catch(noop);
    }, INTERRUPT_FADE_MS);
  };

  function interrupt(reason: InterruptReason) {
    attempt += 1;
    resuming = false;
    if (interrupted) {
      suspendAfterFade(attempt);
      return;
    }
    interrupted = true;
    // Through the timeline, so the game can still settle up to what the player heard.
    timeline.pause();
    events.emit('interrupted', { reason });
    suspendAfterFade(attempt);
  }

  /** Resolves true when `target` runs and its clock moves. */
  const confirmRunning = async (target: AudioContext, resumed: Promise<void>) => {
    if (!(await settlesWithin(resumed, RESUME_TIMEOUT_MS))) return false;
    if (!isRunning(target)) return false;
    const before = target.currentTime;
    await delay(ADVANCE_PROBE_MS);
    // Re-read after the wait: the state can change while we sleep.
    return isRunning(target) && target.currentTime > before;
  };

  /** On return to the foreground: the non-gesture recovery. Leaves the song paused. */
  const recoverSilently = () => {
    const token = (attempt += 1);
    const target = ctx;
    const current = () => token === attempt && target === ctx && interrupted;
    void (async () => {
      await target.suspend().catch(noop);
      await delay(RECOVERY_DELAY_MS);
      if (!current()) return;
      const ok = await confirmRunning(target, target.resume());
      if (current() && !ok) needsRecreate = true;
    })();
  };

  function resumeSongClock() {
    if (interrupted || clock.isRunning) return;
    clock.resume();
    const recreated = recreatedSinceResume;
    recreatedSinceResume = false;
    events.emit('resumed', { recreated });
  }

  const offs = [
    bus.on('pause', () => {
      if (unlocked) interrupt('background');
    }),
    bus.on('resume', () => {
      if (interrupted) recoverSilently();
    }),
  ];

  build();

  return {
    get context() {
      return ctx;
    },
    get output() {
      return output;
    },
    events,
    get phase() {
      return phase();
    },
    clock,
    timeline,
    get offsets() {
      return offsets;
    },
    setOffsets(next) {
      offsets = clampOffsets(next);
    },
    contextTimeAt: mapToContext,

    installUnlock(doc = document) {
      removeUnlock();
      const onGesture = (event: Event) => {
        if (unlocked || !isActivation(event)) return;
        unlockAttempts[event.type] = (unlockAttempts[event.type] ?? 0) + 1;
        // Synchronously, inside the gesture: nothing may be awaited before this.
        const target = ctx;
        void target.resume().then(() => {
          // The first attempt that worked, for the debug readout.
          if (isRunning(target)) unlockedBy ??= event.type;
        }, noop);
      };
      const options = { capture: true, passive: true };
      for (const type of UNLOCK_EVENTS) doc.addEventListener(type, onGesture, options);
      removeUnlock = () => {
        for (const type of UNLOCK_EVENTS) doc.removeEventListener(type, onGesture, options);
        removeUnlock = noop;
      };
      if (ctx.state === 'running') onStateChange();
      return () => {
        removeUnlock();
      };
    },

    resumeFromGesture({ resumeClock = true } = {}) {
      if (!interrupted || resuming) return;
      const recreated = needsRecreate;
      // `new AudioContext()` and `resume()` both run synchronously in the gesture.
      if (recreated) recreate();
      const token = (attempt += 1);
      const target = ctx;
      resuming = true;
      void confirmRunning(target, target.resume()).then((ok) => {
        if (token !== attempt || target !== ctx) return;
        resuming = false;
        if (!ok) {
          needsRecreate = true;
          events.emit('needsgesture', { recreate: true });
          return;
        }
        interrupted = false;
        recreatedSinceResume ||= recreated;
        events.emit('recovered', { recreated });
        if (resumeClock) resumeSongClock();
      });
    },

    resumeClock: resumeSongClock,

    silence(fadeMs = SILENCE_FADE_MS) {
      events.emit('silenced', { fadeMs });
    },

    simulateInterruption({ stuck = false } = {}) {
      if (!unlocked) return;
      interrupt('simulated');
      if (stuck) needsRecreate = true;
    },

    debugState() {
      const latency = ctx as Partial<Pick<AudioContext, 'baseLatency' | 'outputLatency'>>;
      return {
        phase: phase(),
        contextState: ctx.state,
        sampleRate: ctx.sampleRate,
        baseLatency: latency.baseLatency,
        outputLatency: latency.outputLatency,
        currentTime: ctx.currentTime,
        audioSession: session.supported ? session.type : 'unsupported',
        unlockAttempts: { ...unlockAttempts },
        unlockedBy,
        recreations,
        needsRecreate,
      };
    },

    dispose() {
      for (const off of offs) off();
      removeUnlock();
      attempt += 1;
      ctx.removeEventListener('statechange', onStateChange);
      void ctx.close().catch(noop);
    },
  };
}
