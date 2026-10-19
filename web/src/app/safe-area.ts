import type { Insets } from '../scene/highway-layout';

/**
 * The safe-area insets in CSS px. CSS can use `env(safe-area-inset-*)` but script
 * cannot read it, so a hidden element takes the four insets as padding and its
 * computed padding is the answer. The stage needs them to keep the lanes and the
 * HUD's band clear of the status bar, rounded corners and home indicator.
 */
export interface SafeAreaProbe {
  read(): Insets;
  dispose(): void;
}

export function createSafeAreaProbe(parent: HTMLElement): SafeAreaProbe {
  const probe = parent.ownerDocument.createElement('div');
  probe.className = 'safe-area-probe';
  probe.setAttribute('aria-hidden', 'true');
  parent.append(probe);
  const px = (value: string) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    read() {
      const style = getComputedStyle(probe);
      return {
        top: px(style.paddingTop),
        right: px(style.paddingRight),
        bottom: px(style.paddingBottom),
        left: px(style.paddingLeft),
      };
    },
    dispose() {
      probe.remove();
    },
  };
}
