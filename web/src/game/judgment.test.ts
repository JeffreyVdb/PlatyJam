import { describe, expect, it } from 'vitest';
import { TEMPOS } from './session-contract';
import { headDeadline, headIsExpired, judgeHead, tailReleaseIsSuccessful } from './judgment';

describe('judgment windows', () => {
  describe.each(TEMPOS)('at %sx', (tempo) => {
    // Windows are real ms; at tempo x a real ms is x chart ms.
    const chart = (realMs: number) => realMs * tempo;
    const t = 10_000;

    it('is Perfect up to and including 50 real ms either side', () => {
      expect(judgeHead(t, t, tempo)).toBe('perfect');
      expect(judgeHead(t, t + chart(50), tempo)).toBe('perfect');
      expect(judgeHead(t, t - chart(50), tempo)).toBe('perfect');
    });

    it('is Good just beyond 50 and up to and including 120 real ms', () => {
      expect(judgeHead(t, t + chart(50.25), tempo)).toBe('good');
      expect(judgeHead(t, t - chart(50.25), tempo)).toBe('good');
      expect(judgeHead(t, t + chart(120), tempo)).toBe('good');
      expect(judgeHead(t, t - chart(120), tempo)).toBe('good');
    });

    it('is outside the window beyond 120 real ms', () => {
      expect(judgeHead(t, t + chart(120.25), tempo)).toBeUndefined();
      expect(judgeHead(t, t - chart(120.25), tempo)).toBeUndefined();
    });

    it('expires a head strictly after its +120 real ms boundary', () => {
      expect(headDeadline(t, tempo)).toBe(t + chart(120));
      expect(headIsExpired(t, t + chart(120), tempo)).toBe(false);
      expect(headIsExpired(t, t + chart(120.25), tempo)).toBe(true);
    });

    it('accepts a hold release from 120 real ms before its tail', () => {
      const end = t + 2000;
      expect(tailReleaseIsSuccessful(end, end - chart(120), tempo)).toBe(true);
      expect(tailReleaseIsSuccessful(end, end - chart(120.25), tempo)).toBe(false);
      expect(tailReleaseIsSuccessful(end, end, tempo)).toBe(true);
    });
  });

  it('keeps the windows equally generous in real time at every tempo', () => {
    // 100 chart ms late: 100 real ms at 1x (Good), 66.7 at 1.5x (Good), 133 at 0.75x (outside).
    expect(judgeHead(0, 100, 1)).toBe('good');
    expect(judgeHead(0, 70, 1.5)).toBe('perfect');
    expect(judgeHead(0, 100, 0.75)).toBeUndefined();
  });
});
