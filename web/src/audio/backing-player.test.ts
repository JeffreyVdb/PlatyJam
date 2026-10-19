import { describe, expect, it, type Mock, vi } from 'vitest';
import { createBackingPlayer } from './backing-player';
import type { BackingTrack } from './backing-track';

const bufferOf = (name: string) => ({ name, duration: 60 }) as unknown as AudioBuffer;

function setup(buffers: Record<string, AudioBuffer | null> = {}) {
  const gates = new Map<string, (buffer: AudioBuffer | null) => void>();
  const loadBuffer = vi.fn(
    (src: string) =>
      new Promise<AudioBuffer | null>((resolve) => {
        gates.set(src, resolve);
        if (src in buffers) resolve(buffers[src] ?? null);
      }),
  );
  interface FakeTrack {
    play: Mock<() => void>;
    stop: Mock<(fadeMs: number) => void>;
    reset: Mock<() => void>;
    playing: boolean;
  }
  const tracks: { buffer: AudioBuffer; trackStartMs: number; track: FakeTrack }[] = [];
  const createTrack = vi.fn((buffer: AudioBuffer, trackStartMs: number): BackingTrack => {
    const track: FakeTrack = { play: vi.fn(), stop: vi.fn(), reset: vi.fn(), playing: false };
    tracks.push({ buffer, trackStartMs, track });
    return track;
  });
  const player = createBackingPlayer({ loadBuffer, createTrack });
  return { player, loadBuffer, createTrack, tracks, gates };
}

const a = { src: 'songs/a.m4a', offsetMs: 250 };
const b = { src: 'songs/b.m4a', offsetMs: 0 };

describe('createBackingPlayer', () => {
  it('has no recording until one is loaded', () => {
    const { player } = setup();
    expect(player.state).toBe('none');
    expect(player.loaded).toBe(false);
    player.play();
    player.resume();
    player.stopAll(10);
  });

  it('is loading until the file settles, then plays it from the chart offset', async () => {
    const { player, tracks, gates } = setup();
    const done = player.load(a);
    expect(player.state).toBe('loading');
    expect(player.loaded).toBe(false);
    gates.get(a.src)?.(bufferOf('a'));
    await done;
    expect(player.state).toBe('loaded');
    expect(player.loaded).toBe(true);
    // The file is 250 ms in at t = 0, so it started 250 ms before.
    expect(tracks[0]?.trackStartMs).toBe(-250);
    player.play();
    expect(tracks[0]?.track.play).toHaveBeenCalledOnce();
  });

  it('settles as failed without a recording when the file does not load', async () => {
    const { player, tracks } = setup({ [a.src]: null });
    await player.load(a);
    expect(player.state).toBe('failed');
    expect(player.loaded).toBe(false);
    expect(tracks).toHaveLength(0);
    player.play();
    player.resume();
  });

  it('forgets the recording for a chart without one', async () => {
    const { player, tracks } = setup({ [a.src]: bufferOf('a') });
    await player.load(a);
    await player.load(undefined);
    expect(player.state).toBe('none');
    expect(player.loaded).toBe(false);
    expect(tracks[0]?.track.stop).toHaveBeenCalledWith(0);
  });

  it('keeps the decoded file across loads of the same song', async () => {
    const { player, loadBuffer, createTrack } = setup({ [a.src]: bufferOf('a') });
    await player.load(a);
    await player.load({ ...a, offsetMs: 100 });
    expect(loadBuffer).toHaveBeenCalledOnce();
    expect(createTrack).toHaveBeenCalledTimes(2);
    expect(createTrack).toHaveBeenLastCalledWith(expect.anything(), -100);
    expect(player.state).toBe('loaded');
  });

  it('tries a failed file again on the next load', async () => {
    const { player, loadBuffer } = setup({ [a.src]: null });
    await player.load(a);
    await player.load(a);
    expect(loadBuffer).toHaveBeenCalledTimes(2);
  });

  it('shares one download between loads of the same file', async () => {
    const { player, loadBuffer, gates } = setup();
    const first = player.load(a);
    const second = player.load(a);
    gates.get(a.src)?.(bufferOf('a'));
    await Promise.all([first, second]);
    expect(loadBuffer).toHaveBeenCalledOnce();
    expect(player.loaded).toBe(true);
  });

  it('ignores a load that a later one overtook', async () => {
    const { player, tracks, gates } = setup();
    const first = player.load(a);
    const second = player.load(b);
    gates.get(b.src)?.(bufferOf('b'));
    await second;
    gates.get(a.src)?.(bufferOf('a'));
    await first;
    expect(player.state).toBe('loaded');
    expect(tracks.map((t) => t.buffer)).toEqual([expect.objectContaining({ name: 'b' })]);
  });

  describe('lifecycle', () => {
    async function loaded() {
      const fixture = setup({ [a.src]: bufferOf('a') });
      await fixture.player.load(a);
      const track = fixture.tracks[0]?.track;
      if (!track) throw new Error('no track');
      return { ...fixture, track };
    }

    it('plays on a run start and replays after a pause on resume', async () => {
      const { player, track } = await loaded();
      player.play();
      player.pause(30);
      expect(track.stop).toHaveBeenLastCalledWith(30);
      player.resume();
      expect(track.play).toHaveBeenCalledTimes(2);
    });

    it('does not replay on resume once the run was stopped', async () => {
      const { player, track } = await loaded();
      player.play();
      player.stopAll(150);
      expect(track.stop).toHaveBeenLastCalledWith(150);
      player.resume();
      expect(track.play).toHaveBeenCalledOnce();
    });

    it('does not play on resume before any run started it', async () => {
      const { player, track } = await loaded();
      player.resume();
      expect(track.play).not.toHaveBeenCalled();
    });

    it('does not replay on resume after a new load stopped it', async () => {
      const { player, track } = await loaded();
      player.play();
      await player.load(a);
      expect(track.stop).toHaveBeenLastCalledWith(0);
      player.resume();
      expect(track.play).toHaveBeenCalledOnce();
    });

    it('passes a context recreation on to the node', async () => {
      const { player, track } = await loaded();
      player.reset();
      expect(track.reset).toHaveBeenCalledOnce();
    });
  });
});
