import { View } from 'react-native';
import Svg, { Circle, Line, Path, Polygon, Polyline, Rect } from 'react-native-svg';

/**
 * Small outline icon set drawn as SVG paths (24x24 grid, 2px stroke). Geometry follows the MIT-licensed Feather icon
 * set. Icons are decorative: the control that contains one always carries its own accessibility label.
 */
export type IconName =
  | 'cloud'
  | 'folder'
  | 'chat'
  | 'sliders'
  | 'mail'
  | 'lock'
  | 'user'
  | 'eye'
  | 'eyeOff'
  | 'alert'
  | 'check'
  | 'search'
  | 'plus'
  | 'upload'
  | 'download'
  | 'file'
  | 'image'
  | 'video'
  | 'archive'
  | 'chevron'
  | 'trash'
  | 'send'
  | 'stop'
  | 'circle'
  | 'server'
  | 'globe'
  | 'info'
  | 'shield'
  | 'share';

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
    case 'search':
      return (
        <>
          <Circle cx="11" cy="11" r="8" />
          <Line x1="21" y1="21" x2="16.65" y2="16.65" />
        </>
      );
    case 'plus':
      return (
        <>
          <Line x1="12" y1="5" x2="12" y2="19" />
          <Line x1="5" y1="12" x2="19" y2="12" />
        </>
      );
    case 'upload':
      return (
        <>
          <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <Polyline points="17 8 12 3 7 8" />
          <Line x1="12" y1="3" x2="12" y2="15" />
        </>
      );
    case 'download':
      return (
        <>
          <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <Polyline points="7 10 12 15 17 10" />
          <Line x1="12" y1="15" x2="12" y2="3" />
        </>
      );
    case 'file':
      return (
        <>
          <Path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <Polyline points="13 2 13 9 20 9" />
        </>
      );
    case 'image':
      return (
        <>
          <Rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <Circle cx="8.5" cy="8.5" r="1.5" />
          <Polyline points="21 15 16 10 5 21" />
        </>
      );
    case 'video':
      return (
        <>
          <Polygon points="23 7 16 12 23 17 23 7" />
          <Rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </>
      );
    case 'archive':
      return (
        <>
          <Polyline points="21 8 21 21 3 21 3 8" />
          <Rect x="1" y="3" width="22" height="5" />
          <Line x1="10" y1="12" x2="14" y2="12" />
        </>
      );
    case 'chevron':
      return <Polyline points="9 18 15 12 9 6" />;
    case 'trash':
      return (
        <>
          <Polyline points="3 6 5 6 21 6" />
          <Path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <Path d="M10 11v6M14 11v6" />
          <Path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </>
      );
    case 'send':
      return (
        <>
          <Line x1="22" y1="2" x2="11" y2="13" />
          <Polygon points="22 2 15 22 11 13 2 9 22 2" />
        </>
      );
    case 'stop':
      return <Rect x="5" y="5" width="14" height="14" rx="2" ry="2" />;
    case 'circle':
      return <Circle cx="12" cy="12" r="10" />;
    case 'server':
      return (
        <>
          <Rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
          <Rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
          <Line x1="6" y1="6" x2="6.01" y2="6" />
          <Line x1="6" y1="18" x2="6.01" y2="18" />
        </>
      );
    case 'globe':
      return (
        <>
          <Circle cx="12" cy="12" r="10" />
          <Line x1="2" y1="12" x2="22" y2="12" />
          <Path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </>
      );
    case 'info':
      return (
        <>
          <Circle cx="12" cy="12" r="10" />
          <Line x1="12" y1="16" x2="12" y2="12" />
          <Line x1="12" y1="8" x2="12.01" y2="8" />
        </>
      );
    case 'shield':
      return <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />;
    case 'share':
      return (
        <>
          <Circle cx="18" cy="5" r="3" />
          <Circle cx="6" cy="12" r="3" />
          <Circle cx="18" cy="19" r="3" />
          <Line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <Line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </>
      );
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
