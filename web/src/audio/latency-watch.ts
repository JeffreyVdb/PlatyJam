import type { Lifecycle } from '../app/lifecycle';
import type { AudioEngine } from './engine';
import {
  appendSample,
  judgeOutput,
  type LatencySample,
  type OutputVerdict,
  SAMPLE_INTERVAL_MS,
  typicalLatency,
} from './latency-warning';

/**
 * Keeps the latest output latency readings, so the Play tap can judge the output
 * without waiting: the verdict comes from readings taken before the tap.
 */
export interface OutputLatencyWatch {
  /** Reads once now and adds the reading to the window. */
  sampleNow(): void;
  verdict(): OutputVerdict;
  /** The typical latency of the recent readings in ms, `undefined` when none is known. */
  latencyMs(): number | undefined;
  /** Reads every `SAMPLE_INTERVAL_MS` from now on (from a clean window). */
  start(): void;
  stop(): void;
  /** Forgets the readings: the output changed, so earlier ones say nothing about it. */
  reset(): void;
  /** Runs after every reading and every reset. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface OutputLatencyWatchOptions {
  /** The latency in ms, or `undefined` when unknown. */
  read: () => number | undefined;
}

export function createOutputLatencyWatch({ read }: OutputLatencyWatchOptions): OutputLatencyWatch {
  let window: LatencySample[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const sampleNow = () => {
    window = appendSample(window, read());
    notify();
  };
  const stop = () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };
  const reset = () => {
    window = [];
    notify();
  };

  return {
    sampleNow,
    verdict: () => judgeOutput(window),
    latencyMs: () => typicalLatency(window),
    start() {
      stop();
      reset();
      sampleNow();
      timer = setInterval(sampleNow, SAMPLE_INTERVAL_MS);
    },
    stop,
    reset,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      stop();
      listeners.clear();
    },
  };
}

/** The part of `navigator.mediaDevices` the watch uses; absent on some browsers. */
export type DeviceChanges = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface WatchedOutputLatency {
  readonly watch: OutputLatencyWatch;
  dispose(): void;
}

/**
 * Watches the engine's output latency from the first unlock on. It restarts from a
 * clean window when the page comes back (`resume`), when the engine recovers from an
 * interruption, and on a `devicechange` (where the browser fires it without
 * microphone permission: Safari may not, so the Play tap also takes a reading), and
 * stops while the page is in the background.
 */
export function watchOutputLatency({
  engine,
  bus,
  devices,
}: {
  engine: AudioEngine;
  bus: Lifecycle;
  devices?: DeviceChanges | undefined;
}): WatchedOutputLatency {
  const watch = createOutputLatencyWatch({ read: () => engine.outputLatency() });
  let hidden = false;
  const restart = () => {
    if (!hidden && engine.phase !== 'locked') watch.start();
  };

  const offs = [
    engine.events.on('unlocked', restart),
    engine.events.on('recovered', restart),
    bus.on('pause', () => {
      hidden = true;
      watch.stop();
    }),
    bus.on('resume', () => {
      hidden = false;
      restart();
    }),
  ];
  devices?.addEventListener('devicechange', restart);
  restart();

  return {
    watch,
    dispose() {
      for (const off of offs) off();
      devices?.removeEventListener('devicechange', restart);
      watch.dispose();
    },
  };
}
