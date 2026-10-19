/**
 * The menus' building blocks: elements, buttons that may start audio, segmented
 * choices and the volume slider. Plain DOM, styled in style.css.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A touch `pointerup` is followed by a synthesized `click` within this many ms. */
const CLICK_AFTER_TOUCH_MS = 800;
/**
 * A touch that moved further than this between down and up was a scroll or a drag,
 * not a tap. WebKit cancels the pointer once it pans; this catches what it lets by.
 */
export const TAP_SLOP_PX = 10;

const isUnavailable = (node: HTMLElement) =>
  (node instanceof HTMLButtonElement && node.disabled) ||
  node.getAttribute('aria-disabled') === 'true';

/** Until when (event time) the touch that ran a command may still send its click. */
let swallowBefore = -Infinity;
let guardInstalled = false;

/**
 * After a touch runs a command, its compatibility mouse events and click are dropped
 * wherever they land: the command may have swapped the screen, and the click goes to
 * whatever is now under the finger (Quit's would pick a song). One click at most;
 * the next pointer or key press ends it, so a real tap right after still works.
 */
function swallowClickAfter(touchedAt: number) {
  swallowBefore = touchedAt + CLICK_AFTER_TOUCH_MS;
  if (guardInstalled) return;
  guardInstalled = true;
  const capture = { capture: true };
  const disarm = () => {
    swallowBefore = -Infinity;
  };
  document.addEventListener('pointerdown', disarm, capture);
  document.addEventListener('keydown', disarm, capture);
  for (const type of ['mousedown', 'mouseup', 'click']) {
    document.addEventListener(
      type,
      (event) => {
        if (event.timeStamp >= swallowBefore) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (type === 'click') disarm();
      },
      capture,
    );
  }
}

/**
 * Runs `onTap` for a command that may need to start audio. `pointerup` is the touch
 * gesture WebKit honours; `click` covers mouse and keyboard. The `click` a touch
 * synthesizes afterwards is swallowed, so a command such as Restart runs once, and
 * never reaches the screen the command opened (see `swallowClickAfter`). A touch
 * that moved (a scroll that ended on the button) does nothing.
 */
export function onGesture(node: HTMLElement, onTap: () => void): void {
  let touchedAt = -Infinity;
  let down: { id: number; x: number; y: number } | undefined;
  node.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse') {
      down = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }
  });
  node.addEventListener('pointercancel', () => {
    down = undefined;
  });
  node.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse') return;
    touchedAt = event.timeStamp;
    const start = down;
    down = undefined;
    if (start?.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) return;
    if (isUnavailable(node)) return;
    swallowClickAfter(event.timeStamp);
    onTap();
  });
  node.addEventListener('click', (event) => {
    if (event.timeStamp - touchedAt < CLICK_AFTER_TOUCH_MS) return;
    if (!isUnavailable(node)) onTap();
  });
}

export type ButtonVariant = 'primary' | 'quiet';

/** A HUD button whose action may start audio (see `onGesture`). */
export function gestureButton(label: string, variant: ButtonVariant, onTap: () => void) {
  const node = el('button', `hud-button hud-button--${variant}`, label);
  node.type = 'button';
  onGesture(node, onTap);
  return node;
}

/** A plain HUD button for navigation. */
export function button(label: string, variant: ButtonVariant, onTap: () => void) {
  const node = el('button', `hud-button hud-button--${variant}`, label);
  node.type = 'button';
  node.addEventListener('click', onTap);
  return node;
}

/** A round button with an icon; `label` names it for assistive tech and the tooltip. */
export function iconButton(icon: SVGSVGElement, label: string, onTap: () => void, text?: string) {
  const node = el('button', text === undefined ? 'icon-button' : 'icon-button icon-button--text');
  node.type = 'button';
  node.append(icon);
  if (text === undefined) {
    node.setAttribute('aria-label', label);
    node.title = label;
  } else {
    node.append(el('span', 'icon-button-text', text));
  }
  node.addEventListener('click', onTap);
  return node;
}

let ids = 0;
/** A unique id for `aria-labelledby` and friends. */
export function uid(prefix: string): string {
  ids += 1;
  return `${prefix}-${ids}`;
}

export interface ChoiceOption<T> {
  value: T;
  label: string;
  /** Extra content inside the option's face, after the label. */
  decorate?: (face: HTMLElement) => void;
}

export interface Choice<T> {
  readonly node: HTMLFieldSetElement;
  readonly value: T;
  set(value: T): void;
  focus(): void;
}

/**
 * A segmented choice: native radio buttons, so arrow keys, focus and the radio
 * semantics come from the browser. `legend` is shown unless `hideLegend`.
 */
