import { View } from 'react-native';
import Svg, { Circle, Path, Rect, Text as SvgText } from 'react-native-svg';

/**
 * The payment code: always dark on white with a quiet zone of four modules, whatever the theme, because that is what
 * scanners read. The hryvnia sign sits in a white circle in the middle, as the National Bank's format asks.
 */
export function QrCodeView(props: {
  size: number;
  path: string;
  badgeRadius: number;
  label: string;
}) {
  const quiet = 4;
  const side = props.size + quiet * 2;
  const middle = side / 2;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={props.label}
      style={{ alignSelf: 'center', width: '100%', maxWidth: 320, aspectRatio: 1 }}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${side} ${side}`}>
        <Rect x={0} y={0} width={side} height={side} fill="#ffffff" />
        <Path d={props.path} fill="#000000" transform={`translate(${quiet} ${quiet})`} />
        <Circle cx={middle} cy={middle} r={props.badgeRadius} fill="#ffffff" />
        <SvgText
          x={middle}
          y={middle + props.badgeRadius * 0.45}
          fontSize={props.badgeRadius * 1.3}
          fontWeight="700"
          fill="#000000"
          textAnchor="middle"
        >
          ₴
        </SvgText>
      </Svg>
    </View>
  );
}
