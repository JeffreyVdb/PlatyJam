import { describe, expect, it, vi } from 'vitest';
import type { Chart } from '../chart/schema';
import { createChartCache } from './chart-cache';

const chart = (id: string) => ({ id }) as unknown as Chart;

describe('createChartCache', () => {
  it('fetches each song once, and hands out the chart itself once it has arrived', async () => {
    const fetchChart = vi.fn((id: string) => Promise.resolve(chart(id)));
    const cache = createChartCache(fetchChart);
    const pending = cache.get('a');
    expect(pending).toBeInstanceOf(Promise);
    expect(cache.get('a')).toBe(pending);
    await pending;
    expect(cache.get('a')).toEqual(chart('a'));
    expect(fetchChart).toHaveBeenCalledTimes(1);
  });

  it('forgets a download that failed, so the next request tries again', async () => {
    const fetchChart = vi
      .fn<(id: string) => Promise<Chart>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(chart('a'));
    const cache = createChartCache(fetchChart);
    await expect(cache.get('a')).rejects.toThrow('offline');
    await expect(cache.get('a')).resolves.toEqual(chart('a'));
    expect(fetchChart).toHaveBeenCalledTimes(2);
  });
});
