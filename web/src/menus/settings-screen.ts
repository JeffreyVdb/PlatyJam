import { approximateMs } from '../audio/latency-warning';
import type { LatencyOffsets } from '../audio/timeline';
import type { FailMode, GameMode } from '../game/session-contract';
import type { Settings } from '../save/save-data';
import { button, choice, el, slider, uid } from './controls';
import { nearestScrollSpeed, SCROLL_SPEEDS } from './flow';
import { GAMES, gamePreview } from './games';
import { type Screen, screenFrame } from './screens';

export type VolumeKind = 'masterVolume' | 'accompanimentVolume' | 'effectsVolume';

export interface SettingsScreenOptions {
  settings: () => Readonly<Settings>;
  /** The games to offer. */
  modes: readonly GameMode[];
  /** The game being played (the saved one, if it is offered). */
  mode: () => GameMode;
  /** The latency offsets in use, for the Timing line. */
  offsets: () => Readonly<LatencyOffsets>;
  /** The audio output latency in ms, `undefined` when unknown. */
  outputLatency: () => number | undefined;
  /** The game, fail mode or scroll speed (for the next run), or the delayed-sound warning. */
  onChange: (
    patch: Partial<
      Pick<Settings, 'gameMode' | 'failMode' | 'scrollDurationMs' | 'latencyWarningMutedAtMs'>
    >,
  ) => void;
  /** While a volume slider moves: apply it to the sound at once. */
  onVolume: (kind: VolumeKind, volume: number) => void;
  /** A volume slider was let go: save it. */
  onVolumeCommit: (kind: VolumeKind, volume: number) => void;
  onCalibrate: () => void;
  onBack: () => void;
}

export interface SettingsScreen extends Screen {
  refresh(): void;
  /** Only the audio output latency line: it moves while the screen is open. */
  refreshOutputLatency(): void;
  readonly calibrateButton: HTMLElement;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms % 100 === 0 ? 1 : 2)} s`;

const signedMs = (ms: number) => `${ms > 0 ? '+' : ''}${ms} ms`;

function group(title: string, ...children: HTMLElement[]): HTMLElement {
  const section = el('section', 'settings-group');
  const heading = el('h2', 'screen-subtitle', title);
  heading.id = uid('settings');
  section.setAttribute('aria-labelledby', heading.id);
  section.append(heading, ...children);
  return section;
}

/** The game, fail mode, scroll speed, volumes and the latency calibration. */
export function createSettingsScreen(options: SettingsScreenOptions): SettingsScreen {
  const frame = screenFrame({
    name: 'settings',
    title: 'Settings',
    backLabel: 'Back to songs',
    onBack: options.onBack,
  });
  const initial = options.settings();

  const failHint = el('p', 'settings-hint');
  const showFailHint = () => {
    failHint.textContent = GAMES[options.mode()].failHints[options.settings().failMode];
  };
  const game = choice<GameMode>({
    legend: 'Game',
    hideLegend: true,
    className: 'choice--games',
    options: options.modes.map((value) => ({
      value,
      label: GAMES[value].name,
      decorate: (face) => {
        face.dataset.mode = value;
        face.prepend(gamePreview(value));
        face.querySelector('.choice-label')?.prepend(GAMES[value].icon());
        face.append(el('span', 'choice-text', GAMES[value].line));
      },
    })),
    value: options.mode(),
    onChange: (value) => {
      options.onChange({ gameMode: value });
      showFailHint();
    },
  });

  const failMode = choice<FailMode>({
    legend: 'When you miss',
    options: [
      { value: 'classic', label: 'Classic' },
      { value: 'relaxed', label: 'Relaxed' },
    ],
    value: initial.failMode,
    onChange: (value) => {
      options.onChange({ failMode: value });
      showFailHint();
    },
  });

  const scrollHint = el('p', 'settings-hint');
  const scroll = choice<number>({
    legend: 'Tile speed',
    options: SCROLL_SPEEDS.map(({ label, ms }) => ({ value: ms, label })),
    value: nearestScrollSpeed(initial.scrollDurationMs).ms,
    onChange: (value) => {
      scrollHint.textContent = `Tiles take ${seconds(value)} to reach the line.`;
      options.onChange({ scrollDurationMs: value });
    },
  });

  const volume = (kind: VolumeKind, label: string) =>
    slider({
      label,
      value: initial[kind],
      onInput: (value) => {
        options.onVolume(kind, value);
      },
      onCommit: (value) => {
        options.onVolumeCommit(kind, value);
      },
    });
  const master = volume('masterVolume', 'Volume');
  const accompaniment = volume('accompanimentVolume', 'Accompaniment');
  const accompanimentHint = el(
    'p',
    'settings-hint',
    'The notes PlatyJam plays along with you. Your own notes follow Volume.',
  );
  const effects = volume('effectsVolume', 'Effects');
  const effectsHint = el(
    'p',
    'settings-hint',
    'The taps, sparkles and misses in Tiles. Rhythm plays none.',
  );

  const outputLatency = el('p', 'settings-hint');
  const mutedHint = el('p', 'settings-hint');
  const unmute = button('Warn me again', 'quiet', () => {
    options.onChange({ latencyWarningMutedAtMs: null });
    refresh();
  });
  const muted = el('div', 'settings-muted');
  muted.append(mutedHint, unmute);

  const timing = el('p', 'settings-hint');
  const calibrateButton = button('Calibrate timing', 'quiet', options.onCalibrate);
  const timingText = el(
    'p',
    'settings-text',
    'If notes feel early or late, tap along to a short beat and PlatyJam measures the delay of your speakers and screen.',
  );

  const column = el('div', 'screen-column');
  column.append(
    group('Game', game.node),
    group('Playing', failMode.node, failHint, scroll.node, scrollHint),
    group(
      'Sound',
      master.node,
      accompaniment.node,
      accompanimentHint,
      effects.node,
      effectsHint,
      outputLatency,
      muted,
    ),
    group('Timing', timingText, timing, calibrateButton),
  );
  frame.body.append(column);

  const refreshOutputLatency = () => {
    const ms = options.outputLatency();
    const text = `Audio output latency: ${ms === undefined ? 'unknown' : `${Math.round(ms)} ms`}`;
    if (outputLatency.textContent !== text) outputLatency.textContent = text;
  };

  const refresh = () => {
    const settings = options.settings();
    refreshOutputLatency();
    const mutedAt = settings.latencyWarningMutedAtMs;
    muted.hidden = mutedAt === null;
    mutedHint.textContent =
      mutedAt === null
        ? ''
        : `PlatyJam won't warn you before a song when the sound is delayed by about ${approximateMs(mutedAt)} ms.`;
    game.set(options.mode());
    failMode.set(settings.failMode);
    showFailHint();
    const speed = nearestScrollSpeed(settings.scrollDurationMs);
    scroll.set(speed.ms);
    scrollHint.textContent = `Tiles take ${seconds(settings.scrollDurationMs)} to reach the line.`;
    master.set(settings.masterVolume);
    accompaniment.set(settings.accompanimentVolume);
    effects.set(settings.effectsVolume);
    const { audioOffsetMs, inputOffsetMs } = options.offsets();
    timing.textContent =
      audioOffsetMs === 0 && inputOffsetMs === 0
        ? 'Not calibrated yet.'
        : `Now: sound ${signedMs(audioOffsetMs)}, touch ${signedMs(inputOffsetMs)}.`;
  };
  refresh();

  return {
    node: frame.section,
    focusTarget: () => frame.heading,
    refresh,
    refreshOutputLatency,
    calibrateButton,
  };
}
