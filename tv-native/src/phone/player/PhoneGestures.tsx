// The phone player's touch layer: everything a finger does on the picture
// itself (gestures.ts says what each one means). It lies over the video and
// the subtitles and under every button, so a tap on a button is the button's.
// What it shows while a finger is down: the scrub target with how far it has
// gone, or the brightness / volume level as a bar.
import React, {useMemo, useRef, useState} from 'react';
import {PanResponder, StyleSheet, Text, View, GestureResponderEvent} from 'react-native';
import {decideDrag, deltaLabel, DOUBLE_TAP_MS, DragKind, levelAfter, pinchVerdict, seekTarget, TAP_SLOP_PX, zoneOf} from './gestures';
import {phoneNative} from '../native';
import Icon from '../ui/Icon';

type Props = {
  width: number;
  height: number;
  /** the player's clock and length, read when a drag starts */
  now: () => number;
  duration: () => number;
  onTap: () => void;
  onSkip: (dir: -1 | 1) => void;
  onSeek: (sec: number) => void;
  onFit: (fit: 'fill' | 'fit') => void;
  /** the controls are locked: a tap only shows the lock */
  locked: boolean;
  /** nothing playing yet: no scrubbing */
  armed: boolean;
};

const fmt = (s: number) => {
  const a = Math.max(0, Math.floor(s));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const sec = a % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
};
const dist = (e: GestureResponderEvent) => {
  const t = e.nativeEvent.touches;
  if (!t || t.length < 2) return 0;
  return Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
};

export default function PhoneGestures(p: Props) {
  const props = useRef(p);
  props.current = p;
  const [hud, setHud] = useState<null | {kind: 'seek'; to: number; delta: number} | {kind: 'brightness' | 'volume'; level: number}>(null);
  const st = useRef({
    kind: null as DragKind | null,
    startX: 0,
    from: 0,
    level: 0.5,
    lastTapAt: 0,
    lastTapZone: 'middle' as 'left' | 'middle' | 'right',
    tapTimer: null as ReturnType<typeof setTimeout> | null,
    pinchStart: 0,
    pinched: false,
    multi: false,
    brightness: -1,
    volume: -1,
  });

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: e => {
          const s = st.current;
          s.kind = null;
          s.startX = e.nativeEvent.pageX;
          s.pinched = false;
          s.multi = false;
          s.pinchStart = 0;
          // levels are read ahead, so the first move has something to move from
          phoneNative.getBrightness().then(v => (s.brightness = v));
          phoneNative.getVolume().then(v => (s.volume = v));
        },
        onPanResponderMove: (e, g) => {
          const s = st.current;
          const P = props.current;
          if (P.locked) return;
          if ((e.nativeEvent.touches?.length || 0) >= 2) {
            s.multi = true;
            const d = dist(e);
            if (!s.pinchStart) s.pinchStart = d;
            const v = pinchVerdict(s.pinchStart, d);
            if (v && !s.pinched) {
              s.pinched = true;
              phoneNative.haptic('tick');
              P.onFit(v);
            }
            return;
          }
          if (s.multi) return;
          if (!s.kind) {
            s.kind = decideDrag(g.dx, g.dy, s.startX, P.width);
            if (!s.kind) return;
            if (s.kind === 'seek') {
              if (!P.armed) {
                s.kind = null;
                return;
              }
              s.from = P.now();
            } else {
              s.level = s.kind === 'brightness' ? (s.brightness >= 0 ? s.brightness : 0.5) : s.volume >= 0 ? s.volume : 0.5;
            }
          }
          if (s.kind === 'seek') {
            const to = seekTarget(s.from, g.dx, P.width, P.duration());
            setHud({kind: 'seek', to, delta: to - s.from});
          } else {
            const level = levelAfter(s.level, g.dy, P.height);
            if (s.kind === 'brightness') phoneNative.setBrightness(level);
            else phoneNative.setVolume(level);
            setHud({kind: s.kind, level});
          }
        },
        onPanResponderRelease: (e, g) => {
          const s = st.current;
          const P = props.current;
          const kind = s.kind;
          s.kind = null;
          if (kind === 'seek') {
            const to = seekTarget(s.from, g.dx, P.width, P.duration());
            P.onSeek(to);
            setHud(null);
            return;
          }
          if (kind || s.multi) {
            setTimeout(() => setHud(null), 500);
            return;
          }
          if (Math.abs(g.dx) > TAP_SLOP_PX || Math.abs(g.dy) > TAP_SLOP_PX) return;
          // a tap: the second of a double tap skips (and every quick one after it)
          const now = Date.now();
          const zone = zoneOf(e.nativeEvent.pageX, P.width);
          const quick = now - s.lastTapAt < DOUBLE_TAP_MS && zone === s.lastTapZone && zone !== 'middle';
          s.lastTapAt = now;
          s.lastTapZone = zone;
          if (s.tapTimer) {
            clearTimeout(s.tapTimer);
            s.tapTimer = null;
          }
          if (quick && !P.locked) {
            phoneNative.haptic('tick');
            P.onSkip(zone === 'left' ? -1 : 1);
            return;
          }
          // a lone tap is a tap only once no second one followed
          s.tapTimer = setTimeout(
            () => {
              s.tapTimer = null;
              P.onTap();
            },
            zone === 'middle' || P.locked ? 0 : DOUBLE_TAP_MS,
          );
        },
        onPanResponderTerminate: () => {
          st.current.kind = null;
          setHud(null);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <View style={StyleSheet.absoluteFill} {...responder.panHandlers}>
      {hud?.kind === 'seek' ? (
        <View style={s.seekHud} pointerEvents="none">
          <Text style={s.seekTo}>{fmt(hud.to)}</Text>
          <Text style={s.seekDelta}>{deltaLabel(hud.delta)}</Text>
        </View>
      ) : null}
      {hud && hud.kind !== 'seek' ? (
        <View style={[s.level, hud.kind === 'brightness' ? {left: 28} : {right: 28}]} pointerEvents="none">
          <Icon name={hud.kind === 'brightness' ? 'brightness' : 'volume'} size={20} color="#fff" />
          <View style={s.levelTrack}>
            <View style={[s.levelFill, {height: `${Math.round(hud.level * 100)}%`}]} />
          </View>
          <Text style={s.levelText}>{Math.round(hud.level * 100)}</Text>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  seekHud: {position: 'absolute', alignSelf: 'center', top: '38%', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 16, backgroundColor: 'rgba(8,9,16,0.72)', alignItems: 'center'},
  seekTo: {color: '#fff', fontSize: 30, fontWeight: '800', fontVariant: ['tabular-nums']},
  seekDelta: {color: 'rgba(255,255,255,0.8)', fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums']},
  level: {position: 'absolute', top: '22%', width: 44, paddingVertical: 12, borderRadius: 22, backgroundColor: 'rgba(8,9,16,0.72)', alignItems: 'center', gap: 8},
  levelTrack: {width: 6, height: 120, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.25)', justifyContent: 'flex-end', overflow: 'hidden'},
  levelFill: {width: 6, backgroundColor: '#fff', borderRadius: 3},
  levelText: {color: '#fff', fontSize: 12, fontWeight: '800'},
});
