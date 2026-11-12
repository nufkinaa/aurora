// Aurora Wrapped — the profile's year as a story, for the remote, in the
// Aurora Play look (docs/play/tv.md, docs/play/wrapped.md).
//
//   RIGHT / OK   the next chapter
//   LEFT         the chapter before (on the first one: nothing)
//   PLAY/PAUSE   hold the story / go on
//   BACK         leaves, in one press (the system's own)
//
// One chapter at a time fills the screen; the row at the top has a segment
// per chapter and the current one fills over the chapter's time, then the
// story moves on by itself — never past the finale. The finale has two real
// keys, "Watch again" and "Done".
//
// WHO DOES WHAT. play/wrappedRules.ts decides which chapters a year has and
// what the numbers mean (the website's rules); play/wrapped/story.ts turns
// them into words and says when each piece of a chapter arrives (its beats);
// play/wrapped/Chapters.tsx draws a chapter at a beat. This file keeps the
// clock, the remote and the focus — nothing else.
//
// THE CLOCK is timers, never the end of an animation: one timer per beat, one
// for the move to the next chapter, and ONE native-driven value for the
// segment that fills. Holding the story cancels the timers, stops the value
// where it is and remembers how far the chapter was; going on plays the rest.
// Nothing runs while another screen is in front, and nothing after unmount.
//
// THE REMOTE. While a chapter is on, exactly one thing can hold focus: a
// focusable the size of the screen, with no ring, in a guide that traps all
// four directions — so no press moves native focus and LEFT / RIGHT arrive
// here as "back" / "next". OK is that focusable's own press (the one path
// for OK). On the finale it gives way to the two keys, and LEFT / RIGHT are
// the platform's again: they only move between the keys.
//
// CALM (a weak box, or "Remove animations"): no clock at all. Every chapter
// is complete and still, the row shows whole segments, there is no burst,
// and the story moves only when a key says so.
//
// An account in Children mode (or an old kids profile) gets kind words instead
// of the roast: "The highlights". Whether it is in Children mode is asked
// together with the numbers, and the story does not start before
// both have answered; a profile that cannot be read gets the kind words.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Animated, StyleSheet, Text, TVFocusGuideView, View} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Focusable from '../components/Focusable';
import {ErrorState} from '../components/States';
import {apiRequest} from '../api';
import {useApp} from '../AppContext';
import {useRouteShown} from '../useRouteShown';
import {noteOwnFocusMove, pressMovedFocus, useFocusFallback, useTVKeys} from '../focus';
import {loadMe} from '../navSection';
import {limitOf} from '../childMode';
import {uiHit} from '../telemetry'; // [analytics]
import {RootStackParamList} from '../navigation';
import {useTvMetrics} from '../theme';
import {LINEAR, tween, useCalm, useInFront, useTimers} from '../play/anim';
import Burst from '../play/Burst';
import PlayKey from '../play/PlayKey';
import Room from '../play/Room';
import {Star} from '../play/Star';
import {PLAY} from '../play/tokens';
import type {WrappedStats} from '../play/wrappedRules';
import ChapterView, {FRAME, typeCardCentre} from '../play/wrapped/Chapters';
import {ProgressRow, ty, useShow} from '../play/wrapped/parts';
import {ALL, BURST_BEAT, chapterName, planOf, storyOf} from '../play/wrapped/story';

type Load =
  | {status: 'loading'}
  | {status: 'failed'}
  | {status: 'ok'; stats: WrappedStats | null; name: string; kids: boolean};

type FocusNode = {requestTVFocus?: () => void} | null;

// One chapter's page: comes in once, when it is mounted (the screen gives
// every chapter of every run its own key). It covers the whole screen and
// keeps the gutters as padding, so nothing a chapter draws past its own box
// is cut while the page is still coming in.
function Page({calm, children}: {calm: boolean; children: React.ReactNode}) {
  const v = useShow(true, {ms: 300, calm});
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[st.pageBox, {opacity: v, transform: [{translateY: v.interpolate({inputRange: [0, 1], outputRange: [10, 0]})}]}]}>
      {children}
    </Animated.View>
  );
}

