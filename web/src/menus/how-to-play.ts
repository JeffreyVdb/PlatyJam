import type { GameMode } from '../game/session-contract';
import { el, gestureButton } from './controls';
import { GAMES, gameBadge, gamePreview } from './games';
import { sheet } from './run-screens';
import type { Screen } from './screens';

/**
 * How to play: a game's preview and its three steps, then Got it. Shown before the
 * first run of Tiles, and from the How to play button on song select.
 */
export interface HowToPlay extends Screen {
  readonly isOpen: boolean;
  open(mode: GameMode): void;
  close(): void;
}

export interface HowToPlayOptions {
  /** Got it. Runs inside the tap's gesture, so it may start the song. */
  onGotIt: (mode: GameMode) => void;
}

export function createHowToPlay({ onGotIt }: HowToPlayOptions): HowToPlay {
  const { node, card, title } = sheet('game-sheet--intro');
  card.classList.add('game-card--intro');
  title.textContent = 'How to play';
  const game = el('p', 'game-card-mode');
  const stage = el('div', 'intro-preview');
  const steps = el('ol', 'intro-steps');
  const body = el('div', 'intro-body');
  body.append(stage, steps);
  const previews = new Map<GameMode, HTMLElement>();
  let mode: GameMode = 'rhythm';
  let open = false;
  const gotIt = gestureButton('Got it', 'primary', () => {
    onGotIt(mode);
  });
  const actions = el('div', 'game-card-actions');
  actions.append(gotIt);
  card.append(game, body, actions);

  return {
    node,
    focusTarget: () => gotIt,
    get isOpen() {
      return open;
    },
    open(next) {
      mode = next;
      open = true;
      node.dataset.mode = next;
      game.replaceChildren(gameBadge(next));
      let preview = previews.get(next);
      if (!preview) {
        preview = gamePreview(next);
        previews.set(next, preview);
      }
      stage.replaceChildren(preview);
      steps.replaceChildren(...GAMES[next].steps.map((step) => el('li', 'intro-step', step)));
    },
    close() {
      open = false;
    },
  };
}
