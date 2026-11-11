// Aurora Play — the star, and the soft light that goes with it. Both are white
// baked pictures tinted where they are used (tools/gen_play_kit.py); the star
// is the website's own 24 x 24 path.
import React from 'react';
import {Image, ImageStyle, StyleProp} from 'react-native';
import {PLAY} from './tokens';

export const STAR_SRC = require('../assets/play-star.png');
export const GLOW_SRC = require('../assets/play-glow.png');

export function Star({size = 16, color = PLAY.gold, style}: {size?: number; color?: string; style?: StyleProp<ImageStyle>}) {
  return <Image source={STAR_SRC} fadeDuration={0} style={[{width: size, height: size, tintColor: color}, style]} />;
}

export function Glow({size = 64, color = PLAY.gold, opacity = 1, style}: {size?: number; color?: string; opacity?: number; style?: StyleProp<ImageStyle>}) {
  return <Image source={GLOW_SRC} fadeDuration={0} style={[{width: size, height: size, tintColor: color, opacity}, style]} />;
}
