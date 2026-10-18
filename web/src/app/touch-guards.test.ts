import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTouchGuards } from './touch-guards';

const cancelable = (type: string) => new Event(type, { bubbles: true, cancelable: true });

describe('installTouchGuards', () => {
  let dispose: () => void = () => undefined;
  afterEach(() => {
    dispose();
    document.body.replaceChildren();
  });

  const setup = () => {
    const surface = document.createElement('div');
    const canvas = document.createElement('canvas');
    surface.append(canvas);
    const button = document.createElement('button');
    document.body.append(surface, button);
    return { surface, canvas, button };
  };

  it('registers the touch listeners as non-passive', () => {
    const { surface } = setup();
    const add = vi.spyOn(surface, 'addEventListener');
    const addOnDocument = vi.spyOn(document, 'addEventListener');

    dispose = installTouchGuards(surface);

    for (const type of ['touchstart', 'touchmove']) {
      expect(add).toHaveBeenCalledWith(type, expect.any(Function), { passive: false });
    }
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      expect(addOnDocument).toHaveBeenCalledWith(type, expect.any(Function), { passive: false });
    }
  });

  it('cancels touches that start or move on the canvas', () => {
    const { surface, canvas } = setup();
    dispose = installTouchGuards(surface);

    const start = cancelable('touchstart');
    const move = cancelable('touchmove');
    canvas.dispatchEvent(start);
    canvas.dispatchEvent(move);

    expect(start.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
  });

  it('leaves touches on HUD buttons alone so they stay tappable', () => {
    const { surface, button } = setup();
    dispose = installTouchGuards(surface);

    const start = cancelable('touchstart');
    button.dispatchEvent(start);

    expect(start.defaultPrevented).toBe(false);
  });

  it('blocks pinch gestures and the context menu everywhere', () => {
    const { surface, button } = setup();
    dispose = installTouchGuards(surface);

    const gesture = cancelable('gesturestart');
    const menu = cancelable('contextmenu');
    document.dispatchEvent(gesture);
    button.dispatchEvent(menu);

    expect(gesture.defaultPrevented).toBe(true);
    expect(menu.defaultPrevented).toBe(true);
  });

  it('removes every guard on dispose', () => {
    const { surface, canvas } = setup();
    installTouchGuards(surface)();

    const start = cancelable('touchstart');
    const menu = cancelable('contextmenu');
    canvas.dispatchEvent(start);
    document.dispatchEvent(menu);

    expect(start.defaultPrevented).toBe(false);
    expect(menu.defaultPrevented).toBe(false);
  });
});
