import { tileEnd, tileIssues, type Tile, type TileIssue } from '../../src/chart/schema.ts';

/**
 * Every lane rule the converter promises: the chart format's own (see `tileIssues`),
 * plus at least `minLaneGapMs` from the end of a tile to the next one in its lane,
 * at most two tiles at one time, and a double's lower note in the left lane.
 */
export function laneRuleIssues(tiles: readonly Tile[], minLaneGapMs: number): TileIssue[] {
  const issues = tileIssues(tiles);
  const laneEnd: (number | undefined)[] = [];
  tiles.forEach((tile, index) => {
    const end = laneEnd[tile.lane];
    if (end !== undefined && tile.t - end < minLaneGapMs) {
      issues.push({
        index,
        message: `tile at ${tile.t} in lane ${tile.lane} is ${tile.t - end} ms after the previous one there ends; the minimum is ${minLaneGapMs} ms`,
      });
    }
    laneEnd[tile.lane] = tileEnd(tile);

    const prev = tiles[index - 1];
    if (prev?.t !== tile.t) return;
    if (tiles[index - 2]?.t === tile.t) {
      issues.push({ index, message: `more than two tiles at ${tile.t}` });
    }
    if (prev.lane < tile.lane && Math.max(...prev.pitches) >= Math.min(...tile.pitches)) {
      issues.push({ index, message: `double at ${tile.t}: the lower note must be on the left` });
    }
  });
  return issues;
}
