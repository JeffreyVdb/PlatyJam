import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../app/events';
import type { AudioEngine, AudioEngineEvents } from '../audio/engine';
import { openCalibration } from './calibration-overlay';

function fakeEngine() {
  return {
    events: createEventBus<AudioEngineEvents>(),
    silence: vi.fn(),
    phase: 'running',
    context: { state: 'running', currentTime: 0 },
  };
}

describe('openCalibration', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('silences everything playing as soon as it opens, whoever opens it', () => {
    const engine = fakeEngine();
    openCalibration({ root: document.body, engine: engine as unknown as AudioEngine });
    expect(engine.silence).toHaveBeenCalledTimes(1);
  });

  it('silences again when a round starts, and keeps focus in the sheet', () => {
    const engine = fakeEngine();
    const handle = openCalibration({
      root: document.body,
      engine: engine as unknown as AudioEngine,
    });
    const start = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Start');
    start?.click();
    expect(engine.silence).toHaveBeenCalledTimes(2);
    // Start is gone: focus stays in the sheet, so Escape and Space still work.
    expect(document.activeElement?.className).toContain('calibration-body');
    // Before the round's first frame: the fake engine has no clock to draw from.
    handle.close();
  });
});
