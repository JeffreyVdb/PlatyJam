import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../app/events';
import { createLifecycle } from '../app/lifecycle';
import type { AudioEngine, AudioEngineEvents, EnginePhase } from './engine';
import { createOutputLatencyWatch, watchOutputLatency } from './latency-watch';
import {
  DELAYED_OUTPUT_MS,
  type LatencySample,
  SAMPLE_INTERVAL_MS,
  VERDICT_SAMPLES,
} from './latency-warning';

const DELAYED = DELAYED_OUTPUT_MS + 150;
const ON_TIME = 10;

/** A scripted latency source. */
function source(initial: LatencySample) {
  let value = initial;
  const read = vi.fn(() => value);
  return {
    read,
    set(next: LatencySample) {
      value = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createOutputLatencyWatch', () => {
  it('is unsure before any reading', () => {
    const watch = createOutputLatencyWatch({ read: source(DELAYED).read });
    expect(watch.verdict()).toBe('unsure');
    expect(watch.latencyMs()).toBeUndefined();
  });

  it('judges the output after enough readings, and reports its latency', () => {
    const watch = createOutputLatencyWatch({ read: source(DELAYED).read });
    for (let i = 0; i < VERDICT_SAMPLES; i += 1) watch.sampleNow();
    expect(watch.verdict()).toBe('delayed');
    expect(watch.latencyMs()).toBe(DELAYED);
  });

  it('reads on a timer once started, from a clean window, and stops', () => {
    const fake = source(DELAYED);
    const watch = createOutputLatencyWatch({ read: fake.read });
    watch.sampleNow();
    watch.start();
    expect(fake.read).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * (VERDICT_SAMPLES - 1));
    expect(watch.verdict()).toBe('delayed');
    watch.stop();
    fake.read.mockClear();
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 5);
    expect(fake.read).not.toHaveBeenCalled();
  });

  it('turns on time only after enough readings below the threshold, in a row', () => {
    const fake = source(DELAYED);
    const watch = createOutputLatencyWatch({ read: fake.read });
    watch.start();
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * VERDICT_SAMPLES);
    expect(watch.verdict()).toBe('delayed');

    fake.set(ON_TIME);
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * (VERDICT_SAMPLES - 1));
    expect(watch.verdict()).toBe('unsure');
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    expect(watch.verdict()).toBe('onTime');
  });

  it('never calls an unknown output delayed', () => {
    const watch = createOutputLatencyWatch({ read: source(undefined).read });
    watch.start();
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 10);
    expect(watch.verdict()).toBe('unsure');
    expect(watch.latencyMs()).toBeUndefined();
  });

  it('tells subscribers about each reading and reset, until they leave', () => {
    const watch = createOutputLatencyWatch({ read: source(DELAYED).read });
    const listener = vi.fn();
    const off = watch.subscribe(listener);
    watch.sampleNow();
    watch.reset();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    watch.sampleNow();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('forgets the readings on reset', () => {
    const watch = createOutputLatencyWatch({ read: source(DELAYED).read });
    for (let i = 0; i < VERDICT_SAMPLES; i += 1) watch.sampleNow();
    watch.reset();
    expect(watch.verdict()).toBe('unsure');
  });
});

describe('watchOutputLatency', () => {
  function setup(phase: EnginePhase = 'locked') {
    const fake = source(DELAYED);
    const events = createEventBus<AudioEngineEvents>();
    const engine = {
      events,
      phase,
      outputLatency: fake.read,
    } as unknown as AudioEngine & { phase: EnginePhase };
    const bus = createLifecycle();
    const devices = new EventTarget();
    const watched = watchOutputLatency({ engine, bus, devices });
    const settle = () => vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * VERDICT_SAMPLES);
    return { fake, events, engine, bus, devices, watched, settle };
  }

  it('waits for the unlock before reading', () => {
    const { fake, events, engine, watched, settle } = setup();
    settle();
    expect(fake.read).not.toHaveBeenCalled();
    engine.phase = 'running';
    events.emit('unlocked', {});
    settle();
    expect(watched.watch.verdict()).toBe('delayed');
    watched.dispose();
  });

  it('starts at once when the engine already runs', () => {
    const { fake, watched } = setup('running');
    expect(fake.read).toHaveBeenCalledTimes(1);
    watched.dispose();
  });

  it('stops in the background and starts from a clean window on resume', () => {
    const { fake, bus, watched, settle } = setup('running');
    settle();
    expect(watched.watch.verdict()).toBe('delayed');

    bus.emit('pause', { reason: 'hidden' });
    fake.read.mockClear();
    settle();
    expect(fake.read).not.toHaveBeenCalled();

    fake.set(ON_TIME);
    bus.emit('resume', { reason: 'visible' });
    expect(watched.watch.verdict()).toBe('unsure');
    settle();
    expect(watched.watch.verdict()).toBe('onTime');
    watched.dispose();
  });

  it('does not read while the page is hidden, even when the engine recovers', () => {
    const { fake, bus, events, watched } = setup('running');
    bus.emit('pause', { reason: 'hidden' });
    fake.read.mockClear();
    events.emit('recovered', { recreated: false });
    expect(fake.read).not.toHaveBeenCalled();
    watched.dispose();
  });

  it('starts over when the output device changes', () => {
    const { fake, devices, watched, settle } = setup('running');
    settle();
    fake.set(ON_TIME);
    devices.dispatchEvent(new Event('devicechange'));
    expect(watched.watch.verdict()).toBe('unsure');
    settle();
    expect(watched.watch.verdict()).toBe('onTime');
    watched.dispose();
  });

  it('starts over when the engine recovers from an interruption', () => {
    const { fake, events, watched, settle } = setup('running');
    settle();
    fake.set(ON_TIME);
    events.emit('recovered', { recreated: false });
    settle();
    expect(watched.watch.verdict()).toBe('onTime');
    watched.dispose();
  });

  it('works where the browser has no device change events', () => {
    const fake = source(DELAYED);
    const engine = {
      events: createEventBus<AudioEngineEvents>(),
      phase: 'running',
      outputLatency: fake.read,
    } as unknown as AudioEngine;
    const watched = watchOutputLatency({ engine, bus: createLifecycle(), devices: undefined });
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * VERDICT_SAMPLES);
    expect(watched.watch.verdict()).toBe('delayed');
    watched.dispose();
  });

  it('stops everything on dispose', () => {
    const { fake, devices, watched } = setup('running');
    watched.dispose();
    fake.read.mockClear();
    devices.dispatchEvent(new Event('devicechange'));
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 5);
    expect(fake.read).not.toHaveBeenCalled();
  });
});
