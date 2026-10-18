import type { GameAudio } from '../audio/game-audio';
import { createSyncTest, type SyncSource } from '../audio/sync-test';

/**
 * The ?debug Audio section: readouts for checking the engine on an iPad, a tap pad
 * for measuring tap-to-sound latency, the 3-minute sync test, and buttons for the
 * calibration and the interruption paths.
 */
export interface AudioDebugOptions {
  audio: GameAudio;
  openCalibration: () => void;
}

const TEMPOS = [0.75, 1, 1.25, 1.5] as const;
/** C5: a bright attack, easy to spot in a recording. */
const PAD_PITCH = 72;
const BEAT_FLASH_MS = 90;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onTap: () => void) {
  const node = el('button', 'hud-button hud-button--quiet', label);
  node.type = 'button';
  node.addEventListener('click', onTap);
  return node;
}

/** A row of mutually exclusive choices, shown as pressed toggle buttons. */
function choice<T extends string | number>(
  label: string,
  options: readonly { value: T; text: string }[],
  initial: T,
  onChange: (value: T) => void,
) {
  const group = el('div', 'debug-choice');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  const buttons = options.map(({ value, text }) => {
    const node = button(text, () => {
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === node));
      onChange(value);
    });
    node.setAttribute('aria-pressed', String(value === initial));
    return node;
  });
  group.append(...buttons);
  return group;
}

const ms = (seconds: number | undefined) =>
  seconds === undefined ? 'n/a' : `${(seconds * 1000).toFixed(1)} ms`;

const clockText = (songMs: number) => {
  const total = Math.max(0, Math.floor(songMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function createAudioDebugSection({
  audio,
  openCalibration,
}: AudioDebugOptions): HTMLElement {
  const { engine, piano, accompaniment, samples } = audio;
  const sync = createSyncTest(audio);

  const section = el('details', 'debug-section');
  section.open = true;
  section.append(el('summary', 'debug-heading', 'Audio'));

  const status = el('p', 'debug-status debug-status--lines');
  status.setAttribute('aria-live', 'off');

  const actions = el('div', 'debug-actions');
  actions.append(
    button('Calibrate', openCalibration),
    button('Stop all', () => {
      sync.stop();
      accompaniment.stopAll(200);
      piano.stopAll(200);
    }),
    button('Simulate pause', () => {
      engine.simulateInterruption();
    }),
    button('Simulate stuck pause', () => {
      engine.simulateInterruption({ stuck: true });
    }),
  );

  // Tap pad: the sound starts in the pointerdown handler, with nothing in between.
  const pad = el('button', 'tap-pad');
  pad.type = 'button';
  pad.append(
    el('span', 'tap-pad-label', 'Tap pad'),
    el('span', 'tap-pad-hint', 'Plays C5 on touch'),
  );
  const padReadout = el('span', 'tap-pad-hint');
  pad.append(padReadout);
  const held = new Map<number, ReturnType<typeof piano.noteOn>>();
  pad.addEventListener('pointerdown', (event) => {
    held.set(event.pointerId, piano.noteOn(PAD_PITCH, 100));
    const handlerDelay = performance.now() - event.timeStamp;
    padReadout.textContent = `Handled ${handlerDelay.toFixed(1)} ms after the touch event`;
    pad.setPointerCapture(event.pointerId);
  });
  const release = (event: PointerEvent) => {
    const voice = held.get(event.pointerId);
    held.delete(event.pointerId);
    if (voice) piano.noteOff(voice);
  };
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);

  // Sync test.
  let tempo = 1;
  let source: SyncSource = 'piano';
  const syncBox = el('div', 'sync-test');
  const syncTop = el('div', 'sync-test-top');
  const beat = el('span', 'sync-beat');
  beat.setAttribute('aria-hidden', 'true');
  const syncTitle = el('span', 'sync-title', 'Sync test, 120 BPM');
  const syncToggle = button('Start sync test', () => {
    if (sync.readout().running) sync.stop();
    else sync.start({ tempo, source });
  });
  syncTop.append(beat, syncTitle, syncToggle);
  const syncReadout = el('p', 'debug-status debug-status--lines');
  syncBox.append(
    syncTop,
    choice(
      'Tempo',
      TEMPOS.map((value) => ({ value, text: `${value}×` })),
      tempo,
      (value) => {
        tempo = value;
      },
    ),
    choice(
      'Sound source',
      [
        { value: 'piano' as const, text: 'Piano, 3 min' },
        { value: 'backing' as const, text: 'Backing file, 1 min' },
      ],
      source,
      (value) => {
        source = value;
      },
    ),
    syncReadout,
  );

  section.append(status, actions, pad, syncBox);

  // Drawn every frame from songTime(), never from frame counts.
  const paintSync = () => {
    const r = sync.readout();
    syncToggle.textContent = r.running ? 'Stop sync test' : 'Start sync test';
    const index = Math.floor(r.songMs / r.beatMs);
    const lit = r.running && r.songMs >= 0 && r.songMs - index * r.beatMs < BEAT_FLASH_MS;
    beat.dataset.lit = lit ? (index % 4 === 0 ? 'down' : 'beat') : 'off';
    if (r.running) {
      syncReadout.textContent = [
        `${clockText(r.songMs)} of ${clockText(r.durationMs)} at ${r.tempo}×, ${r.source}`,
        `Output lag ${r.outputLagMs.toFixed(1)} ms, clock drift ${r.clockDriftMs.toFixed(1)} ms`,
        `Notes scheduled ${r.scheduled}, skipped late ${r.skipped}, lead ${r.lastLeadMs.toFixed(0)} ms`,
      ].join('\n');
    }
    requestAnimationFrame(paintSync);
  };
  requestAnimationFrame(paintSync);

  const refresh = () => {
    const s = engine.debugState();
    const unlocks = Object.entries(s.unlockAttempts)
      .map(([type, count]) => `${type} ${count}`)
      .join(', ');
    const { audioOffsetMs, inputOffsetMs } = engine.offsets;
    status.textContent = [
      `Engine ${s.phase}, context ${s.contextState}, ${s.sampleRate} Hz`,
      `Base latency ${ms(s.baseLatency)}, output latency ${ms(s.outputLatency)}`,
      `Audio session: ${s.audioSession}`,
      `Unlock attempts: ${unlocks || 'none'}${s.unlockedBy ? `; unlocked by ${s.unlockedBy}` : ''}`,
      `Piano samples ${samples.progress.loaded} of ${samples.progress.total}${samples.progress.failed ? `, ${samples.progress.failed} failed` : ''}`,
      `Voices ${piano.activeVoices()}, context recreated ${s.recreations}×${s.needsRecreate ? ' (next tap recreates)' : ''}`,
      `Calibration: sound ${audioOffsetMs} ms, touch ${inputOffsetMs} ms`,
    ].join('\n');
  };
  refresh();
  setInterval(refresh, 250);

  return section;
}
