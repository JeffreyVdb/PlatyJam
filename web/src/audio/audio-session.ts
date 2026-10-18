export type AudioSessionResult =
  | { supported: false }
  /** `type` is read back: WebKit can accept the assignment and change nothing. */
  | { supported: true; type: AudioSessionType };

/**
 * Asks for the `playback` audio session, so the ring/silent switch does not mute
 * Web Audio on iOS 17+. Call it before creating the AudioContext.
 *
 * Side effects of `playback` on WebKit: backgrounding no longer interrupts the
 * context (the engine suspends itself instead), and Now Playing / lock-screen
 * controls can appear while audio runs.
 */
export function requestPlaybackSession(
  nav: { audioSession?: AudioSession } = navigator,
): AudioSessionResult {
  const session = nav.audioSession;
  if (!session) return { supported: false };
  try {
    session.type = 'playback';
  } catch (error) {
    console.warn('[platyjam] audioSession.type could not be set', error);
  }
  return { supported: true, type: session.type };
}
