import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameAudio } from '../audio/game-audio';
import { createAudioDebugSection } from './audio-debug';

function fakeAudio() {
  const noop = () => undefined;
  const piano = { stopAll: vi.fn(), noteOn: vi.fn(), noteOff: vi.fn(), setPlaybackRate: noop };
  const accompaniment = {
    stopAll: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stats: () => ({ scheduled: 0, skipped: 0, lastLeadMs: 0 }),
  };
  const backing = { stopAll: vi.fn(), play: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  const effects = { play: vi.fn(), fill: vi.fn(), stopAll: vi.fn() };
  const engine = {
    context: { currentTime: 0 },
    events: { on: noop },
    offsets: { audioOffsetMs: 0, inputOffsetMs: 0 },
    timeline: { songTime: () => 0 },
    clock: { position: () => 0, pause: noop },
    debugState: () => ({ unlockAttempts: {}, phase: 'running', contextState: 'running' }),
    simulateInterruption: noop,
    outputLatency: () => 187.4,
    setDebugOutputLatency: vi.fn(),
  };
  const audio = {
    engine,
    piano,
    accompaniment,
    backing,
    effects,
    samples: { progress: { loaded: 0, failed: 0, total: 88 } },
    setTuning: noop,
    activeVoices: () => 0,
  } as unknown as GameAudio;
  return { audio, piano, accompaniment, backing, effects, engine };
}

describe('the debug Audio section', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('"Stop all" fades the song\'s recording out with the rest', () => {
    vi.useFakeTimers();
    const fake = fakeAudio();
    const section = createAudioDebugSection({
      audio: fake.audio,
      openCalibration: () => undefined,
    });
    const stopAll = [...section.querySelectorAll('button')].find(
      (node) => node.textContent === 'Stop all',
    );
    stopAll?.click();
    expect(fake.accompaniment.stopAll).toHaveBeenCalledWith(200);
    expect(fake.piano.stopAll).toHaveBeenCalledWith(200);
    expect(fake.backing.stopAll).toHaveBeenCalledWith(200);
    expect(fake.effects.stopAll).toHaveBeenCalledWith(200);
  });

  it('plays each sound effect from its own button', () => {
    vi.useFakeTimers();
    const fake = fakeAudio();
    const section = createAudioDebugSection({
      audio: fake.audio,
      openCalibration: () => undefined,
    });
    const row = section.querySelector('[aria-labelledby="debug-effects-caption"]');
    const named = (label: string) =>
      [...(row?.querySelectorAll('button') ?? [])].find((node) => node.textContent === label);
    expect([...(row?.querySelectorAll('button') ?? [])].map((node) => node.textContent)).toEqual([
      'Tap',
      'Clear',
      'Complete',
      'Miss',
      'Combo',
      'Fill',
    ]);
    named('Tap')?.click();
    named('Combo')?.click();
    expect(fake.effects.play.mock.calls).toEqual([['tap'], ['combo']]);
    named('Fill')?.click();
    expect(fake.effects.fill).toHaveBeenCalledWith(2);
  });

  it('shows the output latency in milliseconds, and "unknown" when there is none', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fake = fakeAudio();
    const section = createAudioDebugSection({
      audio: fake.audio,
      openCalibration: () => undefined,
    });
    expect(section.textContent).toContain('Output latency now: 187.4 ms');
    fake.engine.outputLatency = () => undefined as unknown as number;
    vi.advanceTimersByTime(250);
    expect(section.textContent).toContain('Output latency now: unknown');
  });

  it('fakes the output latency from its buttons, and goes back to the real one', () => {
    vi.useFakeTimers();
    const fake = fakeAudio();
    const section = createAudioDebugSection({
      audio: fake.audio,
      openCalibration: () => undefined,
    });
    const press = (label: string) =>
      [...section.querySelectorAll('button')].find((node) => node.textContent === label)?.click();
    press('250 ms');
    expect(fake.engine.setDebugOutputLatency).toHaveBeenLastCalledWith(250);
    expect(section.textContent).toContain('(faked)');
    press('Real');
    expect(fake.engine.setDebugOutputLatency).toHaveBeenLastCalledWith(undefined);
    expect(section.textContent).not.toContain('(faked)');
  });

  it('starts on the latency faked by ?debug&latency=, even a value the buttons lack', () => {
    vi.useFakeTimers();
    const section = createAudioDebugSection({
      audio: fakeAudio().audio,
      openCalibration: () => undefined,
      fakedLatencyMs: 333,
    });
    const pressed = section.querySelector('button[aria-pressed="true"]');
    expect(pressed?.textContent).toBe('333 ms');
  });

  it('logs each device change with its time, newest first', () => {
    vi.useFakeTimers();
    const devices = new EventTarget();
    const section = createAudioDebugSection({
      audio: fakeAudio().audio,
      openCalibration: () => undefined,
      devices,
    });
    expect(section.textContent).toContain('Device changes: none yet');
    devices.dispatchEvent(new Event('devicechange'));
    devices.dispatchEvent(new Event('devicechange'));
    const lines = section.textContent.match(/\d\d:\d\d:\d\d\.\d{3} latency 187 ms/g);
    expect(lines).toHaveLength(2);
  });

  it('says when the browser reports no device changes', () => {
    vi.useFakeTimers();
    const section = createAudioDebugSection({
      audio: fakeAudio().audio,
      openCalibration: () => undefined,
    });
    expect(section.textContent).toContain('Device changes: not reported by this browser');
  });
});
