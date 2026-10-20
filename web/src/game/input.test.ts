import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventTime, installLaneInput, type LaneInput } from './input';

type Call = [string, ...unknown[]];

describe('lane input', () => {
  let surface: HTMLElement;
  let calls: Call[];
  let accepting: boolean;
  let input: LaneInput;

  beforeEach(() => {
    surface = document.createElement('main');
    document.body.append(surface);
    calls = [];
    accepting = true;
    input = installLaneInput({
      surface,
      win: window,
      // Four 100 px lanes; anything below y = 400 is off the lane surface.
      laneAt: (x, y) => (y > 400 || x < 0 || x >= 400 ? undefined : Math.floor(x / 100)),
      accepting: () => accepting,
      now: () => 1000,
      sink: {
        press: (id, lane, at) => calls.push(['press', id, lane, at]),
        release: (id, at) => calls.push(['release', id, at]),
        cancel: () => calls.push(['cancel']),
        blur: () => calls.push(['blur']),
      },
    });
  });
  afterEach(() => {
    input.dispose();
    surface.remove();
  });

  const pointer = (
    type: string,
    pointerId: number,
    x = 0,
    {
      pointerType = 'touch',
      button = 0,
      target = surface,
    }: { pointerType?: string; button?: number; target?: EventTarget } = {},
  ) => {
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId,
        pointerType,
        button,
        clientX: x,
        clientY: 100,
        bubbles: true,
      }),
    );
  };
  const key = (type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}) => {
    window.dispatchEvent(new KeyboardEvent(type, { code, ...init }));
  };
  const presses = () =>
    calls.filter(([kind]) => kind === 'press').map(([, id, lane]) => [id, lane]);

  it('turns two fingers landing together into two presses on their lanes', () => {
    pointer('pointerdown', 1, 50);
    pointer('pointerdown', 2, 350);
    expect(presses()).toEqual([
      ['p1', 0],
      ['p2', 3],
    ]);
    expect(input.isLaneHeld(0) && input.isLaneHeld(3)).toBe(true);
  });

  it('keeps a pointer on its lane while it slides, and releases it by id', () => {
    pointer('pointerdown', 7, 150);
    pointer('pointermove', 7, 350);
    pointer('pointerup', 7, 350, { target: window });
    expect(calls.map(([kind, id]) => [kind, id])).toEqual([
      ['press', 'p7'],
      ['release', 'p7'],
    ]);
    expect(input.isLaneHeld(1)).toBe(false);
  });

  it('ignores presses off the lane surface, a repeated pointer and other mouse buttons', () => {
    surface.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 50, clientY: 500, bubbles: true }),
    );
    pointer('pointerdown', 2, 50);
    pointer('pointerdown', 2, 50);
    pointer('pointerdown', 3, 50, { pointerType: 'mouse', button: 2 });
    pointer('pointerdown', 4, 250, { pointerType: 'mouse' });
    expect(presses()).toEqual([
      ['p2', 0],
      ['p4', 2],
    ]);
  });

  it('maps D F J K to lanes 0-3, ignoring auto-repeat and modified keys', () => {
    key('keydown', 'KeyD');
    key('keydown', 'KeyD', { repeat: true });
    key('keydown', 'KeyK');
    key('keydown', 'KeyJ', { metaKey: true });
    key('keydown', 'KeyA');
    key('keyup', 'KeyD');
    expect(calls.map(([kind, id]) => [kind, id])).toEqual([
      ['press', 'kKeyD'],
      ['press', 'kKeyK'],
      ['release', 'kKeyD'],
    ]);
    expect(presses()).toEqual([
      ['kKeyD', 0],
      ['kKeyK', 3],
    ]);
  });

  it('does not track presses while gameplay is not accepting them', () => {
    accepting = false;
    pointer('pointerdown', 1, 50);
    key('keydown', 'KeyF');
    accepting = true;
    pointer('pointerup', 1, 50);
    key('keyup', 'KeyF');
    expect(calls).toEqual([]);
  });

  it('reports a cancelled touch, and the window losing focus', () => {
    pointer('pointerdown', 1, 50);
    pointer('pointercancel', 1, 50);
    window.dispatchEvent(new Event('blur'));
    expect(calls.map(([kind]) => kind)).toEqual(['press', 'cancel', 'blur']);
  });

  it('forgets every held input on clear(), so their releases do nothing', () => {
    pointer('pointerdown', 1, 50);
    key('keydown', 'KeyJ');
    input.clear();
    expect(input.isLaneHeld(0)).toBe(false);
    pointer('pointerup', 1, 50);
    key('keyup', 'KeyJ');
    // A key still physically down presses again only on a fresh keydown.
    key('keydown', 'KeyJ', { repeat: true });
    key('keydown', 'KeyJ');
    expect(calls.map(([kind, id]) => [kind, id])).toEqual([
      ['press', 'p1'],
      ['press', 'kKeyJ'],
      ['press', 'kKeyJ'],
    ]);
  });
});

describe('eventTime', () => {
  it('uses the event timestamp while it is plausibly recent', () => {
    expect(eventTime(980, 1000)).toBe(980);
    expect(eventTime(750, 1000)).toBe(750);
  });

  it('falls back to now for a timestamp from the future or too far back (WebKit 217099)', () => {
    expect(eventTime(1001, 1000)).toBe(1000);
    expect(eventTime(749, 1000)).toBe(1000);
  });
});

describe('lane input with the Tiles hit test', () => {
  it('passes where a finger landed along the lane, and keys without one', () => {
    const surface = document.createElement('main');
    document.body.append(surface);
    const calls: unknown[][] = [];
    const input = installLaneInput({
      surface,
      win: window,
      laneAt: () => undefined,
      // Four 100 px lanes; `along` grows down the screen. Off the lanes above y = 0.
      spotAt: (x, y) =>
        y < 0 ? undefined : { lane: Math.floor(x / 100), along: (y - 300) / 400, reach: 0.05 },
      accepting: () => true,
      now: () => 1000,
      sink: {
        press: (id, lane, at, spot) => calls.push([id, lane, at, spot]),
        release: () => undefined,
        cancel: () => undefined,
        blur: () => undefined,
      },
    });
    const down = (pointerId: number, clientX: number, clientY: number) => {
      surface.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId, pointerType: 'touch', clientX, clientY }),
      );
    };
    down(1, 250, 100);
    down(2, 50, -10);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK' }));
    expect(calls).toEqual([
      ['p1', 2, 1000, { lane: 2, along: -0.5, reach: 0.05 }],
      ['kKeyK', 3, 1000, undefined],
    ]);
    input.dispose();
    surface.remove();
  });
});
