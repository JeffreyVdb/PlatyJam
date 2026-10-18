import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from './events';
import { createLifecycle, installPageLifecycle } from './lifecycle';

interface TestEvents {
  ping: { n: number };
  other: { s: string };
}

describe('createEventBus', () => {
  it('delivers payloads to subscribers of that event only', () => {
    const bus = createEventBus<TestEvents>();
    const ping = vi.fn();
    const other = vi.fn();
    bus.on('ping', ping);
    bus.on('other', other);

    bus.emit('ping', { n: 1 });

    expect(ping).toHaveBeenCalledExactlyOnceWith({ n: 1 });
    expect(other).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const bus = createEventBus<TestEvents>();
    const handler = vi.fn();
    const off = bus.on('ping', handler);

    off();
    bus.emit('ping', { n: 1 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a handler unsubscribe during emit without skipping the others', () => {
    const bus = createEventBus<TestEvents>();
    const second = vi.fn();
    const off = bus.on('ping', () => {
      off();
    });
    bus.on('ping', second);

    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });

    expect(second).toHaveBeenCalledTimes(2);
  });

  it('keeps notifying when one handler throws', () => {
    const bus = createEventBus<TestEvents>();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = vi.fn();
    bus.on('ping', () => {
      throw new Error('boom');
    });
    bus.on('ping', after);

    bus.emit('ping', { n: 1 });

    expect(after).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
});

describe('installPageLifecycle', () => {
  let state: DocumentVisibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  const setVisibility = (next: DocumentVisibilityState) => {
    state = next;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  let dispose: () => void = () => undefined;
  afterEach(() => {
    dispose();
    state = 'visible';
  });

  it('emits pause when hidden and resume when visible again', () => {
    const bus = createLifecycle();
    const pause = vi.fn();
    const resume = vi.fn();
    bus.on('pause', pause);
    bus.on('resume', resume);
    dispose = installPageLifecycle(bus);

    setVisibility('hidden');
    expect(pause).toHaveBeenCalledExactlyOnceWith({ reason: 'hidden' });
    expect(resume).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(resume).toHaveBeenCalledExactlyOnceWith({ reason: 'visible' });
  });

  it('emits each transition once when pagehide follows visibilitychange', () => {
    const bus = createLifecycle();
    const pause = vi.fn();
    const resume = vi.fn();
    bus.on('pause', pause);
    bus.on('resume', resume);
    dispose = installPageLifecycle(bus);

    setVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));
    setVisibility('visible');
    window.dispatchEvent(new Event('pageshow'));

    expect(pause).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });

  it('pauses on pagehide and resumes on pageshow (bfcache)', () => {
    const bus = createLifecycle();
    const pause = vi.fn();
    const resume = vi.fn();
    bus.on('pause', pause);
    bus.on('resume', resume);
    dispose = installPageLifecycle(bus);

    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));

    expect(pause).toHaveBeenCalledExactlyOnceWith({ reason: 'pagehide' });
    expect(resume).toHaveBeenCalledExactlyOnceWith({ reason: 'pageshow' });
  });

  it('does not resume while the page is still hidden', () => {
    const bus = createLifecycle();
    const resume = vi.fn();
    bus.on('resume', resume);
    dispose = installPageLifecycle(bus);

    setVisibility('hidden');
    window.dispatchEvent(new Event('pageshow'));

    expect(resume).not.toHaveBeenCalled();
  });

  it('stops listening after dispose', () => {
    const bus = createLifecycle();
    const pause = vi.fn();
    bus.on('pause', pause);
    installPageLifecycle(bus)();

    setVisibility('hidden');

    expect(pause).not.toHaveBeenCalled();
  });
});
