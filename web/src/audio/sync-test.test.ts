import { describe, expect, it } from 'vitest';
import { syncTestNotes } from './sync-test';

describe('syncTestNotes', () => {
  it('puts a metronome note on every beat of a 3-minute, 120 BPM song', () => {
    const notes = syncTestNotes();
    const metronome = notes.filter((n) => n.pitch === 84 || n.pitch === 79);
    expect(metronome).toHaveLength(360);
    expect(metronome.slice(0, 5).map((n) => n.t)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(metronome.at(-1)?.t).toBe(179_500);
  });

  it('starts a chord on each downbeat, cycling C, G, Am, F', () => {
    const roots = syncTestNotes()
      .filter((n) => n.pitch < 50)
      .slice(0, 5)
      .map((n) => [n.t, n.pitch]);
    expect(roots).toEqual([
      [0, 48],
      [2000, 43],
      [4000, 45],
      [6000, 41],
      [8000, 48],
    ]);
  });
});
