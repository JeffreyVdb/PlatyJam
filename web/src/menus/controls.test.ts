import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gestureButton, slider } from './controls';

const touch = (target: Element, type: 'pointerdown' | 'pointerup', pointerId = 1) =>
  target.dispatchEvent(
    new PointerEvent(type, { pointerId, pointerType: 'touch', bubbles: true, cancelable: true }),
  );
/** A click as a browser sends it: after a touch, or from a mouse or the keyboard. */
const click = (target: Element) =>
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

/** A radio row, as song select lists the songs. */
function radioRow() {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'song';
  const changed = vi.fn();
  input.addEventListener('change', changed);
  label.append(input, 'A song');
  return { label, input, changed };
}

describe('gesture buttons', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    // Ends any click guard a test left armed.
    document.dispatchEvent(new PointerEvent('pointerdown'));
  });

  it('run once for a touch, inside its pointerup', () => {
    const onTap = vi.fn();
    const node = gestureButton('Restart', 'quiet', onTap);
    document.body.append(node);
    touch(node, 'pointerdown');
    touch(node, 'pointerup');
    expect(onTap).toHaveBeenCalledOnce();
    click(node);
    expect(onTap).toHaveBeenCalledOnce();
  });

  it('run for a mouse or keyboard click', () => {
    const onTap = vi.fn();
    const node = gestureButton('Retry', 'primary', onTap);
    document.body.append(node);
    click(node);
    click(node);
    expect(onTap).toHaveBeenCalledTimes(2);
  });

  describe('when the command swaps the screen under the finger', () => {
    let row: ReturnType<typeof radioRow>;
    beforeEach(() => {
      row = radioRow();
      const quit = gestureButton('Quit', 'quiet', () => {
        document.body.replaceChildren(row.label);
      });
      document.body.append(quit);
      touch(quit, 'pointerdown');
      touch(quit, 'pointerup');
      expect(document.body.contains(quit)).toBe(false);
    });

    it("drops the touch's synthesized click on whatever is now there", () => {
      const seen = vi.fn();
      row.label.addEventListener('click', seen);
      row.input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      click(row.input);
      expect(row.input.checked).toBe(false);
      expect(row.changed).not.toHaveBeenCalled();
      expect(seen).not.toHaveBeenCalled();
    });

    it('drops it on a label too', () => {
      click(row.label);
      expect(row.input.checked).toBe(false);
      expect(row.changed).not.toHaveBeenCalled();
    });

    it('drops only one click', () => {
      click(row.label);
      click(row.label);
      expect(row.input.checked).toBe(true);
    });

    it('lets the next real tap through, however soon', () => {
      touch(row.label, 'pointerdown', 2);
      touch(row.label, 'pointerup', 2);
      click(row.label);
      expect(row.input.checked).toBe(true);
      expect(row.changed).toHaveBeenCalledOnce();
    });

    it('lets a key press through', () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      click(row.input);
      expect(row.input.checked).toBe(true);
    });

    it('lets a click through once a synthesized one could no longer come', () => {
      vi.advanceTimersByTime(1000);
      click(row.label);
      expect(row.input.checked).toBe(true);
    });
  });

  it('leave clicks alone after a touch that ran nothing', () => {
    const node = gestureButton('Play', 'primary', vi.fn());
    node.disabled = true;
    const row = radioRow();
    document.body.append(node, row.label);
    touch(node, 'pointerdown');
    touch(node, 'pointerup');
    click(row.label);
    expect(row.input.checked).toBe(true);
  });
});

describe('slider', () => {
  const make = (describedBy?: string) =>
    slider({
      label: 'Effects',
      value: 0.7,
      onInput: vi.fn(),
      onCommit: vi.fn(),
      describedBy,
    }).node.querySelector('[role="slider"]');

  it('is described by its hint when it has one', () => {
    expect(make('effects-hint')?.getAttribute('aria-describedby')).toBe('effects-hint');
  });

  it('has no description without one', () => {
    expect(make()?.hasAttribute('aria-describedby')).toBe(false);
  });
});
