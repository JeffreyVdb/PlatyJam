import type { CatalogSong } from '../catalog/schema';
import { DIFFICULTIES, type DifficultyName } from '../chart/schema';
import { type Tempo, TEMPOS } from '../game/session-contract';
import { noteIcon, settingsIcon } from '../hud/icons';
import type { BestScore } from '../save/save-data';
import { choice, el, iconButton, onGesture, uid } from './controls';
import { formatDuration, formatTempo, type PlayButton, type Selection } from './flow';
import { type Screen, screenFrame, starRow } from './screens';

export const DIFFICULTY_NAMES: Record<DifficultyName, string> = {
  easy: 'Easy',
  normal: 'Normal',
  hard: 'Hard',
};

export interface SongSelectOptions {
  songs: readonly CatalogSong[];
  selection: () => Selection;
  best: (songId: string, difficulty: DifficultyName, tempo: Tempo) => BestScore | undefined;
  onSelect: (patch: Partial<Selection>) => void;
  /** Called synchronously inside the tap (or key press) on the Play tile. */
  onPlay: () => void;
  onBack: () => void;
  onSettings: () => void;
  onCredits: () => void;
}

export interface SongSelect extends Screen {
  /** Re-reads the selection and the best scores. */
  refresh(): void;
  setPlay(play: PlayButton): void;
  /** The Play tile: where focus goes back to when the delayed-sound dialog is cancelled. */
  readonly playButton: HTMLElement;
  readonly settingsButton: HTMLElement;
  readonly creditsButton: HTMLElement;
}

interface Row {
  song: CatalogSong;
  label: HTMLLabelElement;
  input: HTMLInputElement;
  best: HTMLElement;
}

/**
 * Song select: difficulty tabs over the list of songs (each with its best stars and
 * score for that difficulty and speed), and a panel with the picked song, the speed
 * and the Play tile. Picking is native radio buttons, so a scroll never picks.
 */
export function createSongSelect(options: SongSelectOptions): SongSelect {
  const { songs } = options;
  const frame = screenFrame({
    name: 'songs',
    title: 'Songs',
    backLabel: 'Back to the title',
    onBack: options.onBack,
  });
  const settingsButton = iconButton(settingsIcon(), 'Settings', options.onSettings, 'Settings');
  const creditsButton = iconButton(noteIcon(), 'Credits', options.onCredits, 'Credits');
  const actions = el('div', 'screen-actions');
  actions.append(settingsButton, creditsButton);
  frame.bar.append(actions);

  // ---- Difficulty tabs and the list ----
  const browse = el('div', 'songs-browse');
  const difficulty = choice<DifficultyName>({
    legend: 'Difficulty',
    hideLegend: true,
    className: 'choice--tabs',
    options: DIFFICULTIES.map((value, index) => ({
      value,
      label: DIFFICULTY_NAMES[value],
      decorate: (face) => {
        const pips = el('span', 'difficulty-pips');
        pips.setAttribute('aria-hidden', 'true');
        for (let i = 0; i <= index; i += 1) pips.append(el('span', 'difficulty-pip'));
        face.prepend(pips);
      },
    })),
    value: options.selection().difficulty,
    onChange: (value) => {
      options.onSelect({ difficulty: value });
    },
  });
  const caption = el('p', 'song-list-caption');
  caption.id = uid('songs-caption');
  const list = el('ul', 'song-list');
  list.setAttribute('aria-describedby', caption.id);
  const name = uid('song');
  const rows: Row[] = songs.map((song) => {
    const item = el('li', 'song-item');
    const label = el('label', 'song-row');
    const input = el('input', 'song-input');
    input.type = 'radio';
    input.name = name;
    input.value = song.id;
    input.addEventListener('change', () => {
      if (input.checked) options.onSelect({ songId: song.id });
    });
    const text = el('span', 'song-text');
    text.append(el('span', 'song-title', song.title), el('span', 'song-composer', song.composer));
    const best = el('span', 'song-best');
    label.append(input, text, best);
    item.append(label);
    list.append(item);
    return { song, label, input, best };
  });
  const scroller = el('div', 'song-scroller');
  scroller.append(list);
  browse.append(difficulty.node, caption, scroller);

  // ---- The picked song: speed and Play ----
  const panel = el('div', 'song-panel');
  const pickedTitle = el('h2', 'song-panel-title');
  const pickedFacts = el('p', 'song-panel-facts');
  const speed = choice<Tempo>({
    legend: 'Speed',
    className: 'choice--speed',
    options: TEMPOS.map((value) => ({ value, label: formatTempo(value) })),
    value: options.selection().tempo,
    onChange: (value) => {
      options.onSelect({ tempo: value });
    },
  });
  const play = el('button', 'play-tile');
  play.type = 'button';
  const playLabel = el('span', 'play-tile-label', 'Play');
  play.append(playLabel);
  onGesture(play, options.onPlay);
  const note = el('p', 'play-note');
  note.setAttribute('role', 'status');
  panel.append(pickedTitle, pickedFacts, speed.node, play, note);

  frame.body.append(browse, panel);

  const refresh = () => {
    const selection = options.selection();
    difficulty.set(selection.difficulty);
    speed.set(selection.tempo);
    const difficultyName = DIFFICULTY_NAMES[selection.difficulty];
    caption.textContent = `Best scores on ${difficultyName} at ${formatTempo(selection.tempo)}`;
    for (const row of rows) {
      const picked = row.song.id === selection.songId;
      row.input.checked = picked;
      row.label.classList.toggle('is-picked', picked);
      const best = options.best(row.song.id, selection.difficulty, selection.tempo);
      if (best) {
        const score = el('span', 'song-best-score', best.score.toLocaleString('en'));
        row.best.replaceChildren(starRow(best.stars, 'star-row star-row--small'), score);
      } else {
        row.best.replaceChildren(el('span', 'song-best-none', 'Not played'));
      }
    }
    const song = songs.find((s) => s.id === selection.songId);
    pickedTitle.textContent = song?.title ?? '';
    const tiles = song?.difficulties[selection.difficulty].tiles ?? 0;
    pickedFacts.textContent = song
      ? `${song.composer}. ${formatDuration(song.durationMs)} long, ${tiles} notes on ${difficultyName}.`
      : '';
  };

  refresh();

  return {
    node: frame.section,
    focusTarget: () => rows.find((row) => row.input.checked)?.input ?? frame.heading,
    refresh,
    setPlay({ action, label, note: text }) {
      play.dataset.action = action;
      play.setAttribute('aria-disabled', String(action === 'wait'));
      if (playLabel.textContent !== label) playLabel.textContent = label;
      if (note.textContent !== text) note.textContent = text;
    },
    playButton: play,
    settingsButton,
    creditsButton,
  };
}
