// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { clusterNotes, selectClusters, type Cluster } from './clusters.ts';
import type { Strength } from './config.ts';
import { seededRandom } from './test-midi.ts';
import type { TimedNote } from './timing.ts';

const note = (t: number, pitch: number, dur = 100, vel = 80): TimedNote => ({
  t,
  dur,
  pitch,
  vel,
  tick: t,
});
const anyStrength = (): Strength => 'any';

describe('clusterNotes', () => {
  it('merges onsets within the window into one chord, highest pitch first', () => {
    const clusters = clusterNotes(
      [note(0, 60), note(20, 67), note(31, 64), note(100, 62)],
      30,
      anyStrength,
    );
    expect(clusters.map((c) => [c.t, c.notes.map((n) => n.pitch)])).toEqual([
      [0, [67, 60]],
      [31, [64]],
      [100, [62]],
    ]);
  });

  it('keeps the longer note when a pitch is struck twice in a chord', () => {
    const [cluster] = clusterNotes([note(0, 60, 100), note(10, 60, 400)], 30, anyStrength);
    expect(cluster?.notes).toEqual([note(10, 60, 400)]);
  });

  it('does not depend on input order', () => {
    const random = seededRandom(3);
    const notes = Array.from({ length: 200 }, () =>
      note(
        Math.floor(random() * 5000),
        48 + Math.floor(random() * 36),
        50 + Math.floor(random() * 500),
      ),
    );
    const shuffled = notes
      .map((n) => ({ n, key: random() }))
      .sort((a, b) => a.key - b.key)
      .map(({ n }) => n);
    expect(clusterNotes(shuffled, 30, anyStrength)).toEqual(clusterNotes(notes, 30, anyStrength));
  });

  it('labels each chord with the strength of its onset tick', () => {
    const [cluster] = clusterNotes([note(480, 60)], 30, (tick) => (tick === 480 ? 'beat' : 'any'));
    expect(cluster?.strength).toBe('beat');
  });
});

describe('selectClusters', () => {
  const cluster = (t: number, strength: Strength): Cluster => ({
    t,
    strength,
    notes: [note(t, 60)],
  });

  it('drops clusters weaker than the minimum strength', () => {
    const clusters = [cluster(0, 'downbeat'), cluster(250, 'half-beat'), cluster(500, 'strong')];
    expect(selectClusters(clusters, 'strong', 0)).toEqual([true, false, true]);
  });

  it('keeps the stronger of two onsets that are too close', () => {
    // A grace note 30 ms before a beat, then a run of sixteenths (125 ms apart).
    const clusters = [
      cluster(470, 'any'),
      cluster(500, 'beat'),
      cluster(625, 'quarter-beat'),
      cluster(750, 'half-beat'),
      cluster(875, 'quarter-beat'),
      cluster(1000, 'strong'),
    ];
    expect(selectClusters(clusters, 'any', 250)).toEqual([false, true, false, true, false, true]);
  });

  it('keeps the earlier of two equally strong onsets', () => {
    expect(selectClusters([cluster(0, 'any'), cluster(50, 'any')], 'any', 100)).toEqual([
      true,
      false,
    ]);
  });
});
