import type { WebGLRenderer } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLifecycle } from '../app/lifecycle';
import { createRendererHost, type RendererHost } from './renderer-host';

/** Stands in for WebGLRenderer; jsdom has no WebGL. */
function fakeRenderer(canvas: HTMLCanvasElement) {
  const dispatch = (type: string) => canvas.dispatchEvent(new Event(type, { cancelable: true }));
  return {
    canvas,
    loop: null as ((time: number) => void) | null,
    setAnimationLoop: vi.fn(function (this: { loop: unknown }, cb: unknown) {
      this.loop = cb;
    }),
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    dispose: vi.fn(),
    forceContextLoss: () => dispatch('webglcontextlost'),
    forceContextRestore: () => dispatch('webglcontextrestored'),
  };
}
type FakeRenderer = ReturnType<typeof fakeRenderer>;

describe('createRendererHost', () => {
  let host: RendererHost | undefined;
  let made: FakeRenderer[];
  const surface = document.createElement('div');

  const create = (bus = createLifecycle(), stuckTimeoutMs = 3000) => {
    host = createRendererHost({
      surface,
      bus,
      stuckTimeoutMs,
      createRenderer: (canvas) => {
        const renderer = fakeRenderer(canvas);
        made.push(renderer);
        return renderer as unknown as WebGLRenderer;
      },
    });
    host.setFrame(() => undefined);
    return { bus, host };
  };
  const current = () => {
    const renderer = made.at(-1);
    if (!renderer) throw new Error('no renderer created');
    return renderer;
  };

  beforeEach(() => {
    made = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    host?.dispose();
    host = undefined;
    vi.useRealTimers();
  });

  it('starts the loop once a frame callback is set', () => {
    create();
    expect(current().loop).toBeTypeOf('function');
    expect(surface.querySelector('canvas')).toBe(current().canvas);
  });

  it('stops the loop while paused and restarts it on resume', () => {
    const { bus } = create();
    bus.emit('pause', { reason: 'hidden' });
    expect(current().loop).toBeNull();
    bus.emit('resume', { reason: 'visible' });
    expect(current().loop).toBeTypeOf('function');
  });

  it('clamps the frame delta after a long stall', () => {
    const { host } = create();
    const deltas: number[] = [];
    host.setFrame((delta) => deltas.push(delta));
    current().loop?.(0);
    current().loop?.(60_000);
    expect(deltas.at(-1)).toBeLessThanOrEqual(0.1);
  });

  it('applies resize events with CSS owning the element size', () => {
    const { bus } = create();
    bus.emit('resize', { width: 1180, height: 820, pixelRatio: 2 });
    expect(current().setPixelRatio).toHaveBeenCalledWith(2);
    expect(current().setSize).toHaveBeenCalledWith(1180, 820, false);
  });

  it('stops on context loss and resumes on restore, telling subscribers to rebuild', () => {
    const { bus, host } = create();
    const lost = vi.fn();
    const restored = vi.fn();
    bus.on('contextlost', lost);
    bus.on('contextrestored', restored);

    host.loseContext();
    expect(lost).toHaveBeenCalledOnce();
    expect(current().loop).toBeNull();
    expect(host.state().contextLost).toBe(true);

    host.restoreContext();
    expect(restored).toHaveBeenCalledExactlyOnceWith({ renderer: current(), recreated: false });
    expect(current().loop).toBeTypeOf('function');
    vi.advanceTimersByTime(10_000);
    expect(made).toHaveLength(1);
  });

  it('prevents the default on context loss so a restore can happen', () => {
    create();
    const event = new Event('webglcontextlost', { cancelable: true });
    current().canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('recreates renderer and canvas when the context stays lost (WebKit 278010)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bus, host } = create();
    const restored = vi.fn();
    bus.on('contextrestored', restored);
    const first = current();

    host.loseContext();
    vi.advanceTimersByTime(3000);

    expect(made).toHaveLength(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(first.canvas.isConnected).toBe(false);
    expect(host.canvas).toBe(current().canvas);
    expect(surface.querySelectorAll('canvas')).toHaveLength(1);
    expect(restored).toHaveBeenCalledExactlyOnceWith({ renderer: current(), recreated: true });
    expect(host.renderer).toBe(current());
    expect(current().loop).toBeTypeOf('function');
  });

  it('does not count time spent hidden towards the stuck timeout', () => {
    const { bus, host } = create();
    host.loseContext();
    bus.emit('pause', { reason: 'hidden' });
    vi.advanceTimersByTime(10_000);
    expect(made).toHaveLength(1);

    bus.emit('resume', { reason: 'visible' });
    host.restoreContext();
    vi.advanceTimersByTime(10_000);
    expect(made).toHaveLength(1);
  });

  it('gives up with contextfailed after repeated recreations', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bus } = create();
    const failed = vi.fn();
    bus.on('contextfailed', failed);

    for (let i = 0; i < 4; i += 1) {
      current().forceContextLoss();
      vi.advanceTimersByTime(3000);
    }

    expect(made).toHaveLength(4);
    expect(failed).toHaveBeenCalledOnce();
  });
});
