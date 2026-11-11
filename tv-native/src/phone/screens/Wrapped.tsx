// "Your Aurora Wrapped" on the phone — the website's #/wrapped (public/js/screens/wrapped.js,
// docs/play/wrapped.md) in the play look: your viewing told as a STORY in the night sky
// (../play/WrappedStory.tsx: eleven chapters, each left out when its data is missing, the
// viewer-type collectible with the one meteor burst, the streak as a constellation, the
// intervention one line at a time, a share card), and under it "All the numbers" — every
// stat as plain text (../play/WrappedPage.tsx). Honest about its window ("since <date>": the
// server's session store is a ring buffer).
//
//   arriving     the story plays over the page (the page is drawn once it closes)
//   Remove animations / a screen reader: the page first; "Play the story" plays it still
//   nothing watched yet: the teaser (the face-down card, the chapters waiting)
//   kids profiles: the same story, kinder verdicts, "The highlights" instead of the roasts
//
// Words and rules: ../play/wrappedStory.ts (on the kit's ../../play/wrappedRules.ts).
// Server: GET /api/profiles/:id/wrapped (the roasts it sends, `w.roasts`, are used as sent).
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AccessibilityInfo, ActivityIndicator, ScrollView, Share, StyleSheet, Text, View} from 'react-native';
import {StackActions} from '@react-navigation/native';
import {apiRequest} from '../../api';
import {useApp} from '../../AppContext';
import {useMe} from '../../navSection';
import {navRef} from '../../rootNav';
import {showToast} from '../../toast';
import {isLite} from '../../perfTier';
import {phoneNative} from '../native';
import {BackBar, useColumn, usePageTop, useSolidBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import {setTab} from '../tabs';
import {GUTTER} from '../theme';
import {PLAY} from '../../play/tokens';
import {Eyebrow, Key, PlayRoom, ty} from '../play/ui';
import WrappedStory from '../play/WrappedStory';
import {WrappedNumbers, WrappedTeaser} from '../play/WrappedPage';
import {ShareCard, ShareCardHandle, usePosterData} from '../play/ShareCard';
import {ctxOf, ERR, PhoneWrapped, shareWords} from '../play/storyWords';

// "Back to browsing" / "Find something to watch": the site goes to #/ — Home
const toHome = () => {
  if (navRef.isReady() && navRef.canGoBack()) navRef.dispatch(StackActions.popToTop());
  setTab('home');
};

/** Whether the story should be still: Remove animations, a screen reader, a lite phone. null until known. */
const useStill = (): boolean | null => {
  const [still, setStill] = useState<boolean | null>(isLite() ? true : null);
  useEffect(() => {
    if (still !== null) return;
    let live = true;
    const ask = (f?: () => Promise<boolean>) => (f ? f.call(AccessibilityInfo).catch(() => false) : Promise.resolve(false));
    Promise.all([ask(AccessibilityInfo.isReduceMotionEnabled), ask(AccessibilityInfo.isScreenReaderEnabled)]).then(([calm, reader]) => {
      if (live) setStill(!!(calm || reader));
    });
    return () => {
      live = false;
    };
  }, [still]);
  return still;
};

export default function Wrapped() {
  const bar = useSolidBar();
  const top = usePageTop();
  const column = useColumn();
  const bottom = useTabBarSpace();
  const {profileId} = useApp();
  const me = useMe(profileId);
  const name = me?.name || '';
  const kids = !!me?.kids;
  const still = useStill();
  const [w, setW] = useState<PhoneWrapped | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(() => {
    setErr(false);
    setW(null);
    apiRequest<PhoneWrapped>(`/api/profiles/${encodeURIComponent(profileId)}/wrapped`)
      .then(setW)
      .catch(() => setErr(true));
  }, [profileId]);
  useEffect(load, [load]);

  const ctx = useMemo(() => (w && !w.empty && me ? ctxOf(w, name, kids) : null), [w, me, name, kids]);
  const poster = usePosterData(ctx ? (ctx.w.topTitles || [])[0]?.poster : null);

  // the story plays on arrival (not when still: the page first); the page is drawn once it closes
  const [story, setStory] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const decided = useRef(false);
  useEffect(() => {
    if (!ctx || still === null || decided.current) return;
    decided.current = true;
    if (still) setDrawn(true);
    else setStory(true);
  }, [ctx, still]);
  const closeStory = useCallback(() => {
    setStory(false);
    setDrawn(true);
  }, []);

  // the page's "Share the picture": the same card, drawn unseen
  const shareRef = useRef<ShareCardHandle>(null);
  const share = useCallback(async () => {
    if (!ctx) return;
    const words = shareWords(ctx);
    const png = await shareRef.current?.png();
    if (!png) return showToast("Couldn't draw the picture", '⚠️');
    const ok = await phoneNative.sharePicture(png, words.file, words.title, words.text);
    if (!ok) Share.share({message: words.text, title: words.title}).catch(() => {});
  }, [ctx]);

  let body: React.ReactNode;
  if (err) {
    body = (
      <View style={s.msg}>
        <Eyebrow>Aurora Wrapped</Eyebrow>
        <Text style={ty.lede}>{ERR.text}</Text>
        <Key uiId="phone.wrapped.retry" label={ERR.retry} onPress={load} />
      </View>
    );
  } else if (!w || (!w.empty && !me)) {
    body = <ActivityIndicator color={PLAY.ink} style={{marginTop: 30}} />;
  } else if (w.empty) {
    body = <WrappedTeaser name={name} onBrowse={toHome} />;
  } else if (ctx && drawn) {
    body = <WrappedNumbers c={ctx} onPlay={() => setStory(true)} onShare={share} onBrowse={toHome} />;
  } else {
    // (under a playing story: the screen holds its name, for a screen reader)
    body = (
      <Text style={s.sr} accessibilityRole="header">
        Aurora Wrapped
      </Text>
    );
  }

  return (
    <View style={s.root}>
      <PlayRoom calm={!!still} on={!story} />
      <ScrollView
        onScroll={bar.onScroll}
        scrollEventThrottle={32}
        contentContainerStyle={[{paddingTop: top, paddingBottom: bottom + 24, paddingHorizontal: GUTTER}, column]}>
        {body}
      </ScrollView>
      <BackBar solid={bar.solid} title={bar.solid ? 'Aurora Wrapped' : undefined} />
      {ctx && drawn && !story ? (
        <View style={s.unseen} pointerEvents="none" importantForAccessibility="no-hide-descendants">
          <ShareCard ref={shareRef} c={ctx} width={54} poster={poster} />
        </View>
      ) : null}
      {ctx && story ? <WrappedStory c={ctx} still={!!still} poster={poster} onClose={closeStory} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  msg: {alignItems: 'center', gap: 16, paddingTop: 40},
  sr: {height: 1, width: 1, opacity: 0},
  unseen: {position: 'absolute', left: 0, top: 0, opacity: 0},
});
