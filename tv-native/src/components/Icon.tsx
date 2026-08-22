// The site's icon set, ported path-for-path.
//
// These are the exact `d` strings from public/js/ui.js — same 24x24 viewBox,
// same geometry — so the TV app draws the identical glyphs rather than the text
// approximations it used before ("«", "VOL", "1x"). Those were chosen when there
// was no vector renderer here; react-native-svg removes that constraint, and
// copying the site's paths is both more faithful and less work than redrawing.
//
// `fill="currentColor"` on the web becomes the `color` prop.
import React from 'react';
import Svg, {Path, Rect, Text as SvgText, G} from 'react-native-svg';
import theme from '../theme';

const {colors} = theme;

export type IconName =
  | 'play'
  | 'pause'
  | 'back'
  | 'plus'
  | 'check'
  | 'cc'
  | 'forward10'
  | 'back10'
  | 'fullscreen'
  | 'speed'
  | 'download'
  | 'search'
  | 'close'
  | 'info'
  | 'gear'
  | 'volume'
  | 'volumeOff'
  | 'film'
  | 'series';

type Props = {name: IconName; size?: number; color?: string};

export default function Icon({name, size = 24, color = colors.white}: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      {glyph(name, color)}
    </Svg>
  );
}

function glyph(name: IconName, color: string) {
  switch (name) {
    case 'play':
      return (
        <Path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l10.98-6.86a1.03 1.03 0 0 0 0-1.76L9.56 4.26A1.03 1.03 0 0 0 8 5.14z" />
      );
    case 'pause':
      return (
        <>
          <Rect x="6" y="4" width="4.4" height="16" rx="1.4" />
          <Rect x="13.6" y="4" width="4.4" height="16" rx="1.4" />
        </>
      );
    case 'back':
      return <Path d="M15.5 4.5 8 12l7.5 7.5-1.8 1.8L4.4 12l9.3-9.3z" />;
    // Film vs series, for the card kind tags — the site's own paths (ui.js).
    // Both have to survive at 11px on top of artwork, so they are told apart by
    // SILHOUETTE rather than detail: a notched strip against a screen on a stand.
    case 'film':
      return <Path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4h-4z" />;
    case 'series':
      return (
        <>
          <Rect x="2" y="4" width="20" height="13" rx="2" />
          <Rect x="8" y="19" width="8" height="2" rx="1" />
        </>
      );
    case 'plus':
      return <Path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z" />;
    case 'check':
      return <Path d="M9.6 16.4 5.2 12l-1.7 1.7 6.1 6.1L20.5 9l-1.7-1.7z" />;
    case 'cc':
      return (
        <Path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6v-2zm0 4h8v2H6v-2zm10 0h2v2h-2v-2zm-6-4h8v2h-8v-2z" />
      );
    // The site draws the "10" as an SVG <text> inside the arrow. Keeping it as
    // text (rather than baking it into the path) is what makes the two skip
    // icons legible at a distance.
    case 'forward10':
      return (
        <>
          <Path d="M12 3V1.8L16.2 5 12 8.2V6c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6h2c0 4.4-3.6 8-8 8s-8-3.6-8-8 3.6-8 8-8z" />
          <SvgText x="8.2" y="15.5" fontSize="7.5" fontWeight="800" fill={color}>
            10
          </SvgText>
        </>
      );
    case 'back10':
      return (
        <>
          <Path d="M12 3V1.8L7.8 5 12 8.2V6c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H4c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z" />
          <SvgText x="8.2" y="15.5" fontSize="7.5" fontWeight="800" fill={color}>
            10
          </SvgText>
        </>
      );
    case 'fullscreen':
      return <Path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />;
    case 'speed':
      return (
        <Path d="M20.4 8.6a10 10 0 1 0 1.1 4.6h-2a8 8 0 1 1-.9-3.7l-3.4 3.4a2.5 2.5 0 1 0 1.4 1.4l5.6-5.6-1.8-.1z" />
      );
    case 'download':
      return <Path d="M12 3v10.6l-3.8-3.8-1.4 1.4L12 17.4l5.2-6.2-1.4-1.4-2.8 3.8V3h-2zM5 19h14v2H5z" />;
    case 'search':
      return (
        <Path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" />
      );
    case 'close':
      return <Path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" />;
    case 'info':
      return <Path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />;
    case 'gear':
      // The site nudges this one left by 1 to optically centre it.
      return (
        <G translateX={-1}>
          <Path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1L15 3.5h-4l-.3 2.5a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
        </G>
      );
    case 'volume':
      return (
        <Path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" />
      );
    case 'volumeOff':
      return (
        <G scale={0.92}>
          <Path d="M3 9v6h4l5 5V4L7 9H3zm18.5 3-2.2-2.2-1.4 1.4 2.2 2.2-2.2 2.2 1.4 1.4 2.2-2.2 2.2 2.2 1.4-1.4-2.2-2.2 2.2-2.2-1.4-1.4-2.2 2.2z" />
        </G>
      );
  }
}