export default function Wrapped({navigation}: NativeStackScreenProps<RootStackParamList, 'Wrapped'>) {
  const {profileId} = useApp();
  const {width, height} = useTvMetrics();
  const calm = useCalm();
  const inFront = useInFront(navigation as never);
  const timers = useTimers();

  // ---------- the numbers, and who they are about ----------
  const [load, setLoad] = useState<Load>({status: 'loading'});
  const [at, setAt] = useState({idx: 0, beat: 0});
  const [held, setHeld] = useState(false);
  const [run, setRun] = useState(0); // a "Watch again" is a new run
  const [fire, setFire] = useState(0); // the burst: once per run
  const fired = useRef(false);
  const ask = useRef(0);
  const ask1 = useCallback(() => {
    const id = ++ask.current;
    setLoad({status: 'loading'});
    Promise.all([apiRequest<WrappedStats>(`/api/profiles/${encodeURIComponent(profileId)}/wrapped`), loadMe(profileId)])
      .then(([stats, me]) => {
        if (ask.current !== id) return;
        fired.current = false;
        setHeld(false);
        setAt({idx: 0, beat: 0});
        // (a profile that could not be read is told the kind words: a roast must never reach a child)
        setLoad({status: 'ok', stats: stats || null, name: (me && me.name) || '', kids: me ? limitOf(me) !== null : true});
      })
      .catch(() => {
        if (ask.current === id) setLoad({status: 'failed'});
      });
  }, [profileId]);
  useEffect(() => {
    ask1();
    const asks = ask; // (the counter itself, not a node: it is meant to be read late)
    return () => {
      asks.current++; // an answer that comes after the screen has gone is dropped
    };
  }, [ask1]);
  useRouteShown(load.status !== 'loading');

  const story = useMemo(
    () => (load.status === 'ok' && load.stats && !load.stats.empty ? storyOf(load.stats, load.name, load.kids) : null),
    [load],
  );
  const count = story ? story.chapters.length : 0;
  const last = count - 1;
  const idx = Math.max(0, Math.min(at.idx, last));
  const chapter = story ? story.chapters[idx] : null;
  const onFinale = chapter === 'finale';
  const plan = useMemo(() => (story && chapter ? planOf(chapter, story) : null), [story, chapter]);
  // which thing owns the focus: the page (also while loading), the finale's keys, the empty page's key, the error's
  const mode = load.status === 'failed' ? 'error' : load.status === 'loading' ? 'page' : !story ? 'empty' : onFinale ? 'finale' : 'page';

  // the row's segments: one value each, made once and kept
  const segs = useRef<Animated.Value[]>([]).current;
  while (segs.length < count) segs.push(new Animated.Value(0));

  // ---------- moving through the story ----------
  const where = useRef({idx: 0, last: 0});
  where.current = {idx, last};
  const next = useCallback(() => {
    if (where.current.idx >= where.current.last) return;
    setHeld(false);
    setAt(a => ({idx: Math.min(where.current.last, a.idx + 1), beat: 0}));
  }, []);
  const prev = useCallback(() => {
    if (where.current.idx <= 0) return;
    setHeld(false);
    setAt(a => ({idx: Math.max(0, a.idx - 1), beat: 0}));
  }, []);
  const again = useCallback(() => {
    fired.current = false;
    setHeld(false);
    setRun(r => r + 1);
    setAt({idx: 0, beat: 0});
  }, []);
  const done = useCallback(() => navigation.goBack(), [navigation]);

  // ---------- the clock ----------
  const running = !!story && !!plan && plan.ms > 0 && inFront && !held && !calm;
  const clock = useRef({key: '', elapsed: 0});
  useEffect(() => {
    if (!story || !plan || !chapter) return;
    const key = `${run}:${idx}`;
    if (clock.current.key !== key) clock.current = {key, elapsed: 0};
    for (let i = 0; i < count; i++) {
      if (i !== idx) segs[i].setValue(i < idx ? 1 : 0);
    }
    const seg = segs[idx];
    // no clock under calm, none on the finale: a whole segment
    if (calm || plan.ms <= 0) {
      seg.setValue(1);
      return;
    }
    const elapsed = Math.min(plan.ms, clock.current.elapsed);
    seg.setValue(elapsed / plan.ms);
    if (!running) return;
    const started = Date.now();
    const offs: (() => void)[] = [];
    plan.beats.forEach((t, k) => {
      const beat = k + 1;
      offs.push(
        timers.after(Math.max(0, t - elapsed), () => {
          // the one reward: when the viewer-type card has turned, once per run
          if (chapter === 'type' && beat === BURST_BEAT && !fired.current) {
            fired.current = true;
            setFire(n => n + 1);
          }
          setAt(a => (a.idx === idx && a.beat < beat ? {idx, beat} : a));
        }),
      );
    });
    offs.push(timers.after(Math.max(0, plan.ms - elapsed), next));
    const fill = tween(seg, 1, Math.max(1, plan.ms - elapsed), {easing: LINEAR});
    fill.start();
    return () => {
      if (clock.current.key === key) clock.current.elapsed += Date.now() - started;
      for (const off of offs) off();
      seg.stopAnimation();
    };
  }, [story, plan, chapter, running, calm, idx, run, count, segs, timers, next]);

  // ---------- focus ----------
  // One ref for whatever owns the focus now: the page while a chapter is on,
  // "Done" on the finale and on the empty page. When the owner changes, the
  // new one is asked to take it (announced, so it is not read as a key's move).
  const focusRef = useRef<FocusNode>(null);
  useFocusFallback(focusRef as never);
  const firstMode = useRef(true);
  useEffect(() => {
    if (firstMode.current) {
      firstMode.current = false; // the first owner is mounted with the focus
      return;
    }
    if (mode === 'error') return; // (the error state's own key takes it)
    noteOwnFocusMove();
    return timers.after(0, () => {
      const node = focusRef.current;
      if (node?.requestTVFocus) {
        noteOwnFocusMove();
        node.requestTVFocus();
      }
    });
  }, [mode, run, timers]);

  // ---------- the remote ----------
  // (OK is not here: it is the page's own press. UP and DOWN do nothing. BACK is the system's.)
  useTVKeys(
    useCallback(
      (evt: {eventType: string}) => {
        // not the release of the press that carried focus onto the page
        if (pressMovedFocus()) return;
        switch (evt.eventType) {
          case 'right':
            uiHit('story.next'); // [analytics]
            next();
            break;
          case 'left':
            if (where.current.idx > 0) {
              uiHit('story.prev'); // [analytics]
              prev();
            }
            break;
          case 'playPause':
            if (!calm) {
              uiHit('story.pause'); // [analytics]
              setHeld(h => !h);
            }
            break;
          case 'pause':
            if (!calm) setHeld(true);
            break;
          case 'play':
            setHeld(false);
            break;
        }
      },
      [next, prev, calm],
    ),
    {deaf: mode !== 'page' || !story},
  );

  // ---------- the page ----------
  const beat = calm ? ALL : at.beat;
  const boxW = width - FRAME.x * 2;
  const boxH = height - FRAME.top - FRAME.bottom;
  const centre = typeCardCentre(width, height);
  const name = story && chapter ? chapterName(chapter, story) : '';

  const keys = onFinale ? (
    <>
      <PlayKey uiId="wrapped.replay" label="Watch again" kind="glass" glyph="↺" onPress={again} />
      <PlayKey uiId="wrapped.done" ref={focusRef} label="Done" kind="aurora" hasTVPreferredFocus onPress={done} />
    </>
  ) : null;

  return (
    <View style={st.root}>
      <Room on={inFront} calm={calm} />

      {mode === 'page' ? (
        <TVFocusGuideView trapFocusUp trapFocusDown trapFocusLeft trapFocusRight style={StyleSheet.absoluteFill}>
          <Focusable
            ref={focusRef as never}
            uiId={story ? 'story.next' : undefined}
            ring="none"
            noScale
            hasTVPreferredFocus
            accessibilityLabel={story ? `${name}. Chapter ${idx + 1} of ${count}. Right or OK: next. Left: back.` : 'Your Aurora Wrapped'}
            onPress={next}
            style={StyleSheet.absoluteFill}>
            {null}
          </Focusable>
        </TVFocusGuideView>
      ) : null}

      {load.status === 'loading' ? (
        <View style={st.center} pointerEvents="none">
          <ActivityIndicator color={PLAY.ink} />
        </View>
      ) : null}

      {load.status === 'failed' ? (
        <View style={st.center}>
          <ErrorState
            message="Couldn't load your Wrapped."
            detail="Check that Aurora is on, then try again."
            actionLabel="Try again"
            edgeLeft={false}
            onAction={() => {
              uiHit('wrapped.retry'); // [analytics] (the state's own key is "state.action")
              ask1();
            }}
          />
        </View>
      ) : null}

      {mode === 'empty' ? (
        <View style={st.center} testID="wrapped.empty">
          <Star size={30} color={PLAY.green} />
          <Text style={[ty.title, ty.center, st.emptyTitle]} numberOfLines={2}>
            Your sky is just getting started
          </Text>
          <Text style={[ty.line, ty.center, st.emptyLine]} numberOfLines={2}>
            Watch a few things, and your year will be told here.
          </Text>
          <View style={st.emptyKey}>
            <PlayKey uiId="wrapped.done" ref={focusRef} label="Done" kind="aurora" hasTVPreferredFocus onPress={done} />
          </View>
        </View>
      ) : null}

      {story && chapter ? (
        <>
          <Page key={`${run}:${idx}`} calm={calm}>
            <ChapterView chapter={chapter} beat={beat} calm={calm} story={story} width={boxW} height={boxH} keys={keys} />
          </Page>
          <View style={st.progress} pointerEvents="none">
            <ProgressRow values={segs} count={count} width={boxW} label={`Chapter ${idx + 1} of ${count}`} />
          </View>
          {held && !onFinale && !calm ? (
            <View style={st.paused} pointerEvents="none" testID="wrapped.paused">
              <View style={st.pauseBars}>
                <View style={st.pauseBar} />
                <View style={st.pauseBar} />
              </View>
              <Text style={st.pausedText} numberOfLines={1}>
                Paused
              </Text>
            </View>
          ) : null}
          <Burst fire={fire} x={centre.x} y={centre.y} calm={calm} />
        </>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  root: {flex: 1, backgroundColor: PLAY.night0},
  center: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: FRAME.x},
  pageBox: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    paddingLeft: FRAME.x,
    paddingRight: FRAME.x,
    paddingTop: FRAME.top,
    paddingBottom: FRAME.bottom,
  },
  progress: {position: 'absolute', left: FRAME.x, top: 27},
  paused: {
    position: 'absolute',
    right: FRAME.x,
    top: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingVertical: 5,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: PLAY.pill,
    borderWidth: 1,
    borderColor: PLAY.line,
  },
  pauseBars: {flexDirection: 'row', gap: 4},
  pauseBar: {width: 4, height: 14, borderRadius: 1.5, backgroundColor: PLAY.ink},
  pausedText: {color: PLAY.ink, fontSize: 15, lineHeight: 21, fontWeight: '800', includeFontPadding: false},
  emptyTitle: {marginTop: 14},
  emptyLine: {marginTop: 8, maxWidth: 620},
  emptyKey: {marginTop: 24},
});
