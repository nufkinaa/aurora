// Taste — the website's swipe picker (#/taste), for the remote.
//
//   ◀ LEFT   Not for me
//   ▶ RIGHT  Love            (OK on the card is Love too)
//   ▼ DOWN   Haven't seen
//   ▲ UP     to Undo / Done
//
// One poster at a time with what it is beside it. Every answer is saved the
// moment it is given (the server keeps the three answers per profile: Love is
// the liked-titles list everything already reads, "Not for me" a light
// negative signal, "Haven't seen" only "do not ask again"), and its reply
// brings the next cards, chosen knowing it (src/media/tastedeck.js).
// tasteSession.ts holds the bookkeeping; this file draws it.
//
// THE REMOTE. The card is the one focusable on the page's middle band and sits
// in a TVFocusGuideView that traps LEFT, RIGHT and DOWN, so those presses move
// no native focus at all and arrive here as answers; UP is left free and
// reaches the toolbar. A press that only just ARRIVED on the card (DOWN from
// the toolbar) is not an answer (focus.ts pressMovedFocus).
//
// Motion: transform + opacity on the native driver, nothing that changes
// layout. A lite box (perfTier) and "Remove animations" (Android
// accessibility) get a short fade instead of the flight.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AccessibilityInfo, ActivityIndicator, Animated, Easing, Image, StyleSheet, Text, TVFocusGuideView, View} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Focusable from '../components/Focusable';
import Btn from '../components/Btn';
import {api, artPath, artPx, imgSrc} from '../api';
import {useApp} from '../AppContext';
import {useRouteShown} from '../useRouteShown';
import {noteOwnFocusMove, pressMovedFocus, useFocusFallback, useTVKeys} from '../focus';
import {artForget, artIdle} from '../artPrefetch';
import {isLite} from '../perfTier';
import {showToast} from '../toast';
import {uiHit} from '../telemetry'; // [analytics]
import {KEEP, leavingAfter, TasteCard, TasteSession, Verdict, verdictForKey} from '../tasteSession';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, radius} = theme;
const LABEL: Record<Verdict, string> = {love: 'Love', nope: 'Not for me', skip: "Haven't seen"};

const posterOf = (c: TasteCard | null, w: number) =>
  c && c.poster ? imgSrc(artPath(c.poster, artPx(w)) || c.poster) : null;

type Leaving = {card: TasteCard; verdict: Verdict; n: number};

