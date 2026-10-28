// A profile's face: its photo, else its emoji on its colour (the website's
// .avatar). Rounded square on the wall, a circle in the top bar.
import React from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {imgSrc, Profile} from '../../api';

export default function Avatar({p, size, round}: {p: Pick<Profile, 'avatar' | 'color' | 'avatarImage' | 'name'> | null; size: number; round?: boolean}) {
  const r = round ? size / 2 : Math.round(size * 0.22);
  const src = p?.avatarImage ? imgSrc(p.avatarImage) : null;
  return (
    <View style={[s.box, {width: size, height: size, borderRadius: r, backgroundColor: p?.color || '#2c9fe0'}]}>
      {src ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : (
        <Text style={{fontSize: Math.round(size * 0.5)}} allowFontScaling={false}>
          {p?.avatar || '🙂'}
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  box: {alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
});
