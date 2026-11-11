// The remote's scrub bar — the website's .rm-scrub: a thick bar (8, 12 while held) with a white
// thumb, a fat invisible hit area over it; dragging previews the time under the thumb, letting go
// sends ONE seek. The times under it count on between the TV's reports (the parent's clock).
import React, {useMemo, useRef, useState} from 'react';
import {PanResponder, StyleSheet, Text, View} from 'react-native';
import {fmtClock, scrubAt, share} from './remoteRules';
import {RM} from './rmLook';
import {colors} from '../theme';

export default function Scrub({position, duration, disabled, buffering, onDrag, onSeek}: {
  position: number;
  duration: number;
  disabled?: boolean;
  buffering?: boolean;
  /** true while a finger holds it (the parent stops taking the TV's clock) */
  onDrag: (held: boolean) => void;
  onSeek: (to: number) => void;
}) {
  const [w, setW] = useState(0);
  const [held, setHeld] = useState<number | null>(null); // the previewed position while held
  const pageLeft = useRef(0);
  const live = useRef({w, duration, disabled, onDrag, onSeek});
  live.current = {w, duration, disabled, onDrag, onSeek};
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !live.current.disabled && live.current.duration > 0,
        onMoveShouldSetPanResponder: () => !live.current.disabled && live.current.duration > 0,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: e => {
          // where the bar starts on the screen: the touch's page x less its x on the bar
          pageLeft.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
          live.current.onDrag(true);
          setHeld(scrubAt(e.nativeEvent.locationX, live.current.w, live.current.duration));
        },
        // (locationX is the finger over whatever view it is on: the page x less the bar's start)
        onPanResponderMove: e => setHeld(scrubAt(e.nativeEvent.pageX - pageLeft.current, live.current.w, live.current.duration)),
        onPanResponderRelease: e => {
          const to = scrubAt(e.nativeEvent.pageX - pageLeft.current, live.current.w, live.current.duration);
          setHeld(null);
          live.current.onDrag(false);
          live.current.onSeek(Math.round(to * 10) / 10);
        },
        onPanResponderTerminate: () => {
          setHeld(null);
          live.current.onDrag(false);
        },
      }),
    [],
  );
  const p = held != null ? held : position;
  const f = share(p, duration);
  return (
    <View style={s.root}>
      <View
        style={s.hit}
        onLayout={e => setW(e.nativeEvent.layout.width)}
        {...pan.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Position"
        accessibilityValue={{text: duration ? `${fmtClock(p)} of ${fmtClock(duration)}` : fmtClock(p)}}
        accessibilityActions={[{name: 'increment'}, {name: 'decrement'}]}
        onAccessibilityAction={e => {
          if (disabled || !duration) return;
          onSeek(Math.max(0, Math.min(duration, position + (e.nativeEvent.actionName === 'increment' ? 10 : -10))));
        }}>
        <View style={[s.track, held != null && s.trackHeld]} pointerEvents="none">
          <View style={[s.fill, {width: `${f * 100}%`}, buffering && s.fillBusy]} />
          <View style={[s.thumb, {left: `${f * 100}%`}, held != null && s.thumbHeld]} />
        </View>
      </View>
      <View style={s.times}>
        <Text style={s.time}>{fmtClock(p)}</Text>
        <Text style={s.time}>{duration ? `-${fmtClock(Math.max(0, duration - p))}` : ''}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: {paddingHorizontal: 4, paddingTop: 2},
  hit: {height: 34, justifyContent: 'center'},
  track: {height: 8, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.18)'},
  trackHeld: {height: 12},
  fill: {height: '100%', borderRadius: 999, experimental_backgroundImage: `linear-gradient(90deg, ${RM.accent} 0%, #a6c8ff 100%)`, boxShadow: '0 0 14px rgba(139,123,255,0.55)'},
  fillBusy: {opacity: 0.7},
  thumb: {position: 'absolute', top: '50%', width: 20, height: 20, marginTop: -10, marginLeft: -10, borderRadius: 10, backgroundColor: '#fff', boxShadow: '0 2px 10px rgba(0,0,0,0.45)'},
  thumbHeld: {transform: [{scale: 1.35}]},
  times: {flexDirection: 'row', justifyContent: 'space-between', marginTop: 2},
  time: {color: colors.textDim, fontSize: 13.1, fontWeight: '700', fontVariant: ['tabular-nums']},
});
