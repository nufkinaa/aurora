// Aurora Wrapped on the phone, as a story — the website's js/play/story.js
// at a phone's size: segments of progress along the top that fill like an
// aurora ribbon, the profile's name, pause, Skip and ✕; one chapter at a time
// (./WrappedChapters.tsx), each moving on by itself at a calm pace.
//
//   tap the right two thirds / swipe left    the next chapter
//   tap the left third / swipe right         the one before
//   press and hold anywhere                  pause (the frame fades while held)
//   swipe down, ✕, Android's Back            close: "All the numbers" is underneath
//   Skip                                     straight to the summary
//
// `still` (Remove animations, or a screen reader): every chapter at its final
// state, nothing moves on by itself, no pause key — moved by hand. The tab bar
// steps aside while the story is up. Nothing keeps running once it closes.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Animated, BackHandler, PanResponder, Share, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Burst from '../../play/Burst';
import {EASE, LINEAR, tween, useValue} from '../../play/anim';
import {Star} from '../../play/Star';
import {PLAY} from '../../play/tokens';
import {showToast} from '../../toast';
import {phoneNative} from '../native';
import {setTabBarShown} from '../ui/tabBarShown';
import {Key, PlayRoom, RoundKey} from './ui';
import ChapterView, {ChapterApi} from './WrappedChapters';
import {ShareCard, ShareCardHandle} from './ShareCard';
import {announce, chapterInfo, shareWords, swipeOf, tapStep} from './storyWords';
import type {Ctx} from './storyWords';

/** Timers of one chapter visit that stop while the story is paused (the website's api.at). */
class Clock {
  private items: {due: number; fn: () => void; id: ReturnType<typeof setTimeout> | null}[] = [];
  private start = Date.now();
  private pausedAt: number | null = null;
  private held = 0;
  elapsed() {
    return (this.pausedAt ?? Date.now()) - this.start - this.held;
  }
  at(ms: number, fn: () => void) {
    const it = {due: ms, fn, id: null as ReturnType<typeof setTimeout> | null};
    this.items.push(it);
    if (this.pausedAt == null) this.arm(it);
  }
  private arm(it: {due: number; fn: () => void; id: ReturnType<typeof setTimeout> | null}) {
    it.id = setTimeout(() => {
      it.id = null;
      this.items = this.items.filter(x => x !== it);
      it.fn();
    }, Math.max(0, it.due - this.elapsed()));
  }
  pause() {
    if (this.pausedAt != null) return;
    this.pausedAt = Date.now();
    for (const it of this.items) {
      if (it.id) clearTimeout(it.id);
      it.id = null;
    }
  }
  resume() {
    if (this.pausedAt == null) return;
    this.held += Date.now() - this.pausedAt;
    this.pausedAt = null;
    for (const it of this.items) this.arm(it);
  }
  stop() {
    for (const it of this.items) if (it.id) clearTimeout(it.id);
    this.items = [];
  }
}

