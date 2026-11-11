// The remote's own drawings — the website's (public/js/screens/remote.js `I`, public/js/remote.js
// ICONS), path for path: round-capped outlines at 1.8–2.2, the filled play / pause / next / stop.
import React from 'react';
import Svg, {Circle, Path, Rect, Text as SvgText} from 'react-native-svg';

export type RemoteIconName =
  | 'down' | 'more' | 'play' | 'pause' | 'back' | 'fwd' | 'cc' | 'audio' | 'next' | 'stop' | 'home' | 'backKey'
  | 'volDown' | 'volUp' | 'mute' | 'arrow' | 'check' | 'tv' | 'computer' | 'tablet' | 'remote' | 'cast';

type P = {name: RemoteIconName; size?: number; color?: string; n?: number; deg?: number};

export default function RemoteIcon({name, size = 22, color = '#f3f4f8', n = 10, deg = 0}: P) {
  const line = {fill: 'none', stroke: color, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
  switch (name) {
    case 'down':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M6 9l6 6 6-6" {...line} strokeWidth={2} /></Svg>);
    case 'more':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Circle cx={5} cy={12} r={1.9} fill={color} /><Circle cx={12} cy={12} r={1.9} fill={color} /><Circle cx={19} cy={12} r={1.9} fill={color} /></Svg>);
    case 'play':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M8.2 5.3c-.8-.5-1.7.1-1.7 1v11.4c0 .9.9 1.5 1.7 1l9.4-5.7c.7-.4.7-1.5 0-2z" fill={color} /></Svg>);
    case 'pause':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Rect x={6.5} y={5} width={4} height={14} rx={1.3} fill={color} /><Rect x={13.5} y={5} width={4} height={14} rx={1.3} fill={color} /></Svg>);
    case 'back':
    case 'fwd':
      return (
        <Svg width={size} height={size} viewBox="0 0 32 32">
          <Path d={name === 'back' ? 'M9 8.5A10 10 0 1 1 6 16' : 'M23 8.5A10 10 0 1 0 26 16'} {...line} strokeWidth={2} />
          <Path d={name === 'back' ? 'M9 3.5v5h5' : 'M23 3.5v5h-5'} {...line} strokeWidth={2} />
          <SvgText x={16} y={20} textAnchor="middle" fontSize={9} fontWeight="700" fill={color}>{String(n)}</SvgText>
        </Svg>
      );
    case 'cc':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Rect x={3} y={5} width={18} height={14} rx={3} {...line} strokeWidth={1.8} /><Path d="M10 10.2a2.2 2.2 0 1 0 0 3.6M17 10.2a2.2 2.2 0 1 0 0 3.6" {...line} strokeWidth={1.8} /></Svg>);
    case 'audio':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" {...line} strokeWidth={1.8} /></Svg>);
    case 'next':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M6.5 6.2c-.7-.4-1.5.1-1.5.9v9.8c0 .8.8 1.3 1.5.9l7.7-4.9c.6-.4.6-1.3 0-1.7z" fill={color} /><Rect x={16} y={5.5} width={2.6} height={13} rx={1} fill={color} /></Svg>);
    case 'stop':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Rect x={6} y={6} width={12} height={12} rx={2.5} fill={color} /></Svg>);
    case 'home':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4 11l8-6.5 8 6.5" {...line} strokeWidth={1.9} /><Path d="M6.5 9.5V19h11V9.5" {...line} strokeWidth={1.9} /></Svg>);
    case 'backKey':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M9 7L4 12l5 5" {...line} strokeWidth={1.9} /><Path d="M4 12h10a6 6 0 0 1 6 6" {...line} strokeWidth={1.9} /></Svg>);
    case 'volDown':
    case 'volUp':
    case 'mute':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M4 9.5h3l4-3.5v12l-4-3.5H4z" {...line} strokeWidth={1.9} />
          <Path d={name === 'volDown' ? 'M15 12h5' : name === 'volUp' ? 'M15 12h5M17.5 9.5v5' : 'M15.5 9.5l5 5M20.5 9.5l-5 5'} {...line} strokeWidth={1.9} />
        </Svg>
      );
    case 'arrow':
      return (<Svg width={size} height={size} viewBox="0 0 24 24" style={{transform: [{rotate: `${deg}deg`}]}}><Path d="M6 14l6-6 6 6" {...line} strokeWidth={2.2} /></Svg>);
    case 'check':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M5 12.5l4.2 4.2L19 7" {...line} strokeWidth={2.4} /></Svg>);
    case 'tv':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Rect x={3} y={5} width={18} height={12} rx={2} {...line} strokeWidth={1.8} /><Path d="M8 20h8M12 17v3" {...line} strokeWidth={1.8} /></Svg>);
    case 'computer':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Rect x={4} y={5} width={16} height={11} rx={1.5} {...line} strokeWidth={1.8} /><Path d="M2.5 19h19" {...line} strokeWidth={1.8} /></Svg>);
    case 'tablet':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Rect x={5} y={3} width={14} height={18} rx={2} {...line} strokeWidth={1.8} /><Path d="M11 18h2" {...line} strokeWidth={1.8} /></Svg>);
    case 'remote':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Rect x={7} y={2.5} width={10} height={19} rx={3} {...line} strokeWidth={1.8} /><Circle cx={12} cy={8} r={2} {...line} strokeWidth={1.8} /><Path d="M10 13h.01M14 13h.01M10 16.5h.01M14 16.5h.01" {...line} strokeWidth={1.8} /></Svg>);
    case 'cast':
      return (<Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M3 9V7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-6" {...line} strokeWidth={1.8} /><Path d="M3 13a6 6 0 016 6M3 16.5A2.5 2.5 0 015.5 19M3 19h.01" {...line} strokeWidth={1.8} /></Svg>);
  }
  return null;
}
