import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameAudio } from '../audio/game-audio';
import { createAudioDebugSection } from './audio-debug';

function fakeAudio() {
  const noop = () => undefined;
  const piano = { stopAll: vi.fn(), noteOn: vi.fn(), noteOff: vi.fn(), setPlaybackRate: noop };
  const accompaniment = { stopAll: vi.fn(), play: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  const backing = { stopAll: vi.fn(), play: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  const engine = {
    context: { currentTime: 0 },
    events: { on: noop },
    offsets: { audioOffsetMs: 0, inputOffsetMs: 0 },
    timeline: { songTime: () => 0 },
    clock: { position: () => 0, pause: noop },
    debugState: () => ({ unlockAttempts: {}, phase: 'running', contextState: 'running' }),
    simulateInterruption: noop,
  };
  const audio = {
    engine,
    piano,
    accompaniment,
    backing,
    samples: { progress: { loaded: 0, failed: 0, total: 88 } },
    setTuning: noop,
    activeVoices: () => 0,
  } as unknown as GameAudio;
  return { audio, piano, accompaniment, backing };
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
  });
});
