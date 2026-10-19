import { describe, expect, it } from 'vitest';
import { createSafeAreaProbe } from './safe-area';

describe('safe-area probe', () => {
  it('reads the four insets as the probe element resolves them', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const probe = createSafeAreaProbe(parent);
    const element = parent.querySelector<HTMLElement>('.safe-area-probe');
    expect(element).not.toBeNull();
    element?.style.setProperty('padding', '24px 12px 20px 8px');
    expect(probe.read()).toEqual({ top: 24, right: 12, bottom: 20, left: 8 });
  });

  it('reads zero where the browser has no insets, and removes itself', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const probe = createSafeAreaProbe(parent);
    expect(probe.read()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    probe.dispose();
    expect(parent.querySelector('.safe-area-probe')).toBeNull();
  });
});
