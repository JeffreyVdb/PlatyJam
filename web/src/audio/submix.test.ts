import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../app/events';
import type { AudioEngineEvents } from './engine';
import { createSubmix } from './submix';

interface FakeGain {
  gain: { value: number };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function fakeContext() {
  const gains: FakeGain[] = [];
  return {
    gains,
    createGain: () => {
      const gain: FakeGain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      gains.push(gain);
      return gain;
    },
  };
}

function fakeEngine() {
  const events = createEventBus<AudioEngineEvents>();
  const engine = {
    events,
    context: fakeContext(),
    output: { label: 'master 1' },
    /** What the engine does on recreation: new context and master, then the event. */
    recreate(count: number) {
      engine.context = fakeContext();
      engine.output = { label: `master ${count}` };
      events.emit('recreated', {
        context: engine.context as unknown as AudioContext,
        count,
      });
    },
  };
  return engine;
}

const asEngine = (engine: ReturnType<typeof fakeEngine>) =>
  engine as unknown as Parameters<typeof createSubmix>[0];

describe('createSubmix', () => {
  it('is a gain at the given volume feeding the master output', () => {
    const engine = fakeEngine();
    const mix = createSubmix(asEngine(engine), 0.6);
    const [gain] = engine.context.gains;
    expect(mix.output).toBe(gain);
    expect(gain?.gain.value).toBe(0.6);
    expect(gain?.connect).toHaveBeenCalledWith(engine.output);
    expect(mix.context).toBe(engine.context);
  });

  it('changes loudness at once, clamped to 0–1', () => {
    const engine = fakeEngine();
    const mix = createSubmix(asEngine(engine));
    mix.setVolume(0.25);
    expect(mix.volume).toBe(0.25);
    expect(engine.context.gains[0]?.gain.value).toBe(0.25);
    mix.setVolume(7);
    expect(mix.volume).toBe(1);
    mix.setVolume(Number.NaN);
    expect(mix.volume).toBe(0);
  });

  it('rebuilds itself on the new context when the engine recreates it, keeping the volume', () => {
    const engine = fakeEngine();
    const mix = createSubmix(asEngine(engine), 0.4);
    const old = mix.output;
    engine.recreate(1);
    const [gain] = engine.context.gains;
    expect(mix.output).not.toBe(old);
    expect(mix.output).toBe(gain);
    expect(mix.context).toBe(engine.context);
    expect(gain?.gain.value).toBe(0.4);
    expect(gain?.connect).toHaveBeenCalledWith(engine.output);
  });

  it('stops following the engine once disposed', () => {
    const engine = fakeEngine();
    const mix = createSubmix(asEngine(engine));
    const old = mix.output;
    mix.dispose();
    engine.recreate(1);
    expect(mix.output).toBe(old);
  });
});
