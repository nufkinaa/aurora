// The phone player's controls (the website's phone player, glass look):
//
//   top      Back · the title (show, then "S1 E4 · name") · picture-in-picture · lock
//   middle   back 10 · play / pause · forward 10 (big, for a thumb)
//   bottom   the time · the scrubber you can drag (the intro as a band, the
//            landmarks as ticks) · what is left; then Subtitles · Audio & more
//            (the gear menu) · Speed · X-Ray · Watch together · Next episode ·
//            Fill / Fit · Rotate
//
// The menus, Up next, Skip intro, the resume card and every rule behind them are
// the player's own (playback/Player.tsx), shared with the TV; this file only
// draws the touch controls and hands the presses back.
import React, {useMemo, useRef, useState} from 'react';
import {Image, PanResponder, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Tap from '../ui/Tap';
import Icon, {PhoneIconName} from '../ui/Icon';
import {phoneNative} from '../native';

const SCRIM_TOP = require('../../assets/player-top.png');
const SCRIM_BOTTOM = require('../../assets/player-bottom.png');

export type ChromeProps = {
  title: string;
  subtitle: string;
  badges: string[];
  paused: boolean;
  shown: number; // seconds on the scrubber
  duration: number;
  bufPct: number;
  marks: number[];
  band: {start: number; end: number} | null;
  locked: boolean;
  fit: 'fit' | 'fill';
  landscape: boolean;
  hasSubs: boolean;
  subsOff: boolean;
  rate: number;
  party: string | null; // "3 · K2X9" when in a watch party
  next: string | null; // the next episode's label
  pip: boolean;
  /** a copy on the phone: no server, so no menus, X-Ray or watch party */
  simple?: boolean;
  onBack: () => void;
  onToggle: () => void;
  onSkip: (dir: -1 | 1) => void;
  onScrub: (sec: number | null) => void; // a drag in progress (null: let go without moving)
  onSeek: (sec: number) => void;
  onMenu: (m: 'cc' | 'speed' | 'settings' | 'party') => void;
  onXray: () => void;
  onNext: () => void;
  onLock: (on: boolean) => void;
  onFit: () => void;
  onRotate: () => void;
  onPip: () => void;
  onTouch: () => void; // any press: keep the controls up
};

const fmt = (s: number) => {
  const a = Math.max(0, Math.floor(s));
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const sec = a % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
};

function Btn({icon, label, onPress, big, badge, on, mid}: {icon: PhoneIconName; label: string; onPress: () => void; big?: boolean; badge?: string; on?: boolean; mid?: boolean}) {
  const size = big ? 76 : mid ? 56 : 48;
  return (
    <Tap
      borderless
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[s.btn, {width: size, height: size, borderRadius: size / 2}, big && s.big, mid && s.mid, on && s.on]}>
      <Icon name={icon} size={big ? 40 : 26} color="#fff" />
      {badge ? <Text style={s.badge}>{badge}</Text> : null}
    </Tap>
  );
}

