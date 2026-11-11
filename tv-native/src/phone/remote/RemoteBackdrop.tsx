// Behind the remote — the website's .rm-backdrop: the title's own art, blurred and dimmed, fading in
// when it changes; the aurora ribbon low down (violet and teal light, drifting slowly; still under
// reduced motion); and a shade from the top and the foot so the words hold.
// The blur: a small copy (240 wide, from the server's art ladder) blurred on the device — cheap at
// that size — and stretched over the screen, which softens it further.
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Image, StyleSheet, View, useWindowDimensions} from 'react-native';
import Svg, {Defs, Ellipse, RadialGradient, Stop} from 'react-native-svg';
import {artPath, imgSrc} from '../../api';
import {RM} from './rmLook';
import {colors} from '../theme';

export default function RemoteBackdrop({pic, calm}: {pic: string | null; calm?: boolean}) {
  const {width, height} = useWindowDimensions();
  const fade = useRef(new Animated.Value(0)).current;
  const drift = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (pic === shown) return;
    fade.setValue(0);
    setShown(pic);
  }, [pic, shown, fade]);
  useEffect(() => {
    if (calm) {
      drift.setValue(0.5);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {toValue: 1, duration: 22000, easing: Easing.inOut(Easing.sin), useNativeDriver: true}),
        Animated.timing(drift, {toValue: 0, duration: 22000, easing: Easing.inOut(Easing.sin), useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [calm, drift]);
  const small = shown ? artPath(shown, 240) : null;
  const src = shown ? imgSrc(small || shown) : null;
  const rw = width * 1.6;
  const rh = height * 0.62;
  return (
    <View style={s.root} pointerEvents="none">
      {src ? (
        <Animated.View style={[s.art, {opacity: fade}]}>
          <Image
            source={src}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            blurRadius={small ? 10 : 24}
            fadeDuration={0}
            onLoad={() => Animated.timing(fade, {toValue: 1, duration: calm ? 0 : 900, useNativeDriver: true}).start()}
          />
          {/* brightness(0.62) */}
          <View style={[StyleSheet.absoluteFill, {backgroundColor: 'rgba(0,0,0,0.38)'}]} />
        </Animated.View>
      ) : null}
      {/* the aurora ribbon: always there, the light under the deck */}
      <Animated.View
        style={[
          s.ribbon,
          {width: rw, height: rh, left: (width - rw) / 2, bottom: -height * 0.18},
          {transform: [{translateX: drift.interpolate({inputRange: [0, 1], outputRange: [-0.06 * rw, 0.06 * rw]})}, {translateY: drift.interpolate({inputRange: [0, 1], outputRange: [0, -0.04 * rh]})}]},
        ]}>
        <Svg width={rw} height={rh}>
          <Defs>
            <RadialGradient id="rmv" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={RM.accent} stopOpacity={0.42} />
              <Stop offset="0.7" stopColor={RM.accent} stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id="rmt" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="rgb(64,196,186)" stopOpacity={0.26} />
              <Stop offset="0.7" stopColor="rgb(64,196,186)" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Ellipse cx={rw * 0.3} cy={rh * 0.6} rx={rw * 0.6} ry={rh * 0.55} fill="url(#rmv)" />
          <Ellipse cx={rw * 0.72} cy={rh * 0.7} rx={rw * 0.5} ry={rh * 0.5} fill="url(#rmt)" />
        </Svg>
      </Animated.View>
      <View style={s.shade} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {...StyleSheet.absoluteFill, backgroundColor: colors.bg, overflow: 'hidden'},
  art: {position: 'absolute', left: '-12%', top: '-12%', width: '124%', height: '124%'},
  ribbon: {position: 'absolute'},
  shade: {
    ...StyleSheet.absoluteFill,
    experimental_backgroundImage: 'linear-gradient(180deg, rgba(7,8,17,0.55) 0%, rgba(7,8,17,0.18) 38%, rgba(7,8,17,0.72) 100%)',
  },
});
