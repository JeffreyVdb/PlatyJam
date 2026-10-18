import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PIXEL_RATIO,
  ORIENTATION_REMEASURE_MS,
  capPixelRatio,
  computeViewportSize,
  watchViewport,
} from './viewport';

describe('capPixelRatio', () => {
  it('caps high-density screens at 2', () => {
    expect(MAX_PIXEL_RATIO).toBe(2);
    expect(capPixelRatio(3)).toBe(2);
    expect(capPixelRatio(2)).toBe(2);
  });

  it('keeps lower ratios as they are', () => {
    expect(capPixelRatio(1)).toBe(1);
    expect(capPixelRatio(1.5)).toBe(1.5);
  });

  it('falls back to 1 for missing or nonsense values', () => {
    expect(capPixelRatio(0)).toBe(1);
    expect(capPixelRatio(Number.NaN)).toBe(1);
    expect(capPixelRatio(-2)).toBe(1);
  });
});

describe('computeViewportSize', () => {
  it('rounds CSS sizes and caps the pixel ratio', () => {
    expect(computeViewportSize(820.4, 1179.6, 2)).toEqual({
      width: 820,
      height: 1180,
      pixelRatio: 2,
    });
    expect(computeViewportSize(1180, 820, 3)).toEqual({ width: 1180, height: 820, pixelRatio: 2 });
  });

  it('never returns a zero-sized surface', () => {
    expect(computeViewportSize(0, 0, 1)).toEqual({ width: 1, height: 1, pixelRatio: 1 });
  });
});

describe('watchViewport', () => {
  let size = { width: 820, height: 1180 };
  const measure = () => size;
  let dispose: () => void = () => undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame'] });
  });
  afterEach(() => {
    dispose();
    vi.useRealTimers();
    size = { width: 820, height: 1180 };
  });

  it('reports the initial size immediately', () => {
    const onChange = vi.fn();
    ({ dispose } = watchViewport({ measure, onChange }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      width: 820,
      height: 1180,
      pixelRatio: capPixelRatio(window.devicePixelRatio),
    });
  });

  it('coalesces resize events into one measurement per frame', () => {
    const onChange = vi.fn();
    ({ dispose } = watchViewport({ measure, onChange }));
    onChange.mockClear();

    size = { width: 1180, height: 820 };
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersToNextFrame();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 1180, height: 820 }),
    );
  });

  it('ignores phantom resizes that do not change the size', () => {
    const onChange = vi.fn();
    ({ dispose } = watchViewport({ measure, onChange }));
    onChange.mockClear();

    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersToNextFrame();

    expect(onChange).not.toHaveBeenCalled();
  });

  it('measures again after an orientation change to catch stale sizes', () => {
    const onChange = vi.fn();
    ({ dispose } = watchViewport({ measure, onChange }));
    onChange.mockClear();

    // iPadOS can still report the old orientation during the event itself.
    window.dispatchEvent(new Event('orientationchange'));
    vi.advanceTimersToNextFrame();
    expect(onChange).not.toHaveBeenCalled();

    size = { width: 1180, height: 820 };
    vi.advanceTimersByTime(ORIENTATION_REMEASURE_MS);
    vi.advanceTimersToNextFrame();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ width: 1180, height: 820 }),
    );
  });

  it('stops listening after dispose', () => {
    const onChange = vi.fn();
    const watcher = watchViewport({ measure, onChange });
    watcher.dispose();
    onChange.mockClear();

    size = { width: 1180, height: 820 };
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersToNextFrame();

    expect(onChange).not.toHaveBeenCalled();
  });
});
