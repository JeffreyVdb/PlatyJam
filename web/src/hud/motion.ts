/** Whether the player asked for less motion; read each time, so a change applies at once. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
