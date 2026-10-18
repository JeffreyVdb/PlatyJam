/**
 * Anything the scheduler can play: the piano sampler, or the calibration click.
 * Times are context seconds; omitting `when` means "now".
 */
export interface Instrument<Voice = unknown> {
  /** Returns null when the sound cannot play (sample not loaded, pitch out of range). */
  noteOn(pitch: number, velocity: number, when?: number): Voice | null;
  noteOff(voice: Voice, when?: number): void;
  /** Fades out every playing and scheduled voice over `fadeMs`. */
  stopAll(fadeMs: number): void;
}
