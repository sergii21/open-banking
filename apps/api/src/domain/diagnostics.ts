type JsonType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

const typeOf = (value: unknown): JsonType =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : (typeof value as JsonType);

interface EndpointStats {
  calls: number;
  statuses: Map<string, number>;
  durations: number[];
  lastStatus: number | null;
}

interface ShapeStats {
  rows: number;
  fields: Map<string, Map<JsonType, number>>;
  unknown: Set<string>;
}

export interface DiagnosticsSnapshot {
  endpoints: {
    name: string;
    calls: number;
    statuses: string;
    lastStatus: number | null;
    p50Ms: number | null;
    maxMs: number | null;
  }[];
  shapes: {
    path: string;
    rows: number;
    fields: { name: string; types: string }[];
    unknown: string[];
  }[];
  warnings: { message: string; count: number }[];
}

/**
 * What a first real connection may teach us, kept without a single value. It records how many calls went to which endpoint
 * with which status and how long they took, which fields arrived in what type and how often, and which rows could not be
 * understood and why. Never a token, a name, a merchant, an amount or an id: the person pastes this to us when real data
 * surprises us, so it has to be safe to paste and still enough to fix a mapping blind.
 */
export class DiagnosticsCollector {
  private readonly endpoints = new Map<string, EndpointStats>();
  private readonly shapes = new Map<string, ShapeStats>();
  private readonly warnings = new Map<string, number>();

  recordCall(endpoint: string, status: number | null, durationMs: number): void {
    const stats = this.endpoints.get(endpoint) ?? {
      calls: 0,
      statuses: new Map<string, number>(),
      durations: [],
      lastStatus: null,
    };
    stats.calls += 1;
    const key = status === null ? 'network error' : String(status);
    stats.statuses.set(key, (stats.statuses.get(key) ?? 0) + 1);
    stats.durations.push(durationMs);
    if (stats.durations.length > 100) stats.durations.shift();
    stats.lastStatus = status;
    this.endpoints.set(endpoint, stats);
  }

  /** Counts the fields of every object in `rows`, and the names the adapter does not know. */
  observeRows(path: string, rows: readonly unknown[], known: ReadonlySet<string>): void {
    const stats = this.shapes.get(path) ?? {
      rows: 0,
      fields: new Map<string, Map<JsonType, number>>(),
      unknown: new Set<string>(),
    };
    for (const row of rows) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      stats.rows += 1;
      for (const [name, value] of Object.entries(row)) {
        const types = stats.fields.get(name) ?? new Map<JsonType, number>();
        const type = typeOf(value);
        types.set(type, (types.get(type) ?? 0) + 1);
        stats.fields.set(name, types);
        if (!known.has(name) && stats.unknown.size < 40) stats.unknown.add(name);
      }
    }
    this.shapes.set(path, stats);
  }

  /** Only ever call this with text made of field names and codes, never with data. */
  warn(message: string): void {
    const clean = message.replace(/\s+/g, ' ').slice(0, 160);
    this.warnings.set(clean, (this.warnings.get(clean) ?? 0) + 1);
  }

  snapshot(): DiagnosticsSnapshot {
    const median = (values: number[]): number | null => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((x, y) => x - y);
      return sorted[Math.floor(sorted.length / 2)] ?? null;
    };
    return {
      endpoints: [...this.endpoints]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, s]) => ({
          name,
          calls: s.calls,
          statuses: [...s.statuses].map(([status, n]) => `${status}×${n}`).join(' '),
          lastStatus: s.lastStatus,
          p50Ms: median(s.durations),
          maxMs: s.durations.length ? Math.max(...s.durations) : null,
        })),
      shapes: [...this.shapes]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, s]) => ({
          path,
          rows: s.rows,
          fields: [...s.fields]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, types]) => ({
              name,
              types: [...types].map(([type, n]) => `${type}×${n}`).join(' '),
            })),
          unknown: [...s.unknown].sort(),
        })),
      warnings: [...this.warnings]
        .sort(([, a], [, b]) => b - a)
        .map(([message, count]) => ({ message, count })),
    };
  }
}

export type FactValue = string | number | boolean | null;

export interface DiagnosticsReport {
  app: string;
  version: string;
  provider: string;
  generatedAt: string;
  snapshot: DiagnosticsSnapshot;
  /** Counts and yes/no answers computed from stored data (never the data itself). */
  facts: Readonly<Record<string, FactValue>>;
}

/** The text block the person copies. Plain, stable and free of data. */
export function renderDiagnostics(report: DiagnosticsReport): string {
  const lines: string[] = [
    `${report.app} diagnostics`,
    `version ${report.version} · provider ${report.provider} · ${report.generatedAt}`,
    '',
    'Calls to the bank',
  ];
  if (report.snapshot.endpoints.length === 0) lines.push('  none yet');
  for (const e of report.snapshot.endpoints) {
    lines.push(
      `  ${e.name}: ${e.calls} calls, statuses ${e.statuses}, median ${e.p50Ms ?? '-'} ms, slowest ${e.maxMs ?? '-'} ms`,
    );
  }
  lines.push('', 'What arrived (field: type×count)');
  if (report.snapshot.shapes.length === 0) lines.push('  nothing yet');
  for (const shape of report.snapshot.shapes) {
    lines.push(`  ${shape.path} (${shape.rows} rows)`);
    for (const field of shape.fields) lines.push(`    ${field.name}: ${field.types}`);
    if (shape.unknown.length > 0)
      lines.push(`    fields we do not use: ${shape.unknown.join(', ')}`);
  }
  lines.push('', 'Checks on stored data');
  for (const [key, value] of Object.entries(report.facts))
    lines.push(`  ${key}: ${value ?? 'n/a'}`);
  lines.push('', 'Rows or responses we could not use');
  if (report.snapshot.warnings.length === 0) lines.push('  none');
  for (const warning of report.snapshot.warnings) {
    lines.push(`  ${warning.count}× ${warning.message}`);
  }
  return lines.join('\n');
}
