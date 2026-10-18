import { clampOffsets } from './calibration';
import type { LatencyOffsets } from './timeline';

/**
 * The saved calibration, one versioned record under one key, so PLA-7's settings
 * store can migrate it as a unit.
 */
export const CALIBRATION_KEY = 'platyjam.calibration.v1';

export interface StoredCalibration extends LatencyOffsets {
  version: 1;
  /** ISO 8601. */
  calibratedAt: string;
}

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** A getter, because touching `window.localStorage` can itself throw (blocked storage). */
export type StorageAccess = () => KeyValueStorage | null;

const defaultStorage: StorageAccess = () => window.localStorage;

function parse(raw: string): StoredCalibration | null {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<Record<keyof StoredCalibration, unknown>>;
  const { version, audioOffsetMs, inputOffsetMs, calibratedAt } = record;
  if (version !== 1 || typeof calibratedAt !== 'string') return null;
  if (typeof audioOffsetMs !== 'number' || !Number.isFinite(audioOffsetMs)) return null;
  if (typeof inputOffsetMs !== 'number' || !Number.isFinite(inputOffsetMs)) return null;
  return { version, calibratedAt, ...clampOffsets({ audioOffsetMs, inputOffsetMs }) };
}

/** The saved calibration, or null when there is none or it is unreadable. Never throws. */
export function loadCalibration(storage: StorageAccess = defaultStorage): StoredCalibration | null {
  try {
    const raw = storage()?.getItem(CALIBRATION_KEY);
    return raw ? parse(raw) : null;
  } catch (error) {
    console.warn('[platyjam] could not read the latency calibration', error);
    return null;
  }
}

/** The saved offsets, or zeros. Never throws. */
export function loadOffsets(storage: StorageAccess = defaultStorage): LatencyOffsets {
  const saved = loadCalibration(storage);
  return saved
    ? { audioOffsetMs: saved.audioOffsetMs, inputOffsetMs: saved.inputOffsetMs }
    : { audioOffsetMs: 0, inputOffsetMs: 0 };
}

/** Saves clamped offsets. Returns false when storage refused (full, blocked). Never throws. */
export function saveCalibration(
  offsets: LatencyOffsets,
  {
    storage = defaultStorage,
    now = () => new Date(),
  }: { storage?: StorageAccess; now?: () => Date } = {},
): boolean {
  const record: StoredCalibration = {
    version: 1,
    ...clampOffsets(offsets),
    calibratedAt: now().toISOString(),
  };
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(CALIBRATION_KEY, JSON.stringify(record));
    return true;
  } catch (error) {
    console.warn('[platyjam] could not save the latency calibration', error);
    return false;
  }
}
