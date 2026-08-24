// Home, built from 02-home.md.
//
// THE PAGE SCROLLS; THE HERO SCROLLS AWAY WITH IT AND NEVER SHRINKS.
//
// That is the site's own structure (§1.5): `.hero` is `min-height: 76vh`, the
// rows are appended after it (`home.js:232-233`), and there is no sticky, no
// scroll-linked transform and no height animation anywhere in the hero block. On
// a TV there is no scrollbar, so the mapping is: *scroll offset* → *which shelf
// holds focus*. The artwork is a fixed layer; the hero lockup and the shelves are
// ONE sliding column above it. Press DOWN and the hero travels off the top
// exactly as the page would carry it away.
//
// The 0.42-height hero this screen used to draw, and the "budget" that argued for
// it, are void — they reasoned about the previous app, not the site (RULES rule
// 13 · SPEC/99-open.md §I.3). So is the compact caption that named the focused
// card: the site puts labels on the cards that have them (wide, episode, up-next)
// and nothing at all on a poster, and Card now does the same.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, Image, StyleSheet, ActivityIndicator, Animated, Easing} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Btn from '../components/Btn';
import Row from '../components/Row';
import NavRail from '../components/NavRail';
import {ErrorState} from '../components/States';
import {api, imgSrc, ImgSource, Home as HomeData, HeroItem, HomeRow} from '../api';
import {checkForUpdate, UpdateInfo} from '../update';
import {canNavigate} from '../navLock';
import {openItem} from '../openItem';
import {useFocusFallback, useIsLive} from '../focus';
import {defer, useSlide} from '../motion';
import {useApp} from '../AppContext';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, radius, motion} = theme;

// The left scrim the title sits on, and the ambient veil the artwork dissolves
// into. The veil is the real background brought forward rather than an opaque
// --bg ramp: painting the page colour over the foot of the art is the mistake
// screens.css:13-20 calls out by name — the covered band is the one place with no
// ambient light in it, so the join reads as a horizon line.
const HERO_SIDE = require('../assets/hero-side.png');
const HERO_VEIL = require('../assets/ambient-veil.png');

const EASE = Easing.bezier(0.2, 0.7, 0.2, 1);

// screens.css:32-43 and :85-89. Two treatments, cross-faded on one boolean:
// "focus is still on the hero's own buttons" vs "focus is down in the shelves".
//
// A library still (`/img/still/…`) is a real video frame and the site keeps it
// SHARP (`.hero-backdrop.sharp`); poster-derived art gets the depth-of-field
// blur. `brightness()` is transcribed as the black scrim the value implies —
// 0.55 → α 0.45 at rest, 0.58 → α 0.42 once scrolled — rather than as the --bg
// wash this screen used to paint, which is the darkening the CSS rejects.
const REST = {blur: 1, dim: 0.45};
const SCROLLED = {blur: 2, dim: 0.42};

const HeroArt = React.memo(function HeroArtLayer({
  art,
  atTop,
  h,
}: {
  art: ImgSource;
  atTop: Animated.Value;
  h: number;
}) {
  // A still stays sharp in both states, so it needs one layer; blurred art needs
  // two, because blurRadius is a prop and cannot be animated.
  const sharp = art.uri.includes('/img/still');
  const dim = atTop.interpolate({inputRange: [0, 1], outputRange: [SCROLLED.dim, REST.dim]});
  return (
    <View style={[styles.artLayer, {height: h}]} pointerEvents="none">
      <Image
        source={art}
        style={styles.art}
        resizeMode="cover"
        blurRadius={sharp ? 0 : REST.blur}
        fadeDuration={260}
      />
      {sharp ? null : (
        <Animated.Image
          source={art}
          style={[styles.art, {opacity: atTop.interpolate({inputRange: [0, 1], outputRange: [1, 0]})}]}
          resizeMode="cover"
          blurRadius={SCROLLED.blur}
          fadeDuration={0}
        />
      )}
      <Animated.View style={[styles.artDim, {opacity: dim}]} />
      <Image source={HERO_SIDE} style={styles.artSide} resizeMode="stretch" />
      <Image source={HERO_VEIL} style={styles.artVeil} resizeMode="stretch" />
    </View>
  );
});

