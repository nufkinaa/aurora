// Taste — "The Deck": the website's swipe picker (#/taste), for the remote, in
// the Aurora Play look (docs/play/tv.md).
//
//   ◀ LEFT   Not for me
//   ▶ RIGHT  Love it         (OK on the card is Love too)
//   ▼ DOWN   Haven't seen it
//   ▲ UP     to Undo / Done
//
// One card at a time, in the middle of the room, with the three answers
// standing where their keys are. Every answer is saved the moment it is given
// (the server keeps the three answers per profile: Love is the liked-titles
// list everything already reads, "Not for me" a light negative signal,
// "Haven't seen" only "do not ask again"), and its reply brings the next
// cards, chosen knowing it (src/media/tastedeck.js). tasteSession.ts holds the
// bookkeeping; this file draws it.
//
// THE REMOTE. The card is the one focusable on the page's middle band and sits
// in a TVFocusGuideView that traps LEFT, RIGHT and DOWN, so those presses move
// no native focus at all and arrive here as answers; UP is left free and
// reaches the toolbar. A press that only just ARRIVED on the card (DOWN from
// the toolbar) is not an answer (focus.ts pressMovedFocus). The answers beside
// the card are labels, not keys: the matching one lights when its key is
// pressed.
//
// THE GAME. A stamp is slammed on the card, the card is thrown to the answer's
// side, the next one rises (one native run). The ribbon at the top fills and a
// star lights at each quarter, with a remark about this sitting at the first
// three. The end of a round is the one reward: the loved titles as a
// constellation, the number in gold, the meteor burst — once per round.
//
// Motion: transform + opacity on the native driver, nothing that changes
// layout. A lite box (perfTier) and "Remove animations" (Android
// accessibility) get a short fade instead of the flight, and no burst.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Animated, Image, StyleSheet, Text, TVFocusGuideView, View} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Focusable from '../components/Focusable';
import {api, artPath, artPx, imgSrc} from '../api';
import {useApp} from '../AppContext';
import {useRouteShown} from '../useRouteShown';
import {noteOwnFocusMove, pressMovedFocus, useFocusFallback, useTVKeys} from '../focus';
import {artForget, artIdle} from '../artPrefetch';
import {showToast} from '../toast';
import {uiHit} from '../telemetry'; // [analytics]
import {KEEP, leavingAfter, TasteCard, TasteSession, Verdict, verdictForKey} from '../tasteSession';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';
import {EASE, LINEAR, tween, useCalm, useInFront, useTimers, useValue} from '../play/anim';
import Burst from '../play/Burst';
import {Answer, Plates, Shade, Stamp, Tile} from '../play/Cards';
import {constellation, seedOf} from '../play/constellation';
import {answerRun, depthOf, layerAt, PEEK} from '../play/deck';
import Meter from '../play/Meter';
import {Pill, Rise} from '../play/Motion';
import Odometer from '../play/Odometer';
import PlayKey from '../play/PlayKey';
import Room from '../play/Room';
import SkyLines from '../play/SkyLines';
import {Star} from '../play/Star';
import {litAt, marksOf, milestone, readTaste, TasteRead} from '../play/tasteRead';
import {PLAY, T} from '../play/tokens';

const {spacing} = theme;
const LABEL: Record<Verdict, string> = {love: 'Love it', nope: 'Not for me', skip: "Haven't seen it"};
const STAMP: Record<Verdict, string> = {love: 'LOVE', nope: 'NOPE', skip: "HAVEN'T SEEN"};
const INK: Record<Verdict, string> = {love: PLAY.yes, nope: PLAY.no, skip: PLAY.maybe};

const RUN = answerRun(T.slam, T.throw); // the stops of an answer's one run
const HEAD_H = 44; // the top row and the air under it
const FOOT_H = 82; // "Haven't seen it" and the card's line, under the deck
const SKY_W = 320;
const SKY_H = 110;
const SKY_SCALE = 1.15;

const posterOf = (c: TasteCard | null, w: number) =>
  c && c.poster ? imgSrc(artPath(c.poster, artPx(w)) || c.poster) : null;
