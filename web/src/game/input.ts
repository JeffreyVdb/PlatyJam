import { LANES } from '../chart/schema';

/** Keyboard lanes, left to right, by `event.code` (layout-independent positions). */
export const KEY_LANES: Readonly<Record<string, number>> = { KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };

/**
 * An `event.timeStamp` further behind `now` than this, or ahead of it, is not
 * trusted (WebKit 217099: event timestamps can drift from `performance.now()`).
 */
export const MAX_EVENT_LAG_MS = 250;

/** The event's own timestamp, unless it is implausible; then `now`. */
export function eventTime(timeStamp: number, now: number): number {
  const lag = now - timeStamp;
  return lag < 0 || lag > MAX_EVENT_LAG_MS ? now : timeStamp;
}

/** Where lane input goes. Times are `performance.now()`-based ms (event timestamps). */
export interface LaneInputSink {
  /** `input` names the finger (`p<pointerId>`) or key (`k<code>`) until its release. */
  press(input: string, lane: number, timeStamp: number): void;
  release(input: string, timeStamp: number): void;
  /** The system cancelled a held touch (a gesture, palm rejection, rotation). */
  cancel(): void;
  /** The window lost focus: key releases may never arrive. */
  blur(): void;
}

export interface LaneInputOptions {
  /**
   * The play surface (`#stage`), not the canvas: the canvas is replaced when the
   * renderer is recreated. HUD controls live outside it, so their taps never land here.
   */
  surface: HTMLElement;
  win?: Window;
  /** The lane under a client point, or undefined off the lanes' play surface. */
  laneAt: (clientX: number, clientY: number) => number | undefined;
  /** Whether gameplay takes presses now. Presses made otherwise are never tracked. */
  accepting: () => boolean;
  sink: LaneInputSink;
  now?: () => number;
}

export interface LaneInput {
  /** Whether any held input is on `lane` (for the lane highlight). */
  isLaneHeld(lane: number): boolean;
  /**
   * Forgets every held input without releasing it (on pause). A finger or key still
   * down stays ignored until it is lifted and pressed again.
   */
  clear(): void;
  dispose(): void;
}

/**
 * Pointer and keyboard input for the four lanes, keyed by pointer id or key code.
 * A press binds the input to the lane it landed on until it is released: sliding a
 * finger never changes lanes or presses another one (touch has implicit pointer
 * capture, and the position after the press is ignored). Two fingers landing in the
 * same frame are two events with their own timestamps, and each becomes a press.
 */
export function installLaneInput({
  surface,
  win = window,
  laneAt,
  accepting,
  sink,
  now = () => performance.now(),
}: LaneInputOptions): LaneInput {
  /** Lane per held input. */
  const held = new Map<string, number>();
  const perLane = new Uint8Array(LANES);

  const hold = (input: string, lane: number) => {
    held.set(input, lane);
    perLane[lane] = (perLane[lane] ?? 0) + 1;
  };
  /** Returns whether `input` was held. */
  const drop = (input: string) => {
    const lane = held.get(input);
    if (lane === undefined) return false;
    held.delete(input);
    perLane[lane] = Math.max(0, (perLane[lane] ?? 0) - 1);
    return true;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const input = `p${event.pointerId}`;
    if (held.has(input) || !accepting()) return;
    const lane = laneAt(event.clientX, event.clientY);
    if (lane === undefined) return;
    hold(input, lane);
    sink.press(input, lane, eventTime(event.timeStamp, now()));
  };

  const onPointerUp = (event: PointerEvent) => {
    const input = `p${event.pointerId}`;
    if (drop(input)) sink.release(input, eventTime(event.timeStamp, now()));
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (drop(`p${event.pointerId}`)) sink.cancel();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const lane = KEY_LANES[event.code];
    if (lane === undefined || event.metaKey || event.ctrlKey || event.altKey) return;
    // Keep lane keys from scrolling or activating anything while they are lanes.
    if (accepting()) event.preventDefault();
    const input = `k${event.code}`;
    if (event.repeat || held.has(input) || !accepting()) return;
    hold(input, lane);
    sink.press(input, lane, eventTime(event.timeStamp, now()));
  };

  const onKeyUp = (event: KeyboardEvent) => {
    const input = `k${event.code}`;
    if (drop(input)) {
      sink.release(input, eventTime(event.timeStamp, now()));
      return;
    }
    // Key-ups are lost while Meta is down; treat it like losing focus.
    if (event.key === 'Meta' && [...held.keys()].some((id) => id.startsWith('k'))) sink.blur();
  };

  const onBlur = () => {
    sink.blur();
  };

  const capture = { capture: true };
  surface.addEventListener('pointerdown', onPointerDown);
  win.addEventListener('pointerup', onPointerUp, capture);
  win.addEventListener('pointercancel', onPointerCancel, capture);
  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', onBlur);

  const clear = () => {
    held.clear();
    perLane.fill(0);
  };

  return {
    isLaneHeld: (lane) => (perLane[lane] ?? 0) > 0,
    clear,
    dispose() {
      clear();
      surface.removeEventListener('pointerdown', onPointerDown);
      win.removeEventListener('pointerup', onPointerUp, capture);
      win.removeEventListener('pointercancel', onPointerCancel, capture);
      win.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('keyup', onKeyUp);
      win.removeEventListener('blur', onBlur);
    },
  };
}
