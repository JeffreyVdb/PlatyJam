import { parseChart, type Chart } from './schema.ts';

/**
 * Fetches a chart (`songs/<id>.json`) and validates it. Uses `fetch` so the service
 * worker caches the file for offline play. Rejects with a readable `Error` when the
 * request fails or the chart is invalid.
 */
export async function loadChart(
  url: string,
  fetchFn: (url: string) => Promise<Response> = (u) => fetch(u),
): Promise<Chart> {
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`Could not load chart ${url}: HTTP ${response.status}`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error(`Could not load chart ${url}: not JSON`);
  }
  try {
    return parseChart(json);
  } catch (error) {
    throw new Error(`Could not load chart ${url}: ${(error as Error).message}`, { cause: error });
  }
}
