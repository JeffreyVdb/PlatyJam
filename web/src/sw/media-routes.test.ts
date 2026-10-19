import { describe, expect, it } from 'vitest';
import { SONGS_CACHE, SOUNDFONTS_CACHE, mediaCacheFor } from './media-routes';

const scope = new URL('https://jeffreyvdb.github.io/PlatyJam/');
const at = (path: string) => mediaCacheFor(new URL(path, scope), scope);

describe('mediaCacheFor', () => {
  it('routes everything under songs/ to the songs cache', () => {
    expect(at('songs/twinkle.mp3')).toBe(SONGS_CACHE);
    expect(at('songs/twinkle/chart.json')).toBe(SONGS_CACHE);
  });

  it("routes a song's recording to the songs cache, so it plays offline once played", () => {
    // `chart.audio.src` is under the app base: `songs/<id>.m4a` (or `.mp3`).
    expect(at('songs/debug-backing.m4a')).toBe(SONGS_CACHE);
    expect(at('songs/some-song.mp3')).toBe(SONGS_CACHE);
    expect(at('songs/some-song.m4a?v=2')).toBe(SONGS_CACHE);
  });

  it('routes everything under soundfonts/ to the soundfonts cache', () => {
    expect(at('soundfonts/piano.sf2')).toBe(SOUNDFONTS_CACHE);
    expect(at('soundfonts/piano/C4.ogg')).toBe(SOUNDFONTS_CACHE);
  });

  it('recognises audio and soundfont files elsewhere in scope by extension', () => {
    expect(at('extras/intro.M4A')).toBe(SONGS_CACHE);
    expect(at('extras/theme.mid')).toBe(SONGS_CACHE);
    expect(at('extras/kit.sf3')).toBe(SOUNDFONTS_CACHE);
  });

  it('ignores query strings when matching extensions', () => {
    expect(at('extras/intro.mp3?v=2')).toBe(SONGS_CACHE);
  });

  it('leaves the app shell to the precache', () => {
    for (const path of [
      '',
      'index.html',
      '?debug',
      'assets/index-abc123.js',
      'assets/index-abc123.css',
      'assets/shantell-sans-latin.woff2',
      'manifest.webmanifest',
      'pwa-192x192.png',
      'apple-touch-icon-180x180.png',
      'sw.js',
    ]) {
      expect(at(path), path).toBeNull();
    }
  });

  it('ignores requests outside the scope or from other origins', () => {
    expect(mediaCacheFor(new URL('https://jeffreyvdb.github.io/other/songs/a.mp3'), scope)).toBe(
      null,
    );
    expect(mediaCacheFor(new URL('https://cdn.example.com/PlatyJam/songs/a.mp3'), scope)).toBe(
      null,
    );
  });

  it('does not match look-alike directory names', () => {
    expect(at('songsheet/readme.txt')).toBeNull();
    expect(at('assets/songs.js')).toBeNull();
  });
});
