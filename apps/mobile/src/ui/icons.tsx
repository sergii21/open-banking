import Svg, { Circle, Path } from 'react-native-svg';

export type IconName = 'wallet' | 'list' | 'scan' | 'report' | 'sliders' | 'people';

/** Line icons drawn here (24 × 24, round joins), so the app needs no icon font. A filled backdrop marks the selected one. */
const PATHS: Record<IconName, readonly string[]> = {
  wallet: [
    'M3 7.5A2.5 2.5 0 0 1 5.5 5H17a2 2 0 0 1 2 2v1',
    'M3 7.5V17a2.5 2.5 0 0 0 2.5 2.5H19a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2H5.5A2.5 2.5 0 0 1 3 7.5Z',
    'M16.5 13.75h.01',
  ],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01'],
  scan: [
    'M4 8V6a2 2 0 0 1 2-2h2',
    'M16 4h2a2 2 0 0 1 2 2v2',
    'M20 16v2a2 2 0 0 1-2 2h-2',
    'M8 20H6a2 2 0 0 1-2-2v-2',
    'M8 12h8',
  ],
  report: [
    'M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
    'M14 3v5h5',
    'M9 13h6',
    'M9 17h4',
  ],
  people: [
    'M3.5 19.5v-1a4.5 4.5 0 0 1 4.5-4.5h2a4.5 4.5 0 0 1 4.5 4.5v1',
    'M16 4.6a3.25 3.25 0 0 1 0 6.3',
    'M17.5 14.2a4.5 4.5 0 0 1 3 4.3v1',
  ],
  sliders: ['M4 7h8', 'M18 7h2', 'M4 17h2', 'M12 17h8'],
};

const DOTS: Partial<Record<IconName, readonly (readonly [number, number, number?])[]>> = {
  sliders: [
    [15, 7],
    [9, 17],
  ],
  people: [[9, 7.75, 3.25]],
};

export function Icon(props: { name: IconName; color: string; size?: number; bold?: boolean }) {
  const size = props.size ?? 24;
  const width = props.bold ? 2.3 : 1.8;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessible={false}>
      {PATHS[props.name].map((d) => (
        <Path
          key={d}
          d={d}
          stroke={props.color}
          strokeWidth={width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {(DOTS[props.name] ?? []).map(([cx, cy, r]) => (
        <Circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r={r ?? 2.4}
          stroke={props.color}
          strokeWidth={width}
        />
      ))}
    </Svg>
  );
}
