/**
 * JSON for generated charts: objects that hold arrays are spread over lines, and
 * arrays of objects get one element per line, so a chart stays small and its diffs
 * readable. Everything else is written inline. Key order is the objects' own.
 */
export function formatJson(value: unknown, indent = ''): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0 || !value.some(isObject)) return JSON.stringify(value);
    return `[\n${value.map((item) => inner + JSON.stringify(item)).join(',\n')}\n${indent}]`;
  }
  if (isObject(value) && Object.values(value).some(needsLines)) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([key, v]) => `${inner}${JSON.stringify(key)}: ${formatJson(v, inner)}`);
    return `{\n${entries.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function needsLines(value: unknown): boolean {
  return Array.isArray(value) || (isObject(value) && Object.values(value).some(needsLines));
}
