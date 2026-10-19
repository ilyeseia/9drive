import { View } from 'react-native';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';

/**
 * Small outline icon set drawn as SVG paths (24x24 grid, 2px stroke). Geometry follows the MIT-licensed Feather icon
 * set. Icons are decorative: the control that contains one always carries its own accessibility label.
 */
export type IconName = 'cloud' | 'folder' | 'chat' | 'sliders' | 'mail' | 'lock' | 'user' | 'eye' | 'eyeOff' | 'alert' | 'check';

function Glyph({ name }: { name: IconName }) {
  switch (name) {
    case 'cloud':
      return <Path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />;
    case 'folder':
      return <Path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />;
    case 'chat':
      return (
        <Path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      );
    case 'sliders':
      return (
        <>
          <Line x1="4" y1="21" x2="4" y2="14" />
          <Line x1="4" y1="10" x2="4" y2="3" />
          <Line x1="12" y1="21" x2="12" y2="12" />
          <Line x1="12" y1="8" x2="12" y2="3" />
          <Line x1="20" y1="21" x2="20" y2="16" />
          <Line x1="20" y1="12" x2="20" y2="3" />
          <Line x1="1" y1="14" x2="7" y2="14" />
          <Line x1="9" y1="8" x2="15" y2="8" />
          <Line x1="17" y1="16" x2="23" y2="16" />
        </>
      );
    case 'mail':
      return (
        <>
          <Path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
          <Polyline points="22,6 12,13 2,6" />
        </>
      );
    case 'lock':
      return (
        <>
          <Rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <Path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </>
      );
    case 'user':
      return (
        <>
          <Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <Circle cx="12" cy="7" r="4" />
        </>
      );
    case 'eye':
      return (
        <>
          <Path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <Circle cx="12" cy="12" r="3" />
        </>
      );
    case 'eyeOff':
      return (
        <>
          <Path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <Circle cx="12" cy="12" r="3" />
          <Line x1="3" y1="3" x2="21" y2="21" />
        </>
      );
    case 'alert':
      return (
        <>
          <Circle cx="12" cy="12" r="10" />
          <Line x1="12" y1="8" x2="12" y2="12" />
          <Line x1="12" y1="16" x2="12.01" y2="16" />
        </>
      );
    case 'check':
      return <Polyline points="20 6 9 17 4 12" />;
  }
}

export function Icon({ name, size = 22, color, strokeWidth = 2 }: { name: IconName; size?: number; color: string; strokeWidth?: number }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none">
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <Glyph name={name} />
      </Svg>
    </View>
  );
}