export default function WrappedStory({c, still, poster, onClose}: {c: Ctx; still: boolean; poster: string | null; onClose: () => void}) {
  const insets = useSafeAreaInsets();
  const {width, height} = useWindowDimensions();
  const chapters = c.chapters;
  const infos = useMemo(() => chapters.map(id => chapterInfo(id, c)), [chapters, c]);
  const [at, setAt] = useState(0);
  const [visit, setVisit] = useState(0); // a new visit of a chapter (back, replay)
  const [dir, setDir] = useState<1 | -1>(1);
  const [paused, setPaused] = useState(false);
  const [holding, setHolding] = useState(false);
  const halted = paused || holding;
  const fill = useValue(still ? 1 : 0);
  const chrome = useValue(1);
  const enter = useValue(1);
  const [burst, setBurst] = useState({n: 0, x: 0, y: 0, count: 16});
  const shareRef = useRef<ShareCardHandle>(null);

  // the tab bar steps aside while the story is up
  useEffect(() => {
    setTabBarShown(false);
    return () => setTabBarShown(true);
  }, []);

  const go = useCallback(
    (i: number, d: 1 | -1) => {
      if (i >= chapters.length) return; // (the finale holds)
      const to = Math.max(0, i);
      setDir(d);
      setAt(to);
      setVisit(v => v + 1);
      setPaused(false);
    },
    [chapters.length],
  );
  const goRef = useRef(go);
  goRef.current = go;

  // ---- the clock of this visit ----
  // (made as the visit is drawn, not in an effect: a chapter's own effects run before this
  // screen's, and the times they ask for must land on this visit's clock, not the last one's)
  const id = chapters[at];
  const info = infos[at];
  const clockOf = useRef({visit: -1, clock: new Clock()});
  const prog = useRef({base: 0, since: 0, ms: 0});
  if (clockOf.current.visit !== visit) {
    clockOf.current.clock.stop();
    clockOf.current = {visit, clock: new Clock()};
    prog.current = {base: 0, since: Date.now(), ms: info.ms};
  }
  const clock = {current: clockOf.current.clock};
  useEffect(() => () => clockOf.current.clock.stop(), []);
  useEffect(() => {
    if (!still) {
      enter.setValue(0);
      tween(enter, 1, 420, {easing: EASE}).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visit]);

  // the segment fills; when it is full the story moves on (not still, not the finale)
  useEffect(() => {
    if (still || info.hold) {
      fill.setValue(1);
      return;
    }
    const p = prog.current;
    if (halted) {
      clock.current.pause();
      p.base = Math.min(1, p.base + (Date.now() - p.since) / Math.max(1, p.ms));
      p.since = Date.now();
      fill.stopAnimation();
      fill.setValue(p.base);
      return;
    }
    clock.current.resume();
    p.since = Date.now();
    fill.setValue(p.base);
    const a = tween(fill, 1, Math.max(60, info.ms * (1 - p.base)), {easing: LINEAR});
    a.start(({finished}) => {
      if (finished) goRef.current(at + 1, 1);
    });
    return () => a.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visit, halted, still]);

  useEffect(() => {
    tween(chrome, holding ? 0 : 1, holding ? 200 : 260).start();
  }, [holding, chrome]);

  // Android's Back closes the story (the page is underneath)
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  // ---- the finger ----
  const touch = useRef({t0: 0, x0: 0, hold: null as ReturnType<typeof setTimeout> | null, held: false});
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: e => {
          const t = touch.current;
          t.t0 = Date.now();
          t.x0 = e.nativeEvent.pageX;
          t.held = false;
          if (t.hold) clearTimeout(t.hold);
          t.hold = setTimeout(() => {
            t.held = true;
            setHolding(true);
          }, 260);
        },
        onPanResponderMove: (_e, g) => {
          const t = touch.current;
          if (!t.held && t.hold && (Math.abs(g.dx) > 12 || Math.abs(g.dy) > 12)) {
            clearTimeout(t.hold);
            t.hold = null;
          }
        },
        onPanResponderRelease: (_e, g) => {
          const t = touch.current;
          if (t.hold) clearTimeout(t.hold);
          t.hold = null;
          if (t.held) {
            t.held = false;
            setHolding(false);
            return;
          }
          const sw = swipeOf(g.dx, g.dy);
          if (sw === 'close') return onClose();
          if (sw === 'next') return goRef.current(atRef.current + 1, 1);
          if (sw === 'back') return goRef.current(atRef.current - 1, -1);
          if (Math.abs(g.dx) < 14 && Math.abs(g.dy) < 14) {
            const step = tapStep(t.x0, width);
            goRef.current(atRef.current + step, step);
          }
        },
        onPanResponderTerminate: () => {
          const t = touch.current;
          if (t.hold) clearTimeout(t.hold);
          t.hold = null;
          t.held = false;
          setHolding(false);
        },
      }),
    [onClose, width],
  );
  const atRef = useRef(at);
  atRef.current = at;

  // ---- sharing the picture ----
  const share = useCallback(async () => {
    const words = shareWords(c);
    const png = await shareRef.current?.png();
    if (!png) {
      showToast("Couldn't draw the picture", '⚠️');
      return;
    }
    const ok = await phoneNative.sharePicture(png, words.file, words.title, words.text);
    if (!ok) Share.share({message: words.text, title: words.title}).catch(() => {});
  }, [c]);

  const top = insets.top + 12;
  const stageTop = top + 3 + 14 + 44 + 14;
  const stageBottom = Math.max(insets.bottom, 12) + 16;
  const stageW = width - 48;
  const stageH = height - stageTop - stageBottom;
  const cardW = Math.min(240, Math.round(stageW * 0.62), Math.round((stageH * 0.56 * 1080) / 1920));

  const api: ChapterApi = {
    still,
    at: (ms, fn) => clock.current.at(ms, fn),
    width: stageW,
    height: stageH,
    burst: (x, y, count = 16) => setBurst(b => ({n: b.n + 1, x: x + 24, y: y + stageTop, count})),
    haptic: (k = 'tick') => phoneNative.haptic(k),
    replay: () => go(0, -1),
    closeStory: onClose,
    share,
    shareCard: <ShareCard ref={shareRef} c={c} width={cardW} poster={poster} />,
  };

  return (
    <View style={[StyleSheet.absoluteFill, ss.root]} {...responder.panHandlers} accessibilityViewIsModal>
      <PlayRoom calm={still} />
      <Animated.View
        key={`${at}:${visit}`}
        style={[
          ss.stage,
          {
            top: stageTop,
            bottom: stageBottom,
            opacity: enter,
            transform: [{translateX: enter.interpolate({inputRange: [0, 1], outputRange: [dir * 26, 0]})}],
          },
        ]}>
        <ChapterView id={id} c={c} api={api} />
      </Animated.View>
      <Burst fire={burst.n} x={burst.x} y={burst.y} count={burst.count} calm={still} reach={Math.max(width, height) * 0.62} />
      {/* the frame */}
      <Animated.View style={[ss.frame, {top, opacity: chrome}]} pointerEvents={holding ? 'none' : 'box-none'}>
        <View style={ss.segs} importantForAccessibility="no-hide-descendants">
          {chapters.map((ch, i) => (
            <View key={ch} style={ss.seg}>
              {i < at ? <View style={ss.segFull} /> : i === at ? <Animated.View style={[ss.segFull, {transformOrigin: '0% 50%', transform: [{scaleX: fill}]}]} /> : null}
            </View>
          ))}
        </View>
        <View style={ss.bar}>
          <View style={ss.who}>
            <View style={ss.dot}>
              <Star size={13} color={PLAY.goldInk} />
            </View>
            <Text style={ss.whoName} numberOfLines={1}>
              {c.name}
            </Text>
          </View>
          <View style={ss.tools}>
            {still || info.hold ? null : (
              <RoundKey
                uiId="story.pause"
                label={paused ? 'Play' : 'Pause'}
                onPress={() => setPaused(p => !p)}
                glyph={paused ? <Text style={ss.glyph}>▶</Text> : <View style={ss.pause}><View style={ss.pauseBar} /><View style={ss.pauseBar} /></View>}
              />
            )}
            {info.hold ? null : (
              <Key
                uiId="story.skip"
                small
                label="Skip"
                accessibilityLabel="Skip to the summary"
                onPress={() => go(chapters.length - 1, 1)}
                calm={still}
              />
            )}
            <RoundKey uiId="story.close" label="Close" onPress={onClose} glyph="✕" />
          </View>
        </View>
      </Animated.View>
      {/* for a screen reader: where we are, and the way on and back */}
      <Text style={ss.sr} accessibilityLiveRegion="polite">
        {announce(c, at)}
      </Text>
      <View style={ss.srKeys}>
        <Text accessibilityRole="button" accessibilityLabel="Previous chapter" onPress={() => go(at - 1, -1)} style={ss.srKey}>
          {' '}
        </Text>
        <Text accessibilityRole="button" accessibilityLabel="Next chapter" onPress={() => go(at + 1, 1)} style={ss.srKey}>
          {' '}
        </Text>
      </View>
    </View>
  );
}

