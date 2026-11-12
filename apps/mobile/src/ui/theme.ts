import { useColorScheme } from 'react-native';

/** The web app's tokens, as two sets: dark is its own steps, not an inversion. One accent, green for money in. */
const LIGHT = {
  bg: '#f4f5f8',
  surface: '#ffffff',
  surface2: '#eef0f5',
  line: 'rgba(15,18,34,0.18)',
  text: '#0e1020',
  text2: '#4a4e66',
  accent: '#4338ca',
  onAccent: '#ffffff',
  accentSoft: '#eceeff',
  income: '#05603a',
  warn: '#8a5300',
  warnSoft: '#fff1d6',
  danger: '#b3261e',
};
const DARK: typeof LIGHT = {
  bg: '#0b0c11',
  surface: '#14161d',
  surface2: '#1b1e27',
  line: 'rgba(255,255,255,0.18)',
  text: '#f3f4f8',
  text2: '#a9aec3',
  accent: '#9ba3ff',
  onAccent: '#0b0c11',
  accentSoft: '#242654',
  income: '#4fdc9f',
  warn: '#f1c26b',
  warnSoft: '#3a2c0f',
  danger: '#ff9189',
};

export type Theme = typeof LIGHT;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}
