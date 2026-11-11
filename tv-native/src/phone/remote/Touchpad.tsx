// The remote's touchpad — the website's .rm-touch: a dotted glass pad; a swipe is an arrow (and a
// long drag keeps stepping, one more every 70 dp), a tap is OK. A ripple where the finger acted
// (violet for an arrow, white for OK), the rim lit while the pad is held, the two hints at its foot.
// The rules are remoteRules.ts swipeStart / swipeMove / swipeEnd.
import React, {useMemo, useRef, useState} from 'react';
import {Animated, Easing, PanResponder, StyleSheet, Text, View} from 'react-native';
import Svg, {Circle, Defs, Pattern, RadialGradient, Rect, Stop} from 'react-native-svg';
import {Dir, Swipe, swipeEnd, swipeMove, swipeStart} from './remoteRules';
import {PANE, RM} from './rmLook';
import {colors} from '../theme';

const RIPPLE = 120;

export default function Touchpad({onPress, steerable = true, calm}: {onPress: (k: Dir | 'ok') => void; steerable?: boolean; calm?: boolean}) {
  const [held, setHeld] = useState(false);
  const ripple = useRef({x: new Animated.Value(-500), y: new Animated.Value(-500), a: new Animated.Value(0)}).current;
  const [kind, setKind] = useState<'ok' | 'arrow'>('arrow');
  const live = useRef({onPress, steerable, calm});
  live.current = {onPress, steerable, calm};
  const show = (x: number, y: number, k: 'ok' | 'arrow') => {
    setKind(k);
    ripple.x.setValue(x - RIPPLE / 2);
    ripple.y.setValue(y - RIPPLE / 2);
    ripple.a.setValue(0);
    if (live.current.calm) return; // reduced motion: the press is felt (haptic), not drawn
    Animated.timing(ripple.a, {toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start(() => ripple.a.setValue(0));
  };
  const pan = useMemo(() => {
    let sw: Swipe | null = null;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => live.current.steerable,
      onMoveShouldSetPanResponder: () => live.current.steerable,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: e => {
        sw = swipeStart(e.nativeEvent.locationX, e.nativeEvent.locationY, Date.now());
        setHeld(true);
      },
      onPanResponderMove: (_e, g) => {
        if (!sw) return;
        // (the drag from where it began: locationX is unreliable once the finger has moved)
        const x = sw.x + g.dx;
        const y = sw.y + g.dy;
        const dir = swipeMove(sw, x, y);
        if (dir) {
          show(x, y, 'arrow');
          live.current.onPress(dir);
        }
      },
      onPanResponderRelease: (_e, g) => {
        setHeld(false);
        if (!sw) return;
        const s = sw;
        sw = null;
        if (swipeEnd(s, Date.now()) === 'ok') {
          show(s.x + g.dx, s.y + g.dy, 'ok');
          live.current.onPress('ok');
        }
      },
      onPanResponderTerminate: () => {
        sw = null;
        setHeld(false);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View
      style={[s.pad, held && s.padHeld, !steerable && s.off]}
      {...pan.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Touchpad: swipe to move, tap to select"
      accessibilityActions={[{name: 'activate'}, {name: 'increment'}, {name: 'decrement'}]}
      onAccessibilityAction={e => onPress(e.nativeEvent.actionName === 'activate' ? 'ok' : e.nativeEvent.actionName === 'increment' ? 'down' : 'up')}>
      {/* the dots, every 22: faded out under the two hints at the foot */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <Pattern id="rmdots" x={0} y={0} width={22} height={22} patternUnits="userSpaceOnUse">
            <Circle cx={11} cy={11} r={1.1} fill="rgba(255,255,255,0.26)" />
          </Pattern>
        </Defs>
        <Rect x={0} y={0} width="100%" height="100%" fill="url(#rmdots)" />
      </Svg>
      <View style={s.footFade} pointerEvents="none" />
      <View style={[s.glow, held && s.glowOn]} pointerEvents="none" />
      <Animated.View
        pointerEvents="none"
        style={[
          s.ripple,
          {
            opacity: ripple.a.interpolate({inputRange: [0, 0.01, 1], outputRange: [0, 0.95, 0]}),
            transform: [{translateX: ripple.x}, {translateY: ripple.y}, {scale: ripple.a.interpolate({inputRange: [0, 1], outputRange: [0.3, 1.6]})}],
          },
        ]}>
        {/* the site's radial-gradient(circle, colour, transparent 62–65%) */}
        <Svg width={RIPPLE} height={RIPPLE}>
          <Defs>
            <RadialGradient id="rmrip" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={kind === 'ok' ? '#ffffff' : RM.accent} stopOpacity={kind === 'ok' ? 0.6 : 0.55} />
              <Stop offset={kind === 'ok' ? '0.62' : '0.65'} stopColor={kind === 'ok' ? '#ffffff' : RM.accent} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={RIPPLE / 2} cy={RIPPLE / 2} r={RIPPLE / 2} fill="url(#rmrip)" />
        </Svg>
      </Animated.View>
      <View style={s.hint} pointerEvents="none">
        <Text style={s.hintText}>{steerable ? 'Swipe to move' : "This device can't be steered"}</Text>
        <Text style={s.hintText}>Tap to select</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  pad: {flex: 1, minHeight: 220, borderRadius: 32, overflow: 'hidden', ...PANE, boxShadow: '0 24px 60px rgba(0,0,0,0.32)'},
  padHeld: {backgroundColor: 'rgba(24,24,34,0.5)'},
  off: {opacity: 0.45},
  // (a pane-coloured veil over the dots at the foot, where the hints are)
  footFade: {position: 'absolute', left: 0, right: 0, bottom: 0, height: 70, experimental_backgroundImage: 'linear-gradient(180deg, rgba(14,14,22,0) 0%, rgba(14,14,22,0.55) 60%, rgba(14,14,22,0.6) 100%)'},
  glow: {...StyleSheet.absoluteFill, borderRadius: 32, borderWidth: 1, borderColor: 'rgba(139,123,255,0)'},
  glowOn: {borderColor: 'rgba(139,123,255,0.55)', backgroundColor: 'rgba(139,123,255,0.06)'},
  ripple: {position: 'absolute', left: 0, top: 0, width: RIPPLE, height: RIPPLE},
  hint: {position: 'absolute', left: 0, right: 0, bottom: 18, flexDirection: 'row', justifyContent: 'center', gap: 18},
  hintText: {color: colors.textDim, fontSize: 12.5, fontWeight: '700', letterSpacing: 0.25},
});
