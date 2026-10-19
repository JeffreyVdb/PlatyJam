import type { Chart } from '../chart/schema';

/**
 * Charts by song id, kept for the session: switching difficulty, speed or settings
 * reloads the session with the chart already in hand instead of fetching it again.
 * A failed download is forgotten, so the next request retries it.
 */
export interface ChartCache {
  /** The chart, or the download that will deliver it. */
  get(songId: string): Chart | Promise<Chart>;
}

export function createChartCache(fetchChart: (songId: string) => Promise<Chart>): ChartCache {
  const charts = new Map<string, Chart | Promise<Chart>>();
  return {
    get(songId) {
      const known = charts.get(songId);
      if (known) return known;
      const pending = fetchChart(songId).then(
        (chart) => {
          charts.set(songId, chart);
          return chart;
        },
        (error: unknown) => {
          charts.delete(songId);
          throw error;
        },
      );
      charts.set(songId, pending);
      return pending;
    },
  };
}