export function choice<T extends string | number>({
  legend,
  hideLegend = false,
  options,
  value,
  onChange,
  className = '',
}: {
  legend: string;
  hideLegend?: boolean;
  options: readonly ChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}): Choice<T> {
  const name = uid('choice');
  const node = el('fieldset', `choice ${className}`.trim());
  const caption = el('legend', hideLegend ? 'visually-hidden' : 'choice-legend', legend);
  const track = el('div', 'choice-track');
  let current = value;
  const inputs = options.map((option) => {
    const label = el('label', 'choice-option');
    const input = el('input', 'choice-input');
    input.type = 'radio';
    input.name = name;
    input.value = String(option.value);
    input.checked = option.value === value;
    const face = el('span', 'choice-face');
    face.append(el('span', 'choice-label', option.label));
    option.decorate?.(face);
    input.addEventListener('change', () => {
      if (!input.checked) return;
      current = option.value;
      onChange(option.value);
    });
    label.append(input, face);
    track.append(label);
    return { input, option };
  });
  node.append(caption, track);
  return {
    node,
    get value() {
      return current;
    },
    set(next) {
      current = next;
      for (const { input, option } of inputs) input.checked = option.value === next;
    },
    focus() {
      const checked = inputs.find(({ input }) => input.checked) ?? inputs[0];
      checked?.input.focus({ preventScroll: true });
    },
  };
}

export interface Slider {
  readonly node: HTMLElement;
  set(value: number): void;
}

const SLIDER_STEP = 0.05;
const SLIDER_PAGE = 0.1;
const roundPercent = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;

/**
 * A 0–1 slider built on pointer events (`role="slider"`), not `<input type=range>`:
 * on iOS a focused range thumb can stop responding to drags (WebKit bug 266283).
 * `touch-action: pan-y` hands horizontal drags to it and leaves vertical ones to
 * the page. `onInput` runs as it moves; `onCommit` when a drag or key press ends.
 */
export function slider({
  label,
  value,
  onInput,
  onCommit,
}: {
  label: string;
  value: number;
  onInput: (value: number) => void;
  onCommit: (value: number) => void;
}): Slider {
  const field = el('div', 'slider-field');
  const labelId = uid('slider');
  const caption = el('span', 'slider-label', label);
  caption.id = labelId;
  const shown = el('span', 'slider-value');
  shown.setAttribute('aria-hidden', 'true');
  const control = el('div', 'slider');
  control.setAttribute('role', 'slider');
  control.tabIndex = 0;
  control.setAttribute('aria-labelledby', labelId);
  control.setAttribute('aria-valuemin', '0');
  control.setAttribute('aria-valuemax', '100');
  const track = el('span', 'slider-track');
  const fill = el('span', 'slider-fill');
  const thumb = el('span', 'slider-thumb');
  track.append(fill);
  control.append(track, thumb);
  field.append(caption, shown, control);

  let current = roundPercent(value);
  const render = () => {
    const percent = Math.round(current * 100);
    control.style.setProperty('--value', String(current));
    control.setAttribute('aria-valuenow', String(percent));
    control.setAttribute('aria-valuetext', `${percent}%`);
    shown.textContent = `${percent}%`;
  };
  const update = (next: number) => {
    const rounded = roundPercent(next);
    if (rounded === current) return;
    current = rounded;
    render();
    onInput(current);
  };
  const fromPointer = (event: PointerEvent) => {
    const rect = track.getBoundingClientRect();
    if (rect.width > 0) update((event.clientX - rect.left) / rect.width);
  };

  let dragging: number | undefined;
  control.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    dragging = event.pointerId;
    control.setPointerCapture(event.pointerId);
    fromPointer(event);
  });
  control.addEventListener('pointermove', (event) => {
    if (event.pointerId === dragging) fromPointer(event);
  });
  const endDrag = (event: PointerEvent) => {
    if (event.pointerId !== dragging) return;
    dragging = undefined;
    onCommit(current);
  };
  control.addEventListener('pointerup', endDrag);
  control.addEventListener('pointercancel', endDrag);
  control.addEventListener('keydown', (event) => {
    const steps: Record<string, number> = {
      ArrowLeft: -SLIDER_STEP,
      ArrowDown: -SLIDER_STEP,
      ArrowRight: SLIDER_STEP,
      ArrowUp: SLIDER_STEP,
      PageDown: -SLIDER_PAGE,
      PageUp: SLIDER_PAGE,
    };
    let next: number | undefined;
    if (event.key in steps) next = current + (steps[event.key] ?? 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 1;
    if (next === undefined) return;
    event.preventDefault();
    update(next);
    onCommit(current);
  });

  render();
  return {
    node: field,
    set(next) {
      current = roundPercent(next);
      render();
    },
  };
}

/** Hidden from sight, still read by assistive tech. */
export function visuallyHidden(tag: 'span' | 'p' | 'h2', text = '') {
  return el(tag, 'visually-hidden', text);
}
