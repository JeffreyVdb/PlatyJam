import { describe, expect, it, vi } from 'vitest';
import {
  CALIBRATION_KEY,
  loadCalibration,
  loadOffsets,
  saveCalibration,
} from './calibration-store';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const throwing = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('full', 'QuotaExceededError');
  },
};

describe('calibration store', () => {
  it('round-trips the offsets under one namespaced key', () => {
    const storage = memoryStorage();
    const saved = saveCalibration(
      { audioOffsetMs: 42, inputOffsetMs: -12 },
      { storage: () => storage, now: () => new Date('2026-10-18T20:00:00Z') },
    );
    expect(saved).toBe(true);
    expect(JSON.parse(storage.data.get(CALIBRATION_KEY) ?? '')).toEqual({
      version: 1,
      audioOffsetMs: 42,
      inputOffsetMs: -12,
      calibratedAt: '2026-10-18T20:00:00.000Z',
    });
    expect(loadCalibration(() => storage)).toEqual({
      version: 1,
      audioOffsetMs: 42,
      inputOffsetMs: -12,
      calibratedAt: '2026-10-18T20:00:00.000Z',
    });
    expect(CALIBRATION_KEY).toBe('platyjam.calibration.v1');
  });

  it('reads zeros when nothing was saved', () => {
    expect(loadCalibration(() => memoryStorage())).toBeNull();
    expect(loadOffsets(() => memoryStorage())).toEqual({ audioOffsetMs: 0, inputOffsetMs: 0 });
  });

  it.each([
    ['not JSON', '{oops'],
    ['a different version', '{"version":2,"audioOffsetMs":1,"inputOffsetMs":1,"calibratedAt":"x"}'],
    [
      'a non-numeric offset',
      '{"version":1,"audioOffsetMs":"9","inputOffsetMs":1,"calibratedAt":"x"}',
    ],
    [
      'a NaN-like offset',
      '{"version":1,"audioOffsetMs":null,"inputOffsetMs":1,"calibratedAt":"x"}',
    ],
    ['a missing date', '{"version":1,"audioOffsetMs":1,"inputOffsetMs":1}'],
    ['an array', '[1,2]'],
    ['null', 'null'],
  ])('reads zeros from corrupt data: %s', (_label, raw) => {
    const storage = () => memoryStorage({ [CALIBRATION_KEY]: raw });
    expect(loadCalibration(storage)).toBeNull();
    expect(loadOffsets(storage)).toEqual({ audioOffsetMs: 0, inputOffsetMs: 0 });
  });

  it('clamps stored offsets into range on read', () => {
    const raw = JSON.stringify({
      version: 1,
      audioOffsetMs: 9000,
      inputOffsetMs: -9000,
      calibratedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(loadOffsets(() => memoryStorage({ [CALIBRATION_KEY]: raw }))).toEqual({
      audioOffsetMs: 400,
      inputOffsetMs: -150,
    });
  });

  it('clamps offsets before saving', () => {
    const storage = memoryStorage();
    saveCalibration({ audioOffsetMs: 1000, inputOffsetMs: 12.6 }, { storage: () => storage });
    expect(loadOffsets(() => storage)).toEqual({ audioOffsetMs: 400, inputOffsetMs: 13 });
  });

  it('survives storage that throws, on read and on write', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(loadOffsets(() => throwing)).toEqual({ audioOffsetMs: 0, inputOffsetMs: 0 });
    expect(
      saveCalibration({ audioOffsetMs: 1, inputOffsetMs: 1 }, { storage: () => throwing }),
    ).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('survives localStorage itself being inaccessible', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const denied = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    expect(loadOffsets(denied)).toEqual({ audioOffsetMs: 0, inputOffsetMs: 0 });
    expect(saveCalibration({ audioOffsetMs: 1, inputOffsetMs: 1 }, { storage: denied })).toBe(
      false,
    );
    warn.mockRestore();
  });
});
