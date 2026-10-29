// The glass look's sky behind every screen: one still picture
// (tools/gen_phone_sky.py), stretched to the window. The website paints it on
// a living canvas; a still costs the phone nothing per frame.
//
// The picture is given the window's size in so many words: with only
// left/right/top/bottom an <Image> drew at the PNG's own size (270×600 dp) in
// the top-left corner (Pixel 9 emulator, Fabric, 2026-10-28).
//
// The picture is opaque and covers the window, so nothing is painted under it:
// no colour of its own (a full-screen fill a frame, for nothing — on a weak
// phone's GPU each one costs; 2026-10-29 overdraw pass). `onDrawn` says when it is
// on screen (the navigator then lets the window's own fill go).
import React from 'react';
import {Image, StyleSheet, View, useWindowDimensions} from 'react-native';

const SKY = require('../assets/sky.png');
const SKY_DIM = require('../assets/sky-dim.png');

export default function Sky({dim, onDrawn}: {dim?: boolean; onDrawn?: () => void}) {
  const {width, height} = useWindowDimensions();
  return (
    <View style={[StyleSheet.absoluteFill, s.ground]} pointerEvents="none">
      <Image source={dim ? SKY_DIM : SKY} style={{width, height}} resizeMode="stretch" fadeDuration={0} onLoad={onDrawn} />
    </View>
  );
}

const s = StyleSheet.create({
  ground: {overflow: 'hidden'},
});
