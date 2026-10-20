import type { Effect } from '../audio/sfx';
import type { GameMode, JudgmentEvent } from './session-contract';

/**
 * Which games play sound effects. Rhythm has none: its tap is the note, played at
 * the hit, and it sounds exactly as it did before effects existed (PLA-15; whether
 * it should get the miss and combo sounds too is open). Flip it here.
 */
export const GAME_EFFECTS: Readonly<Record<GameMode, boolean>> = { rhythm: false, tiles: true };

/** Every this many in a row plays the `combo` flourish. */
export const COMBO_MILESTONE = 50;

/** What a judgment sounds like: one-shots to play now, and what happens to a fill. */
export interface EffectCues {
  readonly oneShots: readonly Effect[];
  /** `start`: the long tile was claimed and fills. `stop`: it completed or was lost. */
  readonly fill?: 'start' | 'stop';
}

const NONE: EffectCues = { oneShots: [] };

/**
 * The effects for one judgment, in `mode`.
 *
 * - A tap tile is claimed and cleared by the same press (`tap` judged `clear`): the
 *   **tap** knock at once, with the **clear** sparkle on it, quieter. Its note waits
 *   for the beat; the knock says the tap counted.
 * - A long tile's claim (`head` cleared) knocks the same **tap** and starts its
 *   **fill**; completing it (`tail` cleared) plays **complete**, the bigger sparkle,
 *   and ends the fill.
 * - Any Miss, a tile that fell off, an early release or a tap on the water, is the
 *   **miss** thud (and ends a fill). A "not yet" shake is not a judgment: no sound.
 * - Each `COMBO_MILESTONE`th unit in a row adds the **combo** flourish.
 *
 * Pure: the session plays what it returns (`session.ts`).
 */
export function effectCues(
  event: Readonly<Pick<JudgmentEvent, 'unit' | 'judgment' | 'combo'>>,
  mode: GameMode,
): EffectCues {
  if (!GAME_EFFECTS[mode]) return NONE;
  const { unit, judgment, combo } = event;
  if (judgment === 'miss')
    return unit === 'tail' ? { oneShots: ['miss'], fill: 'stop' } : { oneShots: ['miss'] };
  const milestone: Effect[] = combo > 0 && combo % COMBO_MILESTONE === 0 ? ['combo'] : [];
  switch (unit) {
    case 'tap':
      return { oneShots: ['tap', 'clear', ...milestone] };
    case 'head':
      return { oneShots: ['tap', ...milestone], fill: 'start' };
    case 'tail':
      return { oneShots: ['complete', ...milestone], fill: 'stop' };
    case 'empty':
      return NONE;
  }
}
