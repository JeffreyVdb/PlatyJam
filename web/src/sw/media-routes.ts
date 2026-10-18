// Shared by the service worker and its unit tests: keep this free of DOM and worker globals.

export const SONGS_CACHE = 'platyjam-songs';
export const SOUNDFONTS_CACHE = 'platyjam-soundfonts';

export type MediaCacheName = typeof SONGS_CACHE | typeof SOUNDFONTS_CACHE;

const SONG_EXTENSIONS = /\.(?:mp3|m4a|aac|ogg|oga|opus|wav|flac|mid|midi)$/i;
const SOUNDFONT_EXTENSIONS = /\.(?:sf2|sf3|sfz|sfogg)$/i;

/**
 * Picks the runtime cache for a request, or `null` for everything else (the app
 * shell is precached and handled separately).
 *
 * Matches same-origin requests inside the service worker scope that live under
 * `<scope>songs/` or `<scope>soundfonts/`, or that carry an audio, MIDI or soundfont
 * extension anywhere in scope.
 */
export function mediaCacheFor(url: URL, scope: URL): MediaCacheName | null {
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return null;
  const path = url.pathname.slice(scope.pathname.length);

  if (path.startsWith('soundfonts/') || SOUNDFONT_EXTENSIONS.test(path)) return SOUNDFONTS_CACHE;
  if (path.startsWith('songs/') || SONG_EXTENSIONS.test(path)) return SONGS_CACHE;
  return null;
}
