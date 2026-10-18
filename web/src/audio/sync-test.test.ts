import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../app/events';
import { createSongClock } from './clock';
import type { AudioEngineEvents } from './engine';
import type { GameAudio } from './game-audio';
import { createSyncTest, syncTestNotes } from './sync-test';
import { createTimeline, ZERO_OFFSETS } from './timeline';

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

describe('createSyncTest', () => {
  it('stops when the engine is silenced, so the panel shows it stopped', () => {
    const context = { currentTime: 1 };
    const events = createEventBus<AudioEngineEvents>();
    const clock = createSongClock(() => context.currentTime);
    const timeline = createTimeline({
      clock,
      contextTimeAt: () => context.currentTime,
      nowMs: () => 0,
      offsets: () => ZERO_OFFSETS,
    });
    const accompaniment = {
      play: vi.fn(),
      stopAll: vi.fn(),
      stats: () => ({ active: true, scheduled: 0, skipped: 0, lastLeadMs: 0 }),
    };
    const audio = {
      engine: { context, events, clock, timeline, offsets: ZERO_OFFSETS },
      accompaniment,
    } as unknown as GameAudio;
    const sync = createSyncTest(audio, () => 0);
    sync.start({ tempo: 1, source: 'piano' });
    expect(sync.readout().running).toBe(true);

    events.emit('silenced', { fadeMs: 40 });
    expect(sync.readout().running).toBe(false);
    expect(accompaniment.stopAll).toHaveBeenLastCalledWith(40);
    expect(clock.isRunning).toBe(false);
  });
});
