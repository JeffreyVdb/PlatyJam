import { describe, expect, it, vi } from 'vitest';
import { createLatencyDialog, detectSwitchPlatform, type SwitchPlatform } from './latency-dialog';

describe('detectSwitchPlatform', () => {
  it.each([
    ['an iPad', 'Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X)', 'iPad', 5, 'ios'],
    ['an iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)', 'iPhone', 5, 'ios'],
    ['iPadOS Safari, which reports a Mac', 'Mozilla/5.0 (Macintosh)', 'MacIntel', 5, 'ios'],
    ['Android', 'Mozilla/5.0 (Linux; Android 15)', 'Linux armv81', 5, 'android'],
    ['a Mac', 'Mozilla/5.0 (Macintosh)', 'MacIntel', 0, 'other'],
    ['Linux', 'Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64', 0, 'other'],
  ])('tells %s', (_, userAgent, platform, maxTouchPoints, expected) => {
    expect(detectSwitchPlatform({ userAgent, platform, maxTouchPoints })).toBe(expected);
  });
});

describe('createLatencyDialog', () => {
  const dialogFor = (platform: SwitchPlatform) => {
    const dialog = createLatencyDialog({
      watch: { verdict: () => 'delayed', latencyMs: () => 187, subscribe: () => () => undefined },
      platform,
      onPlayAnyway: vi.fn(),
      onPlayAndMute: vi.fn(),
      onSwitched: vi.fn(),
      onCalibrate: vi.fn(),
      onCancel: vi.fn(),
    });
    dialog.open(187);
    document.body.append(dialog.node);
    [...dialog.node.querySelectorAll('button')]
      .find((b) => b.textContent === 'Use speakers')
      ?.click();
    return dialog.node.textContent;
  };

  it.each([
    ['ios', 'Control Center'],
    ['android', 'quick settings'],
    ['other', 'system sound settings'],
  ] as const)('gives the %s way to switch to the speaker', (platform, words) => {
    expect(dialogFor(platform)).toContain(words);
    document.body.replaceChildren();
  });
});
