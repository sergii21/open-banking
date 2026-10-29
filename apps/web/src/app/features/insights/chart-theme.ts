import type { Scheme } from '../../core/theme/theme';

/**
 * The two chart series, as categorical slots 1 and 2 of the validated data-viz palette (blue, orange), stepped for each
 * scheme. Validated with `validate_palette.js` against this app's real chart surface (`--mat-sys-surface-container-low`:
 * #f3f3f4 light, #1a1c1c dark): every check passes in both schemes except the light orange's 2.89:1 contrast against the
 * surface, which the palette's relief rule answers with the table view next to every chart. The same two colours are
 * `--ll-series-1` / `--ll-series-2` in styles.scss for the parts that are plain HTML; keep them in step.
 */
export const SERIES_COLORS: Record<Scheme, { income: string; spending: string }> = {
  light: { income: '#2a78d6', spending: '#eb6834' },
  dark: { income: '#3987e5', spending: '#d95926' },
};

/** The ink and chrome a chart is drawn with, as concrete colours (a chart library cannot read CSS variables). */
export interface ChartInk {
  /** Values and legend text. */
  ink: string;
  /** Axis labels: the secondary ink, which clears 4.5:1 on the surface in both schemes. */
  ink2: string;
  /** Gridlines: a hairline one step off the surface. */
  grid: string;
  /** The baseline the columns grow from. */
  baseline: string;
  /** The card the chart sits on: the 2px gap between columns is drawn in this colour. */
  surface: string;
}

export const toHex = (css: string): string => {
  const channels = css
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (!channels || channels.length < 3) return css;
  return `#${channels.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
};

/**
 * Resolves the app's Material colour tokens for a scheme. A probe element pins its own `color-scheme`, so the answer is
 * right for the scheme asked about even in the instant before the page's own attribute has caught up with a theme change.
 */
export function readInk(scheme: Scheme, doc: Document): ChartInk {
  const probe = doc.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none';
  probe.style.colorScheme = scheme;
  doc.body.appendChild(probe);
  const read = (token: string): string => {
    probe.style.color = `var(${token})`;
    return toHex(getComputedStyle(probe).color);
  };
  const ink: ChartInk = {
    ink: read('--mat-sys-on-surface'),
    ink2: read('--mat-sys-on-surface-variant'),
    grid: read('--mat-sys-outline-variant'),
    baseline: read('--mat-sys-outline'),
    surface: read('--mat-sys-surface-container-low'),
  };
  probe.remove();
  return ink;
}