const metaOf = (c: TasteCard) =>
  [c.year, c.type === 'show' ? 'Series' : 'Film', ...(c.genres || []).slice(0, 2)].filter(Boolean).join(' · ');

type Leaving = {card: TasteCard; verdict: Verdict; n: number};

// What a card shows: its poster (or a tile in the card's colours), and on its
// foot, over the baked shade, the title and what it is.
const CardFace = React.memo(function CardFace({card, width}: {card: TasteCard; width: number}) {
  const src = posterOf(card, width);
  const meta = metaOf(card);
  return (
    <>
      {src ? <Image source={src} style={styles.poster} resizeMode="cover" fadeDuration={0} /> : <Tile style={styles.poster} />}
      <Shade height="56%" />
      <View style={styles.foot}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {card.title}
        </Text>
        {meta ? (
          <Text style={styles.cardMeta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
    </>
  );
});

export default function Taste({navigation}: NativeStackScreenProps<RootStackParamList, 'Taste'>) {
  const {profileId} = useApp();
  const {width, height, safeBottom} = useTvMetrics();
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
  const inFront = useInFront(navigation as never);
  const timers = useTimers();

  // The card is the hero: 62 % of the screen's height where there is room for
  // what stands under it, 2:3.
  const room = height - spacing.pageY - safeBottom - HEAD_H - PEEK - FOOT_H;
  const cardH = Math.max(200, Math.min(Math.round(height * 0.62), room));
  const cardW = Math.round((cardH * 2) / 3);

  // nothing moves on a lite box or with "Remove animations" on
  const calmNow = useCalm();
  const calm = useRef(calmNow);
  calm.current = calmNow;

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
  const out = useValue(0); // the leaving card: 0 → 1 (stamped, then thrown)
  const flights = useRef(0); // numbers each flight (Leaving.n)
  const pop = useValue(1); // the arriving card: 0 → 1
  const hitNope = useValue(0); // the answers' labels: lit for a moment
  const hitLove = useValue(0);
  const hitSkip = useValue(0);
  const arrive = useCallback(
    (delay = 0) => {
      pop.stopAnimation();
      pop.setValue(0);
      tween(pop, 1, calm.current ? 120 : T.rise, {delay: calm.current ? 0 : delay}).start();
    },
    [pop],
  );
  const flash = useCallback(
    (verdict: Verdict) => {
      if (calm.current) return;
      const v = verdict === 'love' ? hitLove : verdict === 'nope' ? hitNope : hitSkip;
      v.stopAnimation();
      v.setValue(0);
      Animated.sequence([tween(v, 1, 90), tween(v, 0, 170)]).start();
    },
    [hitLove, hitNope, hitSkip],
  );
  const fly = useCallback(
    (verdict: Verdict, card: TasteCard) => {
      out.stopAnimation();
      out.setValue(0);
      const n = ++flights.current;
      setLeaving({card, verdict, n});
      // the run's own stops shape it (deck.ts answerRun), so the clock is even
      tween(out, 1, calm.current ? 140 : RUN.total, {easing: calm.current ? EASE : LINEAR}).start(() => {
        // Finished OR cut short: this flight's card goes either way. The answer
        // that ends a round swaps the band for the round's end before the
        // flight is over, the native animation stops with finished=false, and
        // the card used to stay set — "Keep going" then drew it frozen half
        // way over the next card (Mi TV, 2026-10-18). A newer flight has its
        // own n and is left alone (leavingAfter, tasteSession.ts).
        setLeaving(l => leavingAfter(l, n));
      });
      // the next card comes up as the stamped one is thrown
      arrive(T.slam);
    },
    [out, arrive],
  );

  // ---------- the remark at a lit star ----------
  const said = useRef(new Set<string>()).current; // `${goal}:${k}` — each is said once, also after Undo
  const sayN = useRef(0);
  const [say, setSay] = useState<{text: string; n: number} | null>(null);
  const remark = useCallback(() => {
    const k = marksOf(session.goal).indexOf(session.answered) + 1;
    if (k < 1 || k > 3 || session.roundOver || said.has(`${session.goal}:${k}`)) return;
    said.add(`${session.goal}:${k}`);
    const words = milestone(k, readTaste(session.history.map(h => ({verdict: h.verdict, genres: h.card.genres}))));
    if (words) setSay({text: words, n: ++sayN.current});
  }, [session, said]);

  // ---------- answering ----------
  const answer = useCallback(
    (verdict: Verdict) => {
      const entry = session.answer(verdict);
      if (!entry) return;
      flash(verdict);
      fly(verdict, entry.card);
      remark();
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
    [session, flash, fly, remark, repaint, profileId, warm],
  );

  const undo = useCallback(() => {
    const last = session.undo();
    if (!last) return;
    arrive();
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
  }, [session, arrive, repaint, profileId]);

  const keepGoing = useCallback(() => {
    setLeaving(null); // nothing of the last round is still on its way out
    setSay(null);
    // The round's last answer started the next card's arrival, then the round's
    // end unmounted it half way: on the native driver the value stayed there and
    // Keep going showed that card dim and small (Mi TV, 2026-10-18). It arrives now.
    arrive();
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
  }, [session, repaint, profileId, arrive]);

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

  // ---------- the end of a round: the one reward ----------
  const cur = session.current;
  const next = session.behind;
  const over = loaded === 'ok' && session.roundOver;
  const dry = session.exhausted && !session.queue.length; // every title was answered
  const goal = session.goal;
  const answered = session.answered;
  // what this sitting says (read when the round ends; an Undo changes the count)
  const end = useMemo(() => {
    if (!over) return null;
    const read = readTaste(session.history.map(h => ({verdict: h.verdict, genres: h.card.genres})));
    const loved = session.history.filter(h => h.verdict === 'love');
    const sky = loved.length ? constellation(loved.length, seedOf(loved.map(h => h.card.imdbId).join('')), {w: SKY_W, h: SKY_H}) : null;
    return {read, sky};
    // (`answered` stands for the history: it changes with every answer and Undo)
  }, [over, answered, session]);
  const bursts = useRef(new Set<number>()).current; // rounds (by their goal) that had their burst
  const [fire, setFire] = useState<{n: number; count: number}>({n: 0, count: 16});
  const hasSky = !!(end && end.sky);
  useEffect(() => {
    if (!over || dry || calmNow || bursts.has(goal)) return;
    const off = timers.after(hasSky ? 520 : 300, () => {
      const first = !bursts.size;
      bursts.add(goal);
      setFire({n: goal, count: first ? 16 : 9});
    });
    return () => {
      off();
      setFire(f => (f.n ? {n: 0, count: f.count} : f)); // (the round went on, or was taken back)
    };
  }, [over, dry, calmNow, goal, hasSky, bursts, timers]);
  // The answer that ends a round unmounts the card under the focus, and Android
  // hands the focus to whatever is nearest (it landed on Undo up in the top
  // row, Mi TV 2026-11-12). The end's own key takes it, once, as it appears.
  const endKey = useRef<{requestTVFocus?: () => void} | null>(null);
  useEffect(() => {
    if (!over) return;
    const off = timers.after(60, () => {
      if (endKey.current?.requestTVFocus) {
        noteOwnFocusMove();
        endKey.current.requestTVFocus();
      }
    });
    return off;
  }, [over, goal, timers]);
  // where the number stands in the end's own box: the burst's centre
  const [numY, setNumY] = useState(0);

  // ---------- drawing ----------
  const shown = Math.min(answered, goal);
  // how much of the deck is left to see: it thins as the round runs down
  const depth = depthOf(Math.min(goal - answered, session.exhausted ? session.queue.length : 4));
  const behindAt = layerAt(0, cardH);
  const nextSrc = useMemo(() => posterOf(next, cardW), [next, cardW]);

  const leaveStyle = leaving
    ? (() => {
        if (calm.current) return {opacity: out.interpolate({inputRange: [0, 1], outputRange: [1, 0]})};
        const dir = leaving.verdict === 'love' ? 1 : leaving.verdict === 'nope' ? -1 : 0;
        const along = (reach: number) => out.interpolate({inputRange: RUN.travel.inputRange, outputRange: RUN.travel.outputRange.map(p => +(p * reach).toFixed(1))});
        return {
          opacity: out.interpolate(RUN.fade),
          transform: [
            {translateX: along(dir * cardW * 2.4)},
            {translateY: along(dir ? -cardH * 0.08 : cardH * 1.1)},
            {rotate: out.interpolate({inputRange: RUN.travel.inputRange, outputRange: RUN.travel.outputRange.map(p => `${(p * dir * 16).toFixed(2)}deg`)})},
          ],
        };
      })()
    : null;
  const stampStyle = calm.current
    ? null
    : {opacity: out.interpolate(RUN.stampIn), transform: [{scale: out.interpolate(RUN.stampScale)}]};
  // the arriving card comes up from where it lay under the last one
  const popStyle = calm.current
    ? {opacity: pop.interpolate({inputRange: [0, 1], outputRange: [0.4, 1]})}
    : {
        transform: [
          {translateY: pop.interpolate({inputRange: [0, 1], outputRange: [PEEK / 2, 0]})},
          {scale: pop.interpolate({inputRange: [0, 1], outputRange: [behindAt.scale, 1]})},
        ],
      };
  const veilStyle = {opacity: calm.current ? 0 : pop.interpolate({inputRange: [0, 1], outputRange: [0.55, 0]})};

  return (
    <View style={[styles.root, {paddingBottom: safeBottom}]}>
      <Room on={inFront} calm={calmNow} />
      <View style={styles.head}>
        <Text style={styles.h1}>What's your taste?</Text>
        <View style={styles.progress}>
          <Meter value={session.progress} width={300} lit={litAt(shown, goal)} calm={calmNow} />
          <Text style={styles.count}>
            {shown} / {goal}
          </Text>
        </View>
        <View style={styles.toolbar}>
          {/* always there (dim when there is nothing to undo): a key that
              vanished under the focus would drop it */}
          <PlayKey uiId="taste.undo" small dim={!session.history.length} glyph="↶" label="Undo" onPress={undo} />
          <PlayKey uiId="taste.done" small label="Done" onPress={done} />
        </View>
      </View>

      {loaded === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color={PLAY.ink} />
        </View>
      ) : loaded === 'failed' ? (
        <View style={styles.center}>
          <Text style={styles.endText}>Couldn't load titles — try again in a moment.</Text>
        </View>
      ) : over ? (
        <View style={styles.end}>
          {end && end.sky ? (
            <SkyLines
              points={end.sky.points}
              lines={end.sky.lines}
              width={SKY_W}
              height={SKY_H}
              scale={SKY_SCALE}
              run={goal}
              calm={calmNow}
              style={styles.sky}
            />
          ) : null}
          {dry ? (
            <Rise run={goal} calm={calmNow} style={styles.dryHead}>
              <Star size={30} color={PLAY.teal} />
              <Text style={styles.endTitle}>That's every title we had for you</Text>
            </Rise>
          ) : (
            <>
              <View onLayout={e => setNumY(e.nativeEvent.layout.y + e.nativeEvent.layout.height / 2)}>
                <Odometer text={answered} size={68} run={goal} delay={hasSky ? 260 : 80} calm={calmNow} accessibilityLabel={`${answered} answers`} />
              </View>
              <Rise run={goal} i={1} delay={120} calm={calmNow}>
                <Text style={styles.endTitle}>answers — Home is already using them</Text>
              </Rise>
            </>
          )}
          {/* (nothing was asked — a profile with no titles to show: no row of noughts) */}
          {answered ? (
            <Rise run={goal} i={2} delay={120} calm={calmNow} style={styles.tally}>
              <Chip glyph={'♥︎'} color={PLAY.yes} label={`${session.tally.love} loved`} />
              <Chip glyph="✕" color={PLAY.no} label={`${session.tally.nope} not for you`} />
              <Chip label={`${session.tally.skip} not seen`} />
            </Rise>
          ) : null}
          {end ? <Learned read={end.read} run={goal} calm={calmNow} /> : null}
          <View style={styles.endActions}>
            {dry ? null : <PlayKey uiId="taste.more" ref={endKey} kind="aurora" big label="Keep going" hasTVPreferredFocus onPress={keepGoing} />}
            {/* gold is for a win: a round with nothing in it ends on a plain key */}
            <PlayKey uiId="taste.done" ref={dry ? endKey : undefined} kind={answered ? 'gold' : 'aurora'} big label="Done" hasTVPreferredFocus={dry} onPress={done} />
          </View>
          <Burst fire={fire.n} x={(width - 2 * spacing.pageX) / 2} y={numY} count={fire.count} seed={goal} calm={calmNow} />
        </View>
      ) : (
        <View style={styles.band}>
          <View style={styles.arena}>
            <Answer glyph="◀" label={LABEL.nope} color={INK.nope} hit={hitNope} side="left" />
            <View style={{width: cardW, height: cardH + PEEK}}>
              {/* the light the deck stands in */}
              <Plates left={depth} width={cardW} height={cardH} />
              {next ? (
                <View
                  renderToHardwareTextureAndroid
                  pointerEvents="none"
                  style={[styles.card, {width: cardW, height: cardH, transform: [{translateY: behindAt.translateY}, {scale: behindAt.scale}]}]}>
                  {nextSrc ? <Image source={nextSrc} style={styles.poster} resizeMode="cover" fadeDuration={0} /> : <Tile style={styles.poster} />}
                  <View style={[styles.veil, styles.veilOn]} />
                </View>
              ) : null}
              <TVFocusGuideView trapFocusLeft trapFocusRight trapFocusDown style={{position: 'absolute', left: 0, top: 0, width: cardW, height: cardH}}>
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
                    <Animated.View renderToHardwareTextureAndroid style={[styles.fill, popStyle]}>
                      <CardFace card={cur} width={cardW} />
                      <Animated.View pointerEvents="none" style={[styles.veil, veilStyle]} />
                    </Animated.View>
                  </Focusable>
                ) : (
                  <View style={[styles.card, styles.waiting, {width: cardW, height: cardH}]}>
                    <ActivityIndicator color={PLAY.ink} />
                  </View>
                )}
              </TVFocusGuideView>
              {leaving ? (
                <Animated.View renderToHardwareTextureAndroid pointerEvents="none" style={[styles.leaving, {width: cardW, height: cardH}, leaveStyle]}>
                  <View style={[styles.card, {width: cardW, height: cardH}]}>
                    <CardFace card={leaving.card} width={cardW} />
                  </View>
                  <Animated.View
                    style={[
                      styles.stampAt,
                      leaving.verdict === 'love' ? styles.stampLove : leaving.verdict === 'nope' ? styles.stampNope : styles.stampSkip,
                      stampStyle,
                    ]}>
                    <Stamp
                      label={STAMP[leaving.verdict]}
                      color={INK[leaving.verdict]}
                      tilt={leaving.verdict === 'love' ? -10 : leaving.verdict === 'nope' ? 10 : 0}
                      size={leaving.verdict === 'skip' ? 17 : 30}
                    />
                  </Animated.View>
                </Animated.View>
              ) : null}
              <Pill say={say} calm={calmNow} style={styles.pillAt} />
            </View>
            <Answer glyph="▶" label={LABEL.love} color={INK.love} hit={hitLove} side="right" />
          </View>
          <View style={styles.under}>
            <Answer glyph="▼" label={LABEL.skip} color={INK.skip} hit={hitSkip} side="down" />
            {cur && cur.line ? (
              <Text style={styles.line} numberOfLines={2}>
                {cur.line}
              </Text>
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
}

// "♥ 9 loved": a count of the round, on glass.
const Chip = React.memo(function Chip({glyph, color, label}: {glyph?: string; color?: string; label: string}) {
  return (
    <View style={styles.chip}>
      {glyph ? <Text style={[styles.chipGlyph, {color}]}>{glyph}</Text> : null}
      <Text style={styles.chipText}>{label}</Text>
    </View>
  );
});

// What Aurora learned in this sitting: the genres loved most as lit tags, the
// ones refused as dim ones.
function Learned({read, run, calm}: {read: TasteRead; run: number; calm: boolean}) {
  const liked = read.liked.slice(0, 4);
  const less = read.less.slice(0, 2);
  if (!liked.length && !less.length) return null;
  return (
    <Rise run={run} i={3} delay={120} calm={calm} style={styles.learned}>
      <Text style={styles.eyebrow}>AURORA LEARNED</Text>
      <View style={styles.tags}>
        {liked.map(g => (
          <View key={`+${g.genre}`} style={[styles.tag, styles.tagLit]}>
            <Star size={13} color={PLAY.gold} />
            <Text style={styles.tagText}>{g.n > 1 ? `${g.genre} ×${g.n}` : g.genre}</Text>
          </View>
        ))}
        {less.map(g => (
          <View key={`-${g.genre}`} style={styles.tag}>
            <Text style={[styles.tagText, styles.tagDim]}>less {g.genre}</Text>
          </View>
        ))}
      </View>
    </Rise>
  );
}

const styles = StyleSheet.create({
  // The room paints the page (it lies over the app's ambient canvas).
  root: {flex: 1, paddingHorizontal: spacing.pageX, paddingTop: spacing.pageY},
  head: {flexDirection: 'row', alignItems: 'center', height: 34, marginBottom: HEAD_H - 34, gap: spacing.lg},
  h1: {color: PLAY.ink, fontSize: 24, lineHeight: 30, fontWeight: '900', includeFontPadding: false},
  progress: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1},
  count: {color: PLAY.inkDim, fontSize: 14, lineHeight: 20, fontWeight: '700', fontVariant: ['tabular-nums']},
  toolbar: {flexDirection: 'row', gap: spacing.sm},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm},

  // ---- the deck ----
  band: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  arena: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 40},
  fill: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0},
  card: {
    position: 'absolute',
    left: 0,
    top: 0,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: PLAY.tile,
  },
  waiting: {alignItems: 'center', justifyContent: 'center'},
  poster: {position: 'absolute', left: 0, top: 0, width: '100%', height: '100%'},
  // the shade a card lies in while another is on top of it
  veil: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: '#06071c'},
  veilOn: {opacity: 0.55},
  foot: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 14, paddingBottom: 12},
  cardTitle: {color: PLAY.ink, fontSize: 19, lineHeight: 23, fontWeight: '900', includeFontPadding: false},
  cardMeta: {color: PLAY.inkDim, fontSize: 13, lineHeight: 18, fontWeight: '700', marginTop: 3},
  leaving: {position: 'absolute', left: 0, top: 0},
  stampAt: {position: 'absolute', top: 18},
  stampLove: {left: 12},
  stampNope: {right: 12},
  stampSkip: {left: 0, right: 0, top: '40%', alignItems: 'center'},
  pillAt: {position: 'absolute', left: -140, right: -140, top: -17, alignItems: 'center'},
  under: {height: FOOT_H, alignItems: 'center', paddingTop: 8, gap: 4},
  line: {color: PLAY.inkFaint, fontSize: 13, lineHeight: 18, textAlign: 'center', maxWidth: 560},

  // ---- the end of a round ----
  end: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  sky: {marginBottom: 2},
  dryHead: {alignItems: 'center', gap: 12},
  endTitle: {color: PLAY.ink, fontSize: 20, lineHeight: 27, fontWeight: '800', textAlign: 'center'},
  endText: {color: PLAY.inkDim, fontSize: 15, lineHeight: 21, textAlign: 'center'},
  tally: {flexDirection: 'row', gap: spacing.sm, marginTop: 12},
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: PLAY.glass,
  },
  chipGlyph: {fontSize: 14, lineHeight: 19, fontWeight: '900'},
  chipText: {color: PLAY.ink, fontSize: 14, lineHeight: 19, fontWeight: '700', fontVariant: ['tabular-nums']},
  learned: {alignItems: 'center', marginTop: 14, gap: 7},
  eyebrow: {color: PLAY.inkFaint, fontSize: 13, lineHeight: 17, fontWeight: '800', letterSpacing: 1.6},
  tags: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm},
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: PLAY.line,
  },
  tagLit: {backgroundColor: 'rgba(255,209,102,0.1)', borderColor: 'rgba(255,209,102,0.45)'},
  tagText: {color: PLAY.ink, fontSize: 14, lineHeight: 19, fontWeight: '800'},
  tagDim: {color: PLAY.inkDim, fontWeight: '700'},
  endActions: {flexDirection: 'row', gap: spacing.md, marginTop: 20},
});