function Scrubber({shown, duration, bufPct, marks, band, onScrub, onSeek, onTouch}: Pick<ChromeProps, 'shown' | 'duration' | 'bufPct' | 'marks' | 'band' | 'onScrub' | 'onSeek' | 'onTouch'>) {
  const [w, setW] = useState(1);
  const [drag, setDrag] = useState<number | null>(null);
  const ref = useRef({w: 1, duration, x0: 0});
  ref.current.w = w;
  ref.current.duration = duration;
  const at = (x: number) => Math.max(0, Math.min(ref.current.duration, (x / Math.max(1, ref.current.w)) * ref.current.duration));
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: e => {
          onTouch();
          ref.current.x0 = e.nativeEvent.locationX;
          const t = at(ref.current.x0);
          setDrag(t);
          onScrub(t);
        },
        onPanResponderMove: (_e, g) => {
          const t = at(ref.current.x0 + g.dx);
          setDrag(t);
          onScrub(t);
        },
        onPanResponderRelease: (_e, g) => {
          const t = at(ref.current.x0 + g.dx);
          setDrag(null);
          phoneNative.haptic('tick');
          onSeek(t);
        },
        onPanResponderTerminate: () => {
          setDrag(null);
          onScrub(null);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const cur = drag != null ? drag : shown;
  const pct = duration ? Math.min(100, (cur / duration) * 100) : 0;
  return (
    <View style={s.scrubWrap} onLayout={e => setW(e.nativeEvent.layout.width)} {...pan.panHandlers} accessibilityRole="adjustable" accessibilityLabel={`Position ${fmt(cur)} of ${fmt(duration)}`}>
      <View style={[s.track, drag != null && s.trackTall]}>
        <View style={[s.buffer, {width: `${bufPct}%`}]} />
        <View style={[s.fill, {width: `${pct}%`}]} />
        {duration > 0 && band && band.end > band.start ? (
          <View style={[s.band, {left: `${(band.start / duration) * 100}%`, width: `${((band.end - band.start) / duration) * 100}%`}]} />
        ) : null}
        {duration > 0 ? marks.filter(t => t > 0 && t < duration).map((t, i) => <View key={i} style={[s.mark, {left: `${(t / duration) * 100}%`}]} />) : null}
      </View>
      <View style={[s.head, drag != null && s.headBig, {left: `${pct}%`}]} pointerEvents="none" />
      {drag != null ? (
        <View style={[s.bubble, {left: `${pct}%`}]} pointerEvents="none">
          <Text style={s.bubbleText}>{fmt(drag)}</Text>
        </View>
      ) : null}
    </View>
  );
}

export default function PhoneChrome(p: ChromeProps) {
  const insets = useSafeAreaInsets();
  const padL = Math.max(insets.left, 12) + 4;
  const padR = Math.max(insets.right, 12) + 4;
  if (p.locked) {
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <View style={[s.lockOnly, {top: insets.top + 16, right: padR}]}>
          <Btn icon="lock" label="Unlock the controls" onPress={() => p.onLock(false)} on />
        </View>
      </View>
    );
  }
  const left = p.duration ? Math.max(0, p.duration - p.shown) : 0;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" onTouchStart={p.onTouch}>
      <View style={s.scrimTop} pointerEvents="none">
        <Image source={SCRIM_TOP} style={StyleSheet.absoluteFill} resizeMode="stretch" />
      </View>
      <View style={s.scrimBottom} pointerEvents="none">
        <Image source={SCRIM_BOTTOM} style={StyleSheet.absoluteFill} resizeMode="stretch" />
      </View>

      <View style={[s.top, {paddingTop: insets.top + 8, paddingLeft: padL, paddingRight: padR}]} pointerEvents="box-none">
        <Btn icon="back" label="Back" onPress={p.onBack} />
        <View style={s.titles} pointerEvents="none">
          <Text style={s.title} numberOfLines={1}>
            {p.title}
          </Text>
          {p.subtitle ? (
            <Text style={s.sub} numberOfLines={1}>
              {p.subtitle}
            </Text>
          ) : null}
          {p.badges.length || p.party ? (
            <View style={s.badges}>
              {p.party ? <Text style={s.chip}>{`👥 ${p.party}`}</Text> : null}
              {p.badges.map(b => (
                <Text key={b} style={s.chip}>
                  {b}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
        {p.pip ? <Btn icon="pip" label="Picture in picture" onPress={p.onPip} /> : null}
        <Btn icon="lockOpen" label="Lock the controls" onPress={() => p.onLock(true)} />
      </View>

      <View style={s.middle} pointerEvents="box-none">
        <Btn mid icon="back10" label="Back 10 seconds" onPress={() => p.onSkip(-1)} />
        <Btn big icon={p.paused ? 'play' : 'pause'} label={p.paused ? 'Play' : 'Pause'} onPress={p.onToggle} />
        <Btn mid icon="forward10" label="Forward 10 seconds" onPress={() => p.onSkip(1)} />
      </View>

      <View style={[s.bottom, {paddingBottom: Math.max(insets.bottom, 10) + 4, paddingLeft: padL, paddingRight: padR}]} pointerEvents="box-none">
        <View style={s.timeRow} pointerEvents="box-none">
          <Text style={s.time}>{fmt(p.shown)}</Text>
          <Scrubber shown={p.shown} duration={p.duration} bufPct={p.bufPct} marks={p.marks} band={p.band} onScrub={p.onScrub} onSeek={p.onSeek} onTouch={p.onTouch} />
          <Text style={[s.time, s.timeRight]}>{p.duration ? `-${fmt(left)}` : ''}</Text>
        </View>
        <View style={s.row} pointerEvents="box-none">
          {p.hasSubs ? <Btn icon="cc" label="Subtitles" onPress={() => p.onMenu('cc')} badge={p.subsOff ? 'off' : undefined} /> : null}
          {p.simple ? null : (
            <>
              <Btn icon="gear" label="Audio and settings" onPress={() => p.onMenu('settings')} />
              <Btn icon="speed" label="Speed" onPress={() => p.onMenu('speed')} badge={p.rate === 1 ? undefined : `${p.rate}×`} />
              <Btn icon="xray" label="X-Ray" onPress={p.onXray} />
              <Btn icon="people" label="Watch together" onPress={() => p.onMenu('party')} />
            </>
          )}
          <View style={{flex: 1}} />
          <Btn icon="aspect" label={p.fit === 'fill' ? 'Fit the picture' : 'Fill the screen'} onPress={p.onFit} on={p.fit === 'fill'} />
          <Btn icon="rotate" label={p.landscape ? 'Portrait' : 'Landscape'} onPress={p.onRotate} />
          {p.next ? (
            <Tap onPress={p.onNext} style={s.next} accessibilityRole="button" accessibilityLabel={`Next episode — ${p.next}`}>
              <Icon name="next" size={22} color="#fff" />
              <Text style={s.nextText} numberOfLines={1}>
                Next
              </Text>
            </Tap>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  scrimTop: {position: 'absolute', top: 0, left: 0, right: 0, height: 150},
  scrimBottom: {position: 'absolute', bottom: 0, left: 0, right: 0, height: 190},
  top: {position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'flex-start', gap: 6},
  titles: {flex: 1, paddingTop: 4, paddingHorizontal: 6},
  title: {color: '#fff', fontSize: 18, fontWeight: '800'},
  sub: {color: 'rgba(255,255,255,0.82)', fontSize: 14, fontWeight: '600', marginTop: 2},
  badges: {flexDirection: 'row', gap: 6, marginTop: 6},
  chip: {color: '#fff', fontSize: 11, fontWeight: '800', backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden', letterSpacing: 0.5},
  middle: {position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 44},
  bottom: {position: 'absolute', bottom: 0, left: 0, right: 0},
  timeRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  time: {color: '#fff', fontSize: 13, fontWeight: '700', minWidth: 46, fontVariant: ['tabular-nums']},
  timeRight: {textAlign: 'right'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 4},
  btn: {alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  big: {backgroundColor: 'rgba(8,9,16,0.38)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)'},
  mid: {backgroundColor: 'rgba(8,9,16,0.3)'},
  on: {backgroundColor: 'rgba(255,255,255,0.18)'},
  badge: {position: 'absolute', bottom: 4, color: '#fff', fontSize: 9, fontWeight: '900'},
  next: {flexDirection: 'row', alignItems: 'center', gap: 4, height: 40, paddingHorizontal: 14, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.16)', overflow: 'hidden', marginLeft: 4},
  nextText: {color: '#fff', fontSize: 14, fontWeight: '800'},
  lockOnly: {position: 'absolute'},
  scrubWrap: {flex: 1, height: 36, justifyContent: 'center'},
  track: {height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'visible'},
  trackTall: {height: 6, borderRadius: 3},
  buffer: {position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.35)', borderRadius: 3},
  fill: {position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, backgroundColor: '#8b7bff', experimental_backgroundImage: 'linear-gradient(90deg, #6c58ff, #a99bff)'},
  band: {position: 'absolute', top: -1, bottom: -1, backgroundColor: 'rgba(255,207,138,0.45)', borderRadius: 2},
  mark: {position: 'absolute', top: -3, width: 2, height: 10, marginLeft: -1, backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: 1},
  head: {position: 'absolute', width: 14, height: 14, marginLeft: -7, borderRadius: 7, backgroundColor: '#fff', top: 11},
  headBig: {width: 22, height: 22, marginLeft: -11, borderRadius: 11, top: 7},
  bubble: {position: 'absolute', bottom: 34, marginLeft: -36, width: 72, paddingVertical: 4, borderRadius: 10, backgroundColor: 'rgba(8,9,16,0.85)', alignItems: 'center'},
  bubbleText: {color: '#fff', fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums']},
});