const ss = StyleSheet.create({
  root: {zIndex: 50, backgroundColor: PLAY.night0},
  stage: {position: 'absolute', left: 24, right: 24},
  frame: {position: 'absolute', left: 0, right: 0, paddingHorizontal: 22},
  segs: {flexDirection: 'row', gap: 4},
  seg: {flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden'},
  segFull: {position: 'absolute', left: 0, top: 0, bottom: 0, right: 0, backgroundColor: '#ffffff', borderRadius: 2},
  bar: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, gap: 10},
  who: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 5, paddingRight: 14, height: 38, borderRadius: 999, borderWidth: 1, borderColor: PLAY.line, backgroundColor: 'rgba(255,255,255,0.07)', flexShrink: 1},
  dot: {width: 27, height: 27, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: PLAY.gold, experimental_backgroundImage: 'linear-gradient(135deg, #fff2c2 0%, #ffd166 45%, #f0a23a 100%)'},
  whoName: {color: PLAY.ink, fontSize: 15, fontWeight: '800', flexShrink: 1},
  tools: {flexDirection: 'row', alignItems: 'center', gap: 8},
  glyph: {color: PLAY.ink, fontSize: 15, marginLeft: 2},
  pause: {flexDirection: 'row', gap: 4},
  pauseBar: {width: 4, height: 14, borderRadius: 1.5, backgroundColor: PLAY.ink},
  sr: {position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0},
  srKeys: {position: 'absolute', left: 0, bottom: 0, flexDirection: 'row', opacity: 0},
  srKey: {width: 2, height: 2},
});
