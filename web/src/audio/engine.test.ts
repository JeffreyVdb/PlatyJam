import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLifecycle } from '../app/lifecycle';
import { type AudioEngine, createAudioEngine, SILENCE_FADE_MS } from './engine';

type ResumeBehaviour = 'run' | 'reject' | 'hang' | 'stay-suspended' | 'frozen';

/** Stands in for AudioContext; jsdom has no Web Audio. */
class FakeContext extends EventTarget {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  frozen = false;
  readonly sampleRate = 48_000;
  readonly baseLatency = 0.005;
  readonly destination = { label: 'destination' };
  /** What the next resume() calls do. */
  behaviour: ResumeBehaviour = 'run';
  readonly gains: { connect: ReturnType<typeof vi.fn> }[] = [];

  resume = vi.fn(() => {
    switch (this.behaviour) {
      case 'reject':
        return Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
      case 'hang':
        return new Promise<void>(() => undefined);
      case 'stay-suspended':
        return Promise.resolve();
      case 'frozen':
        this.frozen = true;
        this.setState('running');
        return Promise.resolve();
      case 'run':
        this.frozen = false;
        this.setState('running');
        return Promise.resolve();
    }
  });
  suspend = vi.fn(() => {
    this.setState('suspended');
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.setState('closed');
    return Promise.resolve();
  });
  createGain = () => {
    const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    this.gains.push(gain);
    return gain;
  };
  getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 0 });

  setState(state: AudioContextState) {
    if (this.state === state) return;
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }

  /** Moves this context's clock (only while it runs). */
  advance(seconds: number) {
    if (this.state === 'running' && !this.frozen) this.currentTime += seconds;
  }
}