export default function Taste({navigation}: NativeStackScreenProps<RootStackParamList, 'Taste'>) {
  const {profileId} = useApp();
  const {height, safeBottom} = useTvMetrics();
  const session = useRef(new TasteSession()).current;
  const [, setTick] = useState(0);
  const repaint = useCallback(() => setTick(t => t + 1), []);
  const [loaded, setLoaded] = useState<'loading' | 'ok' | 'failed'>('loading');
  useRouteShown(loaded !== 'loading');
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const busy = useRef<Promise<unknown>>(Promise.resolve());
  const cardFocused = useRef(false);
  const cardRef = useRef<View>(null);
  // focus that falls off something that went away lands on the card
  useFocusFallback(cardRef as never);

  // the card's size: two thirds of the band's height, 2:3
  const cardH = Math.round(height * 0.6);
  const cardW = Math.round((cardH * 2) / 3);

  const calm = useRef(isLite());
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then(on => {
        if (on) calm.current = true;
      })
      .catch(() => {});
  }, []);

  // ---------- the first cards ----------
  useEffect(() => {
    let live = true;
    api
      .tasteDeck(profileId, KEEP + 2)
      .then(r => {
        if (!live) return;
        session.goal = r.goal || session.goal;
        session.more = r.more || session.more;
        session.take(r.cards);
        setLoaded('ok');
      })
      .catch(() => live && setLoaded('failed'));
    return () => {
      live = false;
      artForget('taste');
    };
  }, [profileId, session]);

  // the pictures of the cards after the next one, while the remote rests
  const warm = useCallback(() => {
    artIdle('taste', () => session.queue.slice(1, KEEP).map(c => posterOf(c, cardW)));
  }, [session, cardW]);

  // ---------- motion ----------
  const out = useRef(new Animated.Value(0)).current; // the leaving card: 0 → 1
  const flights = useRef(0); // numbers each flight (Leaving.n)
  const pop = useRef(new Animated.Value(1)).current; // the arriving card: 0 → 1
  const fly = useCallback(
    (verdict: Verdict, card: TasteCard) => {
      out.stopAnimation();
      out.setValue(0);
      const n = ++flights.current;
      setLeaving({card, verdict, n});
      Animated.timing(out, {
        toValue: 1,
        duration: calm.current ? 140 : 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        // Finished OR cut short: this flight's card goes either way. The answer
        // that ends a round swaps the band for the round's end before the
        // flight is over, the native animation stops with finished=false, and
        // the card used to stay set — "Keep going" then drew it frozen half
        // way over the next card (Mi TV, 2026-10-18). A newer flight has its
        // own n and is left alone (leavingAfter, tasteSession.ts).
        setLeaving(l => leavingAfter(l, n));
      });
      pop.stopAnimation();
      pop.setValue(0);
      Animated.timing(pop, {toValue: 1, duration: calm.current ? 120 : 240, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
    },
    [out, pop],
  );

  // ---------- answering ----------
  const answer = useCallback(
    (verdict: Verdict) => {
      const entry = session.answer(verdict);
      if (!entry) return;
      fly(verdict, entry.card);
      repaint();
      const queued = session.queuedIds(2);
      busy.current = busy.current.then(async () => {
        try {
          const r = await api.tasteAnswer(profileId, {
            imdbId: entry.card.imdbId,
            id: entry.card.id,
            title: entry.card.title,
            verdict,
            queued,
            n: KEEP - 2,
          });
          session.settle(entry, r.was || null);
          session.take(r.cards, true);
        } catch {
          if (session.fail(entry)) showToast("Couldn't save that answer — try again", '⚠️');
        }
        repaint();
        warm();
      });
    },
    [session, fly, repaint, profileId, warm],
  );

  const undo = useCallback(() => {
    const last = session.undo();
    if (!last) return;
    pop.setValue(0);
    Animated.timing(pop, {toValue: 1, duration: calm.current ? 120 : 260, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
    repaint();
    // back to the card it brought back (Undo was pressed up in the toolbar)
    setTimeout(() => {
      const node = cardRef.current as unknown as {requestTVFocus?: () => void} | null;
      if (node?.requestTVFocus) {
        noteOwnFocusMove();
        node.requestTVFocus();
      }
    }, 0);
    busy.current = busy.current
      .then(() => api.tasteAnswer(profileId, {imdbId: last.card.imdbId, id: last.card.id, title: last.card.title, verdict: last.was}))
      .catch(() => showToast("Couldn't undo that one", '⚠️'));
  }, [session, pop, repaint, profileId]);

  const keepGoing = useCallback(() => {
    setLeaving(null); // nothing of the last round is still on its way out
    // The round's last answer started the next card's arrival, then the round's
    // end unmounted it half way: on the native driver the value stayed there and
    // Keep going showed that card dim and small (Mi TV, 2026-10-18). It arrives now.
    pop.stopAnimation();
    pop.setValue(0);
    Animated.timing(pop, {toValue: 1, duration: calm.current ? 120 : 240, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
    session.keepGoing();
    repaint();
    if (session.queue.length < 2) {
      api
        .tasteDeck(profileId, KEEP - session.queue.length, session.queuedIds(KEEP))
        .then(r => {
          session.take(r.cards);
          repaint();
        })
        .catch(() => showToast("Couldn't load more titles", '⚠️'));
    }
  }, [session, repaint, profileId, pop]);

  const done = useCallback(() => navigation.goBack(), [navigation]);

  // ---------- the remote ----------
  useTVKeys(
    useCallback(
      (evt: {eventType: string}) => {
        if (!cardFocused.current || session.roundOver) return;
        // not the release of the press that carried focus onto the card
        if (pressMovedFocus()) return;
        const v = verdictForKey(evt.eventType);
        if (!v) return;
        uiHit(v === 'love' ? 'taste.love' : v === 'nope' ? 'taste.nope' : 'taste.skip'); // [analytics]
        answer(v);
      },
      [answer, session],
    ),
  );

  // ---------- drawing ----------
  const cur = session.current;
  const next = session.behind;
  const over = loaded === 'ok' && session.roundOver;
  const curSrc = useMemo(() => posterOf(cur, cardW), [cur, cardW]);
  const nextSrc = useMemo(() => posterOf(next, cardW), [next, cardW]);
  const meta = cur ? [cur.year, cur.type === 'show' ? 'Series' : 'Film', ...(cur.genres || []).slice(0, 2)].filter(Boolean).join(' · ') : '';
  const shown = Math.min(session.answered, session.goal);

  const leaveStyle = leaving
    ? (() => {
        const dir = leaving.verdict === 'love' ? 1 : leaving.verdict === 'nope' ? -1 : 0;
        if (calm.current) return {opacity: out.interpolate({inputRange: [0, 1], outputRange: [1, 0]})};
        return {
          opacity: out.interpolate({inputRange: [0, 0.7, 1], outputRange: [1, 0.8, 0]}),
          transform: [
            {translateX: out.interpolate({inputRange: [0, 1], outputRange: [0, dir * cardW * 2.2]})},
            {translateY: out.interpolate({inputRange: [0, 1], outputRange: [0, dir ? -cardH * 0.08 : cardH * 1.1]})},
            {rotate: out.interpolate({inputRange: [0, 1], outputRange: ['0deg', `${dir * 18}deg`]})},
          ],
        };
      })()
    : null;
  const popStyle = {
    opacity: pop.interpolate({inputRange: [0, 1], outputRange: [0.4, 1]}),
    transform: calm.current ? [] : [{scale: pop.interpolate({inputRange: [0, 1], outputRange: [0.94, 1]})}],
  };

  return (
    <View style={[styles.root, {paddingBottom: safeBottom}]}>
      <View style={styles.head}>
        <View style={styles.titles}>
          <Text style={styles.h1}>What's your taste?</Text>
          <View style={styles.progress}>
            <View style={styles.bar}>
              <View style={[styles.barFill, {width: `${Math.round(100 * session.progress)}%`}]} />
            </View>
            <Text style={styles.count}>
              {shown} / {session.goal}
            </Text>
          </View>
        </View>
        <View style={styles.toolbar}>
          {/* always there (dim when there is nothing to undo): a button that
              vanished under the focus would drop it */}
          <Btn uiId="taste.undo" small dim={!session.history.length} label="↶ Undo" onPress={undo} />
          <Btn uiId="taste.done" small primary label="Done" onPress={done} />
        </View>
      </View>

      {loaded === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.text} />
        </View>
      ) : loaded === 'failed' ? (
        <View style={styles.center}>
          <Text style={styles.endText}>Couldn't load titles — try again in a moment.</Text>
        </View>
      ) : over ? (
        <View style={styles.center}>
          <Text style={styles.endGlyph}>{session.exhausted && !session.queue.length ? '🎬' : '✨'}</Text>
          <Text style={styles.endTitle}>
            {session.exhausted && !session.queue.length
              ? "That's every title we had for you"
              : `${session.answered} answers — Home is already using them`}
          </Text>
          <Text style={styles.endText}>
            ♥ {session.tally.love} loved · ✕ {session.tally.nope} not for you · {session.tally.skip} not seen
          </Text>
          <View style={styles.endActions}>
            {session.exhausted && !session.queue.length ? null : (
              <Btn uiId="taste.more" label="Keep going" hasTVPreferredFocus onPress={keepGoing} />
            )}
            <Btn uiId="taste.done" primary label="Done" hasTVPreferredFocus={session.exhausted && !session.queue.length} onPress={done} />
          </View>
        </View>
      ) : (
        <View style={styles.band}>
          <View style={{width: cardW, height: cardH}}>
            {next ? (
              <View style={[styles.card, styles.behind, {width: cardW, height: cardH}]}>
                {nextSrc ? <Image source={nextSrc} style={styles.poster} resizeMode="cover" fadeDuration={0} /> : null}
              </View>
            ) : null}
            <TVFocusGuideView trapFocusLeft trapFocusRight trapFocusDown style={StyleSheet.absoluteFill}>
              {cur ? (
                <Focusable
                  ref={cardRef}
                  uiId="taste.love"
                  hasTVPreferredFocus
                  scaleTo={1.02}
                  accessibilityLabel={`${cur.title}. Left: not for me. Right or OK: love. Down: haven't seen.`}
                  onFocusChange={f => {
                    cardFocused.current = f;
                  }}
                  onPress={() => answer('love')}
                  style={[styles.card, {width: cardW, height: cardH}]}>
                  <Animated.View style={[StyleSheet.absoluteFill, popStyle]}>
                    {curSrc ? (
                      <Image source={curSrc} style={styles.poster} resizeMode="cover" fadeDuration={0} />
                    ) : (
                      <View style={styles.fallback}>
                        <Text style={styles.fallbackText}>{cur.title}</Text>
                      </View>
                    )}
                  </Animated.View>
                </Focusable>
              ) : (
                <View style={[styles.card, styles.center, {width: cardW, height: cardH}]}>
                  <ActivityIndicator color={colors.text} />
                </View>
              )}
            </TVFocusGuideView>
            {leaving ? (
              <Animated.View pointerEvents="none" style={[styles.card, styles.leaving, {width: cardW, height: cardH}, leaveStyle]}>
                {posterOf(leaving.card, cardW) ? (
                  <Image source={posterOf(leaving.card, cardW)!} style={styles.poster} resizeMode="cover" fadeDuration={0} />
                ) : null}
                <View style={[styles.stamp, leaving.verdict === 'love' ? styles.stampLove : leaving.verdict === 'nope' ? styles.stampNope : styles.stampSkip]}>
                  <Text style={[styles.stampText, {color: leaving.verdict === 'love' ? LOVE : leaving.verdict === 'nope' ? NOPE : SKIP}]}>
                    {leaving.verdict === 'love' ? 'LOVE' : leaving.verdict === 'nope' ? 'NOPE' : "HAVEN'T SEEN"}
                  </Text>
                </View>
              </Animated.View>
            ) : null}
          </View>

          <View style={styles.info}>
            {cur ? (
              <>
                <Text style={styles.title} numberOfLines={2}>
                  {cur.title}
                </Text>
                {meta ? <Text style={styles.meta}>{meta}</Text> : null}
                {cur.line ? (
                  <Text style={styles.line} numberOfLines={3}>
                    {cur.line}
                  </Text>
                ) : null}
              </>
            ) : null}
            <View style={styles.legend}>
              <LegendRow glyph="◀" color={NOPE} label={LABEL.nope} />
              <LegendRow glyph="▶" color={LOVE} label={`${LABEL.love}  ·  or OK`} />
              <LegendRow glyph="▼" color={SKIP} label={LABEL.skip} />
              <LegendRow glyph="▲" color={colors.textFaint} label="Undo · Done" />
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const LOVE = '#6ee7a8';
const NOPE = '#ff7b8a';
const SKIP = '#cfd5ff';

const LegendRow = React.memo(function LegendRow({glyph, color, label}: {glyph: string; color: string; label: string}) {
  return (
    <View style={styles.legendRow}>
      <View style={styles.legendKey}>
        <Text style={[styles.legendGlyph, {color}]}>{glyph}</Text>
      </View>
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  // No backgroundColor: the ambient canvas behind the navigator paints the page.
  root: {flex: 1, paddingHorizontal: spacing.pageX, paddingTop: spacing.pageY},
  head: {flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: spacing.lg},
  titles: {flexShrink: 1},
  h1: {color: colors.text, fontSize: fontSize.title, fontWeight: '900'},
  progress: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 6},
  bar: {width: 140, height: 4, borderRadius: 2, backgroundColor: colors.surfaceHover, overflow: 'hidden'},
  barFill: {height: 4, backgroundColor: colors.accent},
  count: {color: colors.textDim, fontSize: fontSize.small, fontVariant: ['tabular-nums']},
  toolbar: {flexDirection: 'row', gap: spacing.sm},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm},
  band: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xl},
  card: {
    position: 'absolute',
    left: 0,
    top: 0,
    borderRadius: radius.l,
    overflow: 'hidden',
    backgroundColor: colors.bgRaised,
  },
  behind: {opacity: 0.45, transform: [{translateY: 10}, {scale: 0.94}]},
  leaving: {},
  poster: {width: '100%', height: '100%'},
  fallback: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg},
  fallbackText: {color: colors.textDim, fontSize: fontSize.row, fontWeight: '800', textAlign: 'center'},
  stamp: {position: 'absolute', top: 18, paddingHorizontal: 10, paddingVertical: 3, borderWidth: 3, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.25)'},
  stampLove: {left: 14, borderColor: LOVE, transform: [{rotate: '-12deg'}]},
  stampNope: {right: 14, borderColor: NOPE, transform: [{rotate: '12deg'}]},
  stampSkip: {left: 14, right: 14, top: '42%', alignItems: 'center', borderColor: SKIP},
  stampText: {fontSize: fontSize.row, fontWeight: '900', letterSpacing: 1},
  info: {width: 360, justifyContent: 'center'},
  title: {color: colors.text, fontSize: fontSize.title, fontWeight: '800'},
  meta: {color: colors.textDim, fontSize: fontSize.body, fontWeight: '600', marginTop: 4},
  line: {color: colors.textDim, fontSize: fontSize.body, marginTop: spacing.sm, lineHeight: 21},
  legend: {marginTop: spacing.xl, gap: spacing.sm},
  legendRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  legendKey: {width: 34, height: 34, borderRadius: 17, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center'},
  legendGlyph: {fontSize: 15, fontWeight: '900'},
  legendLabel: {color: colors.text, fontSize: fontSize.body, fontWeight: '600'},
  endGlyph: {fontSize: 40},
  endTitle: {color: colors.text, fontSize: fontSize.row, fontWeight: '800', textAlign: 'center'},
  endText: {color: colors.textDim, fontSize: fontSize.body, textAlign: 'center'},
  endActions: {flexDirection: 'row', gap: spacing.md, marginTop: spacing.md},
});
