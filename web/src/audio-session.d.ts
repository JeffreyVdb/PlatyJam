// The W3C Audio Session API (WebKit: Safari 16.4+, effective for Web Audio on iOS 17+).
// TypeScript 6.0's lib.dom does not declare it yet; only what PlatyJam uses is here.

type AudioSessionType =
  'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';

interface AudioSession extends EventTarget {
  type: AudioSessionType;
}

interface Navigator {
  /** Missing outside WebKit, and on WebKit builds with the feature off. */
  readonly audioSession?: AudioSession;
}