describe('createAudioEngine', () => {
  let engine: AudioEngine | undefined;
  let contexts: FakeContext[];
  let session: { type: AudioSessionType };
  let disposeUnlock: () => void;

  beforeEach(() => {
    contexts = [];
    session = { type: 'auto' };
    disposeUnlock = () => undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    disposeUnlock();
    engine?.dispose();
    engine = undefined;
    vi.useRealTimers();
  });

  const create = ({
    nav = { audioSession: session as unknown as AudioSession },
  }: { nav?: { audioSession?: AudioSession } } = {}) => {
    const bus = createLifecycle();
    const events: string[] = [];
    engine = createAudioEngine({
      bus,
      nav,
      nowMs: () => 0,
      createContext: () => {
        const ctx = new FakeContext();
        // A context made during a gesture may already run; a fresh fake behaves like iOS.
        contexts.push(ctx);
        return ctx as unknown as AudioContext;
      },
    });
    for (const type of [
      'unlocked',
      'interrupted',
      'needsgesture',
      'resumed',
      'recreated',
    ] as const) {
      engine.events.on(type, () => events.push(type));
    }
    return { bus, engine, events };
  };
  const ctx = () => {
    const current = contexts.at(-1);
    if (!current) throw new Error('no context');
    return current;
  };
  /** Advances timers and the current context clock together, flushing promises. */
  const wait = async (ms: number) => {
    for (let i = 0; i < ms; i += 10) {
      ctx().advance(0.01);
      await vi.advanceTimersByTimeAsync(10);
    }
  };
  const unlock = async (engine: AudioEngine) => {
    disposeUnlock = engine.installUnlock(document);
    document.dispatchEvent(new Event('touchend'));
    await wait(10);
  };
  /** Unlocked, song playing from 0, then `seconds` of playback. */
  const playing = async (seconds = 2) => {
    const made = create();
    await unlock(made.engine);
    made.engine.clock.start(0);
    await wait(seconds * 1000);
    return made;
  };

  describe('audio session', () => {
    it('asks for the playback session before creating the context', () => {
      let typeWhenCreated: string | undefined;
      engine = createAudioEngine({
        bus: createLifecycle(),
        nav: { audioSession: session as unknown as AudioSession },
        createContext: () => {
          typeWhenCreated = session.type;
          return new FakeContext() as unknown as AudioContext;
        },
      });
      expect(typeWhenCreated).toBe('playback');
      expect(engine.debugState().audioSession).toBe('playback');
    });

    it('reports a session that silently ignored the assignment', () => {
      const stubborn = {
        get type() {
          return 'auto';
        },
        set type(_value) {
          // WebKit without the microphone permissions policy: ignored.
        },
      };
      create({ nav: { audioSession: stubborn as unknown as AudioSession } });
      expect(engine?.debugState().audioSession).toBe('auto');
    });

    it('reports a missing API', () => {
      create({ nav: {} });
      expect(engine?.debugState().audioSession).toBe('unsupported');
    });
  });

  describe('unlock', () => {
    it('calls resume() synchronously inside the gesture and stops listening once running', async () => {
      const { engine, events } = create();
      disposeUnlock = engine.installUnlock(document);
      expect(engine.phase).toBe('locked');

      document.dispatchEvent(new Event('keydown'));
      expect(ctx().resume).toHaveBeenCalledOnce();
      await wait(10);
      expect(engine.phase).toBe('running');
      expect(events).toEqual(['unlocked']);

      document.dispatchEvent(new Event('click'));
      expect(ctx().resume).toHaveBeenCalledOnce();
      expect(engine.debugState().unlockAttempts).toEqual({ keydown: 1 });
      expect(engine.debugState().unlockedBy).toBe('keydown');
    });

    it('counts attempts per event type while the context refuses to start', async () => {
      const { engine } = create();
      ctx().behaviour = 'stay-suspended';
      disposeUnlock = engine.installUnlock(document);

      document.dispatchEvent(new Event('touchend'));
      document.dispatchEvent(new Event('mousedown'));
      document.dispatchEvent(new Event('touchend'));
      await wait(10);

      expect(engine.phase).toBe('locked');
      expect(engine.debugState().unlockAttempts).toEqual({ touchend: 2, mousedown: 1 });
    });

    it('uses pointerup for touch and pointerdown for a mouse, never touch pointerdown', () => {
      const { engine } = create();
      ctx().behaviour = 'stay-suspended';
      disposeUnlock = engine.installUnlock(document);
      const pointer = (type: string, pointerType: string) => {
        const event = new Event(type);
        Object.defineProperty(event, 'pointerType', { value: pointerType });
        document.dispatchEvent(event);
      };

      pointer('pointerdown', 'touch');
      pointer('pointerup', 'mouse');
      expect(ctx().resume).not.toHaveBeenCalled();

      pointer('pointerup', 'touch');
      pointer('pointerdown', 'mouse');
      expect(ctx().resume).toHaveBeenCalledTimes(2);
      expect(engine.debugState().unlockAttempts).toEqual({ pointerup: 1, pointerdown: 1 });
    });

    it('listens in the capture phase, so a handler that stops propagation cannot block it', () => {
      const { engine } = create();
      disposeUnlock = engine.installUnlock(document);
      const button = document.createElement('button');
      document.body.append(button);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
      });

      button.dispatchEvent(new Event('click', { bubbles: true }));

      expect(ctx().resume).toHaveBeenCalledOnce();
      button.remove();
    });
  });

  describe('interruptions', () => {
    it('on background: pauses the song, tells the game, then suspends the context', async () => {
      const { bus, engine, events } = await playing(2);
      bus.emit('pause', { reason: 'hidden' });

      expect(engine.phase).toBe('interrupted');
      expect(engine.clock.isRunning).toBe(false);
      expect(engine.clock.position()).toBeCloseTo(2000, 6);
      expect(events).toEqual(['unlocked', 'interrupted']);
      // The fade-out gets to finish before the context stops.
      expect(ctx().suspend).not.toHaveBeenCalled();
      await wait(50);
      expect(ctx().suspend).toHaveBeenCalledOnce();
      expect(ctx().state).toBe('suspended');
    });

    it('treats the context going "interrupted" as an interruption', async () => {
      const { engine, events } = await playing(1);
      ctx().setState('interrupted');
      expect(engine.phase).toBe('interrupted');
      expect(engine.clock.isRunning).toBe(false);
      expect(events).toEqual(['unlocked', 'interrupted']);
    });

    it('treats an unexpected suspend as an interruption, but not its own', async () => {
      const { bus, engine, events } = await playing(1);
      ctx().setState('suspended');
      expect(engine.phase).toBe('interrupted');
      bus.emit('pause', { reason: 'hidden' });
      await wait(100);
      expect(events.filter((e) => e === 'interrupted')).toHaveLength(1);
    });

    it('on return: runs the silent suspend/resume recovery but does not restart the song', async () => {
      const { bus, engine, events } = await playing(1);
      bus.emit('pause', { reason: 'hidden' });
      await wait(100);
      ctx().suspend.mockClear();

      bus.emit('resume', { reason: 'visible' });
      expect(ctx().suspend).toHaveBeenCalledOnce();
      await wait(150);
      expect(ctx().resume).toHaveBeenCalledTimes(1); // only the unlock so far
      await wait(100);
      expect(ctx().resume).toHaveBeenCalledTimes(2);
      await wait(300);

      expect(ctx().state).toBe('running');
      expect(engine.phase).toBe('interrupted');
      expect(engine.clock.isRunning).toBe(false);
      expect(events).not.toContain('resumed');
    });
  });

  describe('silence', () => {
    it('asks everything playing to fade out, with the given or a short default fade', () => {
      const { engine } = create();
      const fades: number[] = [];
      engine.events.on('silenced', ({ fadeMs }) => fades.push(fadeMs));
      engine.silence(80);
      engine.silence();
      expect(fades).toEqual([80, SILENCE_FADE_MS]);
    });
  });

  describe('tap to resume', () => {
    it('resumes the context in the gesture, then the song from where it paused', async () => {
      const { bus, engine, events } = await playing(2);
      bus.emit('pause', { reason: 'hidden' });
      await wait(100);
      bus.emit('resume', { reason: 'visible' });
      await wait(600);
      const resumes = ctx().resume.mock.calls.length;

      engine.resumeFromGesture();
      expect(ctx().resume).toHaveBeenCalledTimes(resumes + 1);
      await wait(300);

      expect(engine.phase).toBe('running');
      expect(engine.clock.isRunning).toBe(true);
      expect(engine.clock.position()).toBeGreaterThanOrEqual(2000);
      expect(engine.clock.position()).toBeLessThan(2400);
      expect(events.at(-1)).toBe('resumed');
      expect(contexts).toHaveLength(1);
    });

    it('ignores taps while nothing is interrupted', async () => {
      const { engine } = await playing(1);
      const resumes = ctx().resume.mock.calls.length;
      engine.resumeFromGesture();
      expect(ctx().resume).toHaveBeenCalledTimes(resumes);
    });

    it.each([
      ['resume() rejects', 'reject'],
      ['resume() never settles', 'hang'],
      ['the context stays suspended', 'stay-suspended'],
      ['currentTime does not advance (WebKit 263627)', 'frozen'],
    ] as const)(
      'when %s: asks for another tap, which recreates the context inside that gesture',
      async (_label, behaviour) => {
        const { engine, events } = await playing(3);
        engine.simulateInterruption();
        await wait(100);
        const stuck = ctx();
        stuck.behaviour = behaviour;

        engine.resumeFromGesture();
        await wait(600);
        expect(engine.phase).toBe('interrupted');
        expect(events.at(-1)).toBe('needsgesture');
        expect(engine.debugState().needsRecreate).toBe(true);

        engine.resumeFromGesture();
        // Created synchronously in the gesture, with the old one closed.
        expect(contexts).toHaveLength(2);
        expect(ctx().resume).toHaveBeenCalledOnce();
        expect(stuck.close).toHaveBeenCalledOnce();
        expect(engine.context).toBe(ctx());
        expect(engine.output).toBe(ctx().gains[0]);
        expect(ctx().gains[0]?.connect).toHaveBeenCalledWith(ctx().destination);
        expect(events).toContain('recreated');

        await wait(300);
        expect(engine.phase).toBe('running');
        expect(events.at(-1)).toBe('resumed');
        expect(engine.debugState().recreations).toBe(1);
        // The new context restarted at 0; the song continues from 3 s.
        expect(ctx().currentTime).toBeLessThan(1);
        expect(engine.clock.position()).toBeGreaterThanOrEqual(3000);
        expect(engine.clock.position()).toBeLessThan(3400);
      },
    );

    it('recreates on the first tap when the silent recovery already failed', async () => {
      const { bus, engine, events } = await playing(1);
      bus.emit('pause', { reason: 'hidden' });
      await wait(100);
      ctx().behaviour = 'hang';
      bus.emit('resume', { reason: 'visible' });
      await wait(800);
      expect(engine.debugState().needsRecreate).toBe(true);
      expect(events).not.toContain('needsgesture');

      engine.resumeFromGesture();
      expect(contexts).toHaveLength(2);
      await wait(300);
      expect(engine.phase).toBe('running');
    });

    it('can simulate a stuck context, so recreation is testable on desktop', async () => {
      const { engine } = await playing(1);
      engine.simulateInterruption({ stuck: true });
      engine.resumeFromGesture();
      expect(contexts).toHaveLength(2);
      await wait(300);
      expect(engine.phase).toBe('running');
    });

    it('drops a resume attempt that the page going hidden overtook', async () => {
      const { bus, engine, events } = await playing(1);
      engine.simulateInterruption();
      await wait(100);
      // This attempt would succeed, but the page hides before it is confirmed.
      engine.resumeFromGesture();
      bus.emit('pause', { reason: 'hidden' });
      await wait(600);

      expect(engine.phase).toBe('interrupted');
      expect(engine.clock.isRunning).toBe(false);
      expect(events).not.toContain('resumed');
      expect(ctx().state).toBe('suspended');
    });
  });

  describe('timeline', () => {
    it('applies the offsets it was given, clamped', async () => {
      const { engine } = await playing(0);
      engine.setOffsets({ audioOffsetMs: 9999, inputOffsetMs: 20 });
      expect(engine.offsets).toEqual({ audioOffsetMs: 400, inputOffsetMs: 20 });
    });
  });
});