export default function Home({
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'Home'>) {
  const {profileId, switchProfile} = useApp();
  const {width, height, heroH, heroPadBottom, heroTitle, safeBottom} = useTvMetrics();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState('');
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  // Bumped by the error state's Retry, so the fetch below re-runs.
  const [reload, setReload] = useState(0);
  // Where focus goes if it is ever lost — see focus.ts. The ref is attached to
  // the loading state's Switch profile button AND to the hero's Play button:
  // it used to live only on the former, so once Home loaded the registered
  // fallback pointed at nothing and a focused card unmounting (long-press ✕ on
  // Continue Watching) left the remote dead at the stack root.
  const escape = useRef(null);
  useFocusFallback(escape);
  // Pushed screens freeze RENDERING (freezeOnBlur), not JS timers — gate the
  // hero rotation on this screen actually being the live one, so it stops
  // burning JS-thread time behind Detail and the Player.
  const live = useIsLive();

  // Also refetched when the screen regains focus (throttled): Continue
  // Watching is exactly what changed while you were away in the player, and
  // without this the row showed boot-time data until the app restarted.
  const lastFetch = useRef(0);
  useEffect(() => {
    if (!live) return;
    if (data && Date.now() - lastFetch.current < 15000) return;
    let on = true;
    lastFetch.current = Date.now();
    api
      .home(profileId)
      .then(h => on && setData(h))
      .catch(e => on && !data && setError(String(e?.message || e)));
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, reload, live]);

  useEffect(() => {
    let live = true;
    checkForUpdate().then(u => live && u && setUpdate(u));
    return () => {
      live = false;
    };
  }, []);

  const openDetail = useCallback((item: HeroItem) => openItem(navigation, item), [navigation]);
  const heroPlay = useCallback(
    (item: HeroItem) => {
      // Library movie → straight to the player; shows and stream titles need the
      // detail page first (episode / source choice).
      if (item.source !== 'stream' && item.type === 'movie' && item.id) {
        if (!canNavigate(navigation)) return;
        navigation.push('Player', {id: item.id, title: item.title});
      } else {
        openDetail(item);
      }
    },
    [navigation, openDetail],
  );

  // ---- the sliding column --------------------------------------------------
  const ty = useSlide();
  // Each shelf's y inside the column, measured rather than computed: a Continue
  // Watching row is shorter than a poster row, so there is no single row height.
  const rowY = useRef<number[]>([]);
  // The column's full height, so the slide can be clamped to it. Re-measured as
  // `reach` mounts more shelves.
  const colH = useRef(0);
  // Everything above the focused row stays mounted (you can always come back up)
  // and Row does its own card windowing, so this only stops the whole catalogue
  // mounting at once on first paint.
  const [reach, setReach] = useState(3);
  // ---- hero rotation -------------------------------------------------------
  // home.js:168-173 — one title every 9s, and `holdUntil` freezes it for 15s
  // after the viewer moves it themselves.
  //
  // DIVERGENCE, stated: the site also skips a beat while focus is inside the
  // hero's info block (`!info.contains(document.activeElement)`). On the web
  // focus is usually nowhere, so that reads as "pause while they are engaging
  // with it". On a TV focus is ALWAYS somewhere, and at rest it is on this very
  // Play button — so transcribed literally the hero would never rotate at all.
  // The intent ports, the test does not: rotate while the hero is on screen,
  // hold for 15s after a press, and stop once focus is down in the shelves.
  const [heroIdx, setHeroIdx] = useState(0);
  const holdUntil = useRef(0);
  const swap = useRef(new Animated.Value(1)).current;

  // The site's `.scrolled` boolean, which is the ONLY thing scroll changes there.
  const atTop = useRef(new Animated.Value(1)).current;
  const isTop = useRef(true);
  const setTop = useCallback(
    (next: boolean) => {
      if (next === isTop.current) return;
      isTop.current = next;
      Animated.timing(atTop, {
        toValue: next ? 1 : 0,
        duration: motion.med,
        easing: EASE,
        useNativeDriver: true,
        isInteraction: false,
      }).start();
    },
    [atTop],
  );

  const heroes = data?.hero?.length ? data.hero : data?.rows?.[0]?.items?.slice(0, 1) || [];

  useEffect(() => {
    if (heroes.length < 2 || !live) return;
    const t = setInterval(() => {
      if (!isTop.current || Date.now() < holdUntil.current) return;
      setHeroIdx(i => (i + 1) % heroes.length);
    }, 9000);
    return () => clearInterval(t);
  }, [heroes.length, live]);

  // screens.css:186-189 — text and poster slide in from the direction of travel,
  // so a change reads as movement rather than as a content swap. 52px at RULE B
  // ×1.0, because a motion offset is not layout geometry.
  useEffect(() => {
    swap.setValue(0);
    Animated.timing(swap, {
      toValue: 1,
      duration: motion.med,
      easing: EASE,
      useNativeDriver: true,
      isInteraction: false,
    }).start();
  }, [heroIdx, swap]);

  const toHero = useCallback(() => {
    setTop(true);
    ty.to(0);
  }, [setTop, ty]);

  const toRow = useCallback(
    (index: number) => {
      setTop(false);
      const y = rowY.current[index];
      if (y == null) return;
      // The focused row comes to rest at the page's top inset — "scroll until
      // this row is at the top", which is what a viewer does on the site. The
      // hero travels off above it.
      //
      // CLAMPED to the end of the content, because a real scroller cannot travel
      // past its own bottom. Without this the last few rows each slid to the top
      // and left a screenful of dead space under them — measured on the Streamer,
      // and it reads as a broken page rather than as the end of one.
      const max = Math.max(0, colH.current - height);
      ty.to(-Math.min(Math.max(0, y - spacing.pageY), max));
      // Mounting another shelf changes what is mounted, so it goes off the input
      // path — a held DOWN must never wait for a row to render.
      defer(() => setReach(r => (index + 3 > r ? index + 3 : r)));
    },
    [setTop, ty, height],
  );

  // Continue Watching's ✕ — drawn on the focused card, removed by LONG-PRESS OK
  // (P12/P20). The card is dropped locally as well as on the server, because the
  // site does the same (`components.js:187-191`: `node.remove()` then the call).
  //
  // An "up next" card takes a DIFFERENT call: its id is the next episode's, but
  // the progress row that spawns it lives under the previous one — so
  // clearProgress on it deleted nothing and the card returned on every visit.
  const removeFromContinue = useCallback(
    (item: HeroItem) => {
      if (!item.id) return;
      setData(d =>
        d
          ? {
              ...d,
              rows: d.rows.map(r =>
                r.id === 'continue' ? {...r, items: r.items.filter(i => i.id !== item.id)} : r,
              ),
            }
          : d,
      );
      if (item.upNext && item.showId) {
        api.dismissUpNext(profileId, item.showId, item.id).catch(() => {});
      } else {
        api.clearProgress(profileId, item.id).catch(() => {});
      }
    },
    [profileId],
  );

  const renderRow = useCallback(
    (r: HomeRow, i: number) => (
      <View
        key={r.id}
        onLayout={e => {
          rowY.current[i] = e.nativeEvent.layout.y;
        }}>
        <Row
          title={r.title}
          items={r.items}
          onSelect={openDetail}
          onItemFocus={() => toRow(i)}
          showKind
          wide={r.id === 'continue'}
          onRemove={r.id === 'continue' ? removeFromContinue : undefined}
        />
      </View>
    ),
    [openDetail, toRow, removeFromContinue],
  );

  if (!data && !error) {
    // Loading. A skeleton is not focusable (§6.1), so the screen still renders one
    // real target or the remote is dead however long the server takes — and it is
    // this screen's registered focus fallback.
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.text} size="large" />
        <Btn ref={escape} label="Switch profile" hasTVPreferredFocus edgeLeft onPress={switchProfile} />
        <NavRail active="home" />
      </View>
    );
  }
  if (error) {
    // §6.3's ErrorState: the server's own message, and a Retry that holds focus.
    return (
      <View style={styles.center}>
        <ErrorState
          message="Could not load home."
          detail={error}
          onAction={() => {
            setError('');
            setReload(n => n + 1);
          }}
        />
        <NavRail active="home" />
      </View>
    );
  }

  // A server that answered but had NOTHING to show (empty library, discover
  // cache still warming after a restart, fresh profile) used to render a screen
  // with zero focusable elements — and on Android TV key events only reach JS
  // through the focused view, so the remote was completely dead at the stack
  // root. Give that state a real message and a focusable Retry.
  if (data && heroes.length === 0 && (data.rows?.length ?? 0) === 0) {
    return (
      <View style={styles.center}>
        <ErrorState
          message="Nothing to show yet."
          detail="The server answered but had no titles for this profile — it may still be warming up after a restart."
          actionLabel="Try again"
          onAction={() => {
            setData(null);
            setReload(n => n + 1);
          }}
        />
        <NavRail active="home" />
      </View>
    );
  }

  const hero = heroes[heroIdx % Math.max(1, heroes.length)] || null;
  const art = imgSrc(hero?.backdrop || hero?.cover);
  const isEpisode = !!hero?.showId && hero?.type !== 'show';
  const facts = [
    hero?.rating ? `★ ${hero.rating}` : null,
    hero?.year ? String(hero.year) : null,
    isEpisode ? `S${hero!.season} E${hero!.episode}` : null,
    hero?.genres?.length ? hero.genres.slice(0, 3).join(' · ') : null,
  ]
    .filter(Boolean)
    .join('   ·   ');

  return (
    <View style={styles.root}>
      <Animated.View
        style={[styles.column, {transform: [{translateY: ty.value}]}]}
        onLayout={e => {
          colH.current = e.nativeEvent.layout.height;
        }}
        pointerEvents="box-none">
        {/* The artwork travels WITH the column, because on the site it is the
            hero's own background and the hero scrolls away (screens.css:32 sits
            inside `.hero`). 02-home §1.5 translates it as a fixed layer instead;
            built that way and measured, the shelves slide up INTO the part of the
            art the veil has not dissolved yet, so they end up sitting on bright
            artwork — the one thing §1.5 itself says the site's home never does.
            Moving it into the column costs nothing and removes the conflict: art
            and dissolve stay registered because they move together. */}
        {art ? <HeroArt art={art} atTop={atTop} h={height} /> : null}
        {/* No hero but real rows (a server mid-warmup can emit that): the Play
            button — this screen's focus fallback — never mounts, so give the
            fallback a home. Without one, a focused card unmounting (long-press
            ✕) had nowhere to rescue focus to, at the stack root. */}
        {!hero ? (
          <View style={styles.noHeroBar}>
            <Btn
              ref={escape}
              small
              label="Refresh"
              edgeLeft
              onPress={() => {
                setData(null);
                setReload(n => n + 1);
              }}
            />
          </View>
        ) : null}
        {/* `.hero` — 76vh, its lockup bottom-anchored with the 56px→28dp gap
            under it (screens.css:2-7). It is INSIDE the column, so it scrolls
            away with the page exactly as the site's does. */}
        {hero ? (
          <View style={[styles.hero, {height: heroH, paddingBottom: heroPadBottom}]}>
            {/* `.hero-inner` — the info column and the poster, bottom-aligned
                with a 48px→24dp gap between them (screens.css:138-142). */}
            <Animated.View
              style={[
                styles.heroInner,
                {
                  opacity: swap,
                  transform: [
                    {translateX: swap.interpolate({inputRange: [0, 1], outputRange: [52, 0]})},
                  ],
                },
              ]}>
            <View style={[styles.info, {maxWidth: Math.round(width * 0.337)}]}>
            <Text
              style={[
                styles.kicker,
                {color: hero.type === 'show' ? colors.kindSeries : colors.kindFilm},
              ]}>
              {hero.type === 'show' ? 'SERIES' : 'FILM'}
            </Text>
            <Text style={[styles.title, {fontSize: heroTitle}]} numberOfLines={2}>
              {isEpisode ? hero.showTitle || hero.title : hero.title}
            </Text>
            {facts ? <Text style={styles.facts}>{facts}</Text> : null}
            {/* `.hero-synopsis` — three lines, clamped (screens.css:261-270). */}
            {hero.synopsis ? (
              <Text
                style={[styles.synopsis, {maxWidth: Math.round(width * 0.295)}]}
                numberOfLines={3}>
                {hero.synopsis}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Btn
                primary
                ref={escape}
                icon="play"
                label={hero.source === 'stream' ? 'Stream' : 'Play'}
                hasTVPreferredFocus
                // First button of the hero band, so LEFT from it opens the rail.
                edgeLeft
                onFocusChange={f => f && toHero()}
                onPress={() => {
                  holdUntil.current = Date.now() + 15000;
                  heroPlay(hero);
                }}
              />
              <Btn
                icon="info"
                label="Details"
                onFocusChange={f => f && toHero()}
                onPress={() => openDetail(hero)}
              />
            </View>
            </View>
            {/* `.hero-poster` — 240px → 12.6% of width, 2:3, --radius-l, and the
                site's deep bottom shadow (screens.css:174-181). */}
            {imgSrc(hero.cover || hero.poster) ? (
              <Image
                source={imgSrc(hero.cover || hero.poster) as ImgSource}
                style={[
                  styles.heroPoster,
                  {width: Math.round(width * 0.126), height: Math.round(width * 0.126 * 1.5)},
                ]}
                resizeMode="cover"
              />
            ) : null}
            </Animated.View>
            {/* `.hero-dots` (screens.css:221-248). DRAWN, not focusable — the
                site's are <button>s because a mouse needs a target; on a D-pad
                they would be extra stops in the hero band for something the
                rotation already does. Same call as the card's ✕ (P12). */}
            {heroes.length > 1 ? (
              <View style={styles.dots} pointerEvents="none">
                {heroes.map((h, i) => (
                  <View
                    key={h.id || h.imdbId || String(i)}
                    style={[styles.dot, i === heroIdx % heroes.length && styles.dotOn]}
                  />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {(data!.rows || []).slice(0, reach + 1).map(renderRow)}
        <View style={{height: safeBottom}} />
      </Animated.View>

      <NavRail active="home" />

      {update ? (
        <View style={styles.updateChip} pointerEvents="none">
          <Text style={styles.updateText}>{`Update ${update.version}`}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // No backgroundColor: android:windowBackground already paints it, and painting
  // it again cost a second full-screen fill on every frame.
  root: {flex: 1},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg},

  // ---- artwork, a FIXED layer behind the column ----------------------------
  // Rider 1 of the safe area: artwork paints to the physical edge; only text and
  // focus rings respect the inset.
  // Full WINDOW height at the top of the column, not the hero box's — the veil
  // is baked against the window (tools/gen_ambient.py), so shrinking this would
  // compress the dissolve away from the stops it was baked at.
  artLayer: {position: 'absolute', top: 0, left: 0, right: 0},
  art: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%'},
  // `brightness()` as the scrim it implies. NOT --bg: painting the page colour
  // over the art is what screens.css:13-20 rejects.
  artDim: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000000'},
  artSide: {position: 'absolute', top: 0, left: 0, bottom: 0, width: '72%', height: '100%'},
  artVeil: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%'},

  // ---- the column ---------------------------------------------------------
  column: {position: 'absolute', top: 0, left: 0, right: 0},
  // The artwork stays full-bleed under the rail; only the type moves right.
  hero: {justifyContent: 'flex-end', paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX},
  // `.hero-inner { display:flex; align-items:flex-end; gap:48px }` → 24dp.
  heroInner: {flexDirection: 'row', alignItems: 'flex-end', gap: 24},
  // `.hero-info { flex: 1; max-width: 640px }`.
  info: {flex: 1},
  heroPoster: {borderRadius: radius.l, boxShadow: '0 30px 80px -45px rgba(0,0,0,0.65)'},
  // `.hero-synopsis` — 0.98rem = 15.7 → the 16dp reading tier, line-height 1.55.
  synopsis: {
    color: colors.textDim,
    fontSize: 16,
    lineHeight: 25,
    marginTop: 10,
    marginBottom: 13,
  },
  // `.hero-kind` — the smallest element in the lockup, and it answers "what am I
  // looking at" before you have read a word of the name.
  kicker: {fontSize: 14, fontWeight: '900', letterSpacing: 2, marginBottom: 6},
  title: {
    color: colors.text,
    fontWeight: '900',
    letterSpacing: -1.4,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: {width: 0, height: 3},
    textShadowRadius: 26,
  },
  facts: {
    color: colors.textDim,
    fontSize: fontSize.small,
    fontWeight: '700',
    marginTop: 6,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 10,
  },
  actions: {flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md},

  // right: --page-x, bottom: 22px → 11dp (page rhythm, ×0.505). The 8dp dot is a
  // graphic at ×1.0; the site's 7px button padding becomes the gap that keeps
  // them apart.
  dots: {position: 'absolute', right: spacing.pageX, bottom: 11, flexDirection: 'row', gap: 16},
  dot: {width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.28)'},
  dotOn: {backgroundColor: '#ffffff'},

  noHeroBar: {paddingTop: 27, paddingLeft: spacing.contentLeft, flexDirection: 'row'},
  updateChip: {
    position: 'absolute',
    top: 25,
    right: spacing.pageX,
    backgroundColor: colors.accentStrong,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  updateText: {color: colors.white, fontSize: fontSize.small, fontWeight: '800'},
});
