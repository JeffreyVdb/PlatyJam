import type { Credits } from '../credits/schema';
import type { GameMode } from '../game/session-contract';
import { backIcon, starIcon } from '../hud/icons';
import { el, iconButton, onGesture, uid, visuallyHidden } from './controls';
import { GAMES, gamePreview } from './games';

/** A screen the menus controller shows and hides as a whole. */
export interface Screen {
  readonly node: HTMLElement;
  /** Where focus goes when the screen opens. */
  focusTarget(): HTMLElement;
}

export interface Frame {
  section: HTMLElement;
  heading: HTMLHeadingElement;
  bar: HTMLElement;
  body: HTMLElement;
}

/**
 * The menu screens' shared frame: a full-screen sheet with a bar (Back, the
 * heading, optional actions) above a body. The heading takes focus on open.
 */
export function screenFrame({
  name,
  title,
  backLabel,
  onBack,
}: {
  name: string;
  title: string;
  backLabel: string;
  onBack: () => void;
}): Frame {
  const section = el('section', `screen screen--${name}`);
  const heading = el('h1', 'screen-title', title);
  heading.id = uid(name);
  heading.tabIndex = -1;
  section.setAttribute('aria-labelledby', heading.id);
  const bar = el('header', 'screen-bar');
  bar.append(iconButton(backIcon(), backLabel, onBack, 'Back'), heading);
  const body = el('div', 'screen-body');
  section.append(bar, body);
  return { section, heading, bar, body };
}

/** Three stars, `earned` of them lit; labelled for assistive tech. */
export function starRow(earned: number, className = 'star-row'): HTMLElement {
  const row = el('span', className);
  row.setAttribute('role', 'img');
  row.setAttribute('aria-label', `${earned} of 3 stars`);
  for (let i = 0; i < 3; i += 1) {
    const star = el('span', 'star-row-star');
    star.classList.toggle('is-earned', earned > i);
    star.append(starIcon());
    row.append(star);
  }
  return row;
}

// ---- Home ----

/**
 * The wordmark's letters ride a little melody: each sits at its own height (em).
 * Musical, and still one readable word.
 */
const WORDMARK = [
  ['P', -0.1],
  ['l', -0.02],
  ['a', -0.09],
  ['t', 0],
  ['y', 0.03],
  ['J', -0.11],
  ['a', -0.03],
  ['m', -0.13],
] as const;

export interface HomeScreenOptions {
  /** The games to offer, one card each. */
  modes: readonly GameMode[];
  /** The game last picked: its card takes focus. */
  current: () => GameMode;
  /** Called synchronously inside the tap (or key press) on a card. */
  onPick: (mode: GameMode) => void;
}

/**
 * Home: the title and a card per game, each with a looping preview. A tap on a card
 * picks that game and is the gesture that unlocks the audio, through the engine's
 * document listeners.
 */
export function createHomeScreen({ modes, current, onPick }: HomeScreenOptions): Screen {
  const section = el('section', 'screen screen--home');
  const heading = el('h1', 'home-title');
  heading.id = uid('home');
  section.setAttribute('aria-labelledby', heading.id);
  heading.append(visuallyHidden('span', 'PlatyJam'));
  const word = el('span', 'home-word');
  word.setAttribute('aria-hidden', 'true');
  WORDMARK.forEach(([letter, rise], index) => {
    const span = el('span', 'home-letter', letter);
    span.style.setProperty('--rise', `${rise}em`);
    span.style.setProperty('--i', String(index));
    word.append(span);
  });
  heading.append(word);
  section.append(heading);
  if (modes.length > 1) section.append(el('p', 'home-tagline', 'Two ways to play every song.'));

  const cards = el('div', 'mode-cards');
  cards.dataset.count = String(modes.length);
  const buttons = new Map<GameMode, HTMLButtonElement>();
  for (const mode of modes) {
    const game = GAMES[mode];
    const card = el('button', 'mode-card');
    card.type = 'button';
    card.dataset.mode = mode;
    card.setAttribute('aria-label', `Play ${game.name}`);
    const line = el('span', 'mode-card-line', game.line);
    line.id = uid('mode-line');
    card.setAttribute('aria-describedby', line.id);
    const name = el('span', 'mode-card-name');
    name.append(game.icon(), el('span', 'mode-card-title', game.name));
    const text = el('span', 'mode-card-text');
    text.append(name, line, el('span', 'mode-card-play', 'Play'));
    card.append(gamePreview(mode), text);
    // Each card is its own gesture target: one tap picks one game, once.
    onGesture(card, () => {
      onPick(mode);
    });
    buttons.set(mode, card);
    cards.append(card);
  }
  section.append(cards);
  return {
    node: section,
    focusTarget: () => buttons.get(current()) ?? buttons.values().next().value ?? heading,
  };
}

// ---- Credits ----

function externalLink(text: string, href: string): HTMLAnchorElement {
  const link = el('a', 'credit-link', text);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

/** Every work in the credits data (from the licence manifest): CC BY needs this. */
export function createCreditsScreen({
  credits,
  onBack,
}: {
  credits: Credits;
  onBack: () => void;
}): Screen {
  const frame = screenFrame({
    name: 'credits',
    title: 'Credits',
    backLabel: 'Back to songs',
    onBack,
  });
  const column = el('div', 'screen-column');
  column.append(
    el(
      'p',
      'screen-lede',
      'PlatyJam is free. It plays music, sounds and type that these people made and shared.',
    ),
  );
  for (const section of credits.sections) {
    const group = el('section', 'credit-section');
    const title = el('h2', 'screen-subtitle', section.title);
    title.id = uid('credits');
    group.setAttribute('aria-labelledby', title.id);
    const list = el('ul', 'credit-list');
    for (const item of section.items) {
      const entry = el('li', 'credit');
      entry.append(el('h3', 'credit-title', item.title), el('p', 'credit-byline', item.byline));
      const facts = el('dl', 'credit-facts');
      const row = (label: string, value: Node | string) => {
        const dd = el('dd', 'credit-value');
        dd.append(value);
        facts.append(el('dt', 'credit-label', label), dd);
      };
      row('Licence', externalLink(item.license.label, item.license.url));
      row('Source', externalLink(new URL(item.source).host.replace(/^www\./, ''), item.source));
      row('Changes', item.changes);
      if (item.note) row('Note', item.note);
      entry.append(facts);
      list.append(entry);
    }
    group.append(title, list);
    column.append(group);
  }
  frame.body.append(column);
  return { node: frame.section, focusTarget: () => frame.heading };
}
