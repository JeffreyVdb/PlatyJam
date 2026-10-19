import { approximateMs, type OutputVerdict } from '../audio/latency-warning';
import { button, el, gestureButton } from './controls';
import { sheet } from './run-screens';
import type { Screen } from './screens';

/**
 * "Your sound is delayed": shown before a song when the output (wireless headphones)
 * adds a noticeable delay. The player can switch to the speaker (the dialog waits for
 * it and carries on by itself), play anyway, or stop being asked.
 */

export type SwitchPlatform = 'ios' | 'android' | 'other';

/** Where the player can switch the output to the speaker; the browser cannot do it. */
const SWITCH_STEPS: Record<SwitchPlatform, readonly string[]> = {
  ios: [
    'Open Control Center: swipe down from the top right corner.',
    'Tap the AirPlay button in the sound panel (the circles with a triangle).',
    'Choose iPad or iPhone instead of your headphones. Turning Bluetooth off works too.',
  ],
  android: [
    'Swipe down twice to open quick settings.',
    'Open the media player and tap its output button, or the name of your headphones.',
    'Choose Phone speaker or Tablet speaker. Disconnecting your headphones works too.',
  ],
  other: [
    'Switch your sound output to the speakers in your system sound settings.',
    'Or disconnect your headphones.',
  ],
};

/** Which instructions to show. iPadOS Safari reports a Mac, so touch points tell them apart. */
export function detectSwitchPlatform(
  nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & { platform?: string },
): SwitchPlatform {
  const { userAgent, platform, maxTouchPoints } = nav;
  if (['iPad', 'iPhone', 'iPod'].some((name) => userAgent.includes(name))) return 'ios';
  if (platform === 'MacIntel' && maxTouchPoints > 1) return 'ios';
  if (userAgent.includes('Android')) return 'android';
  return 'other';
}

type View = 'choose' | 'switch';

export interface LatencyWatchView {
  verdict(): OutputVerdict;
  latencyMs(): number | undefined;
  subscribe(listener: () => void): () => void;
}

export interface LatencyDialogOptions {
  watch: LatencyWatchView;
  platform: SwitchPlatform;
  /** Play anyway. Runs inside the tap's gesture: start the song there. */
  onPlayAnyway: () => void;
  /** Play, and don't ask again for about this latency (ms). Inside the gesture too. */
  onPlayAndMute: (latencyMs: number) => void;
  /** The output is on time again after "Use speakers". Not a gesture. */
  onSwitched: () => void;
  /** Opens the calibration; `onClose` must run when it closes. */
  onCalibrate: (onClose: () => void) => void;
  /** Escape, or backing out: the player stays on the song list. */
  onCancel: () => void;
}

export interface LatencyDialog extends Screen {
  readonly isOpen: boolean;
  /** `latencyMs` is the measured delay the text names. */
  open(latencyMs: number): void;
  close(): void;
  /** Escape: back from the speaker steps, or out of the dialog. */
  escape(): void;
}

const delayedText = (ms: number) =>
  `Wireless headphones add about ${approximateMs(ms)} ms, so your notes will sound late. For the best experience, play through the device speaker.`;

export function createLatencyDialog(options: LatencyDialogOptions): LatencyDialog {
  const { watch, platform } = options;
  const { node, card, title } = sheet('game-sheet--latency');
  title.tabIndex = -1;

  let open = false;
  let view: View = 'choose';
  let measuredMs = 0;
  let unsubscribe: (() => void) | undefined;

  // ---- Choose ----
  const text = el('p', 'game-card-text');
  const useSpeakers = button('Use speakers', 'primary', () => {
    show('switch');
  });
  const playAnyway = gestureButton('Play anyway', 'quiet', () => {
    options.onPlayAnyway();
  });
  const playAndMute = gestureButton("Play, don't ask again", 'quiet', () => {
    options.onPlayAndMute(watch.latencyMs() ?? measuredMs);
  });
  const chooseActions = el('div', 'game-card-actions game-card-actions--stack');
  chooseActions.append(useSpeakers, playAnyway, playAndMute);

  const calibrateHint = el(
    'p',
    'game-card-hint',
    'Playing anyway? Calibrating lines the accompaniment up with what you hear.',
  );
  const calibrate = button('Calibrate timing', 'quiet', () => {
    node.inert = true;
    options.onCalibrate(() => {
      node.inert = false;
      calibrate.focus({ preventScroll: true });
    });
  });
  const calibrateActions = el('div', 'game-card-actions game-card-actions--stack');
  calibrateActions.append(calibrate);
  const chooseParts = [text, chooseActions, calibrateHint, calibrateActions];

  // ---- Switch ----
  const intro = el(
    'p',
    'game-card-text',
    'Switch your sound to the device speaker. The song starts by itself once the sound is on time.',
  );
  const steps = el('ol', 'latency-steps');
  for (const step of SWITCH_STEPS[platform]) steps.append(el('li', 'latency-step', step));
  const status = el('p', 'game-card-alert latency-status');
  status.setAttribute('role', 'status');
  const back = button('Back', 'quiet', () => {
    show('choose');
  });
  const switchActions = el('div', 'game-card-actions game-card-actions--stack');
  switchActions.append(back);
  const switchParts = [intro, steps, status, switchActions];

  const paintStatus = () => {
    const ms = watch.latencyMs();
    const verdict = watch.verdict();
    const next =
      verdict === 'onTime'
        ? 'The sound is on time.'
        : ms === undefined
          ? 'Checking the sound…'
          : `Still about ${approximateMs(ms)} ms late.`;
    // Only on a change, so a screen reader is not read the same line ten times a second.
    if (status.textContent !== next) status.textContent = next;
  };

  const onWatch = () => {
    if (!open || view !== 'switch') return;
    paintStatus();
    if (watch.verdict() === 'onTime') options.onSwitched();
  };

  function show(next: View) {
    view = next;
    card.replaceChildren(title, ...(next === 'choose' ? chooseParts : switchParts));
    if (next === 'choose') {
      title.textContent = 'Your sound is delayed';
      text.textContent = delayedText(watch.latencyMs() ?? measuredMs);
      if (open && card.isConnected) useSpeakers.focus({ preventScroll: true });
    } else {
      title.textContent = 'Switch to the speaker';
      status.textContent = '';
      paintStatus();
      // The heading names the new step for a screen reader; Back is one Tab away.
      if (open) title.focus({ preventScroll: true });
    }
  }

  return {
    node,
    focusTarget: () => (view === 'choose' ? useSpeakers : title),
    get isOpen() {
      return open;
    },
    open(latencyMs) {
      open = true;
      measuredMs = latencyMs;
      unsubscribe?.();
      unsubscribe = watch.subscribe(onWatch);
      show('choose');
    },
    close() {
      open = false;
      node.inert = false;
      unsubscribe?.();
      unsubscribe = undefined;
    },
    escape() {
      if (view === 'switch') show('choose');
      else options.onCancel();
    },
  };
}
