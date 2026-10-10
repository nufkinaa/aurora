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
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Image, StyleSheet, ActivityIndicator, Animated, Easing, PixelRatio} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Btn from '../components/Btn';
import Row from '../components/Row';
import NavRail from '../components/NavRail';
import {ErrorState} from '../components/States';
import TrailerFrame, {TrailerHandle, TrailerState} from '../components/Trailer';
import {api, artPath, ART_LADDER, imgSrc, ImgSource, sameParties, serverCanBlur, Home as HomeData, HeroItem, HomeRow, PartySummary} from '../api';
import {checkForUpdate, holdPromptFor, onUpdateReady, updateReady, UpdateInfo} from '../update';
import {currentRouteName} from '../rootNav';
import {syncHomeScreen, useHomeScreenLinks} from '../homeScreen';
import {canNavigate} from '../navLock';
import {openItem} from '../openItem';
import {openUpdate, openUpdateReady, overlayOpen} from '../overlay';
import {isLite, measureOnce} from '../perfTier';
import {prepareTrailer, ResolvedTrailer} from '../trailers';
import {resolvePartyRoute} from '../party';
import {warmItem, warmSections} from '../prefetch';
import {onMessage} from '../realtime';
import {loadPrefs} from '../storage';
import {track} from '../usage';
import {
  focusJustMoved,
  onRailClose,
  onRailOpen,
  railOpen,
  requestRailOpen,
  useFocusFallback,
  useIsLive,
  useTVKeys,
} from '../focus';
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
//
// ONE picture, not two: hero-side.png (stretched over the left 72%) and then
// ambient-veil.png (the whole window) are precomposed by tools/gen_ambient.py
// into hero-scrim.png — "over" is associative, so the pair drawn as one layer
// is the same picture, one full-screen layer of fill fewer on every frame.
// tools/check_baked.py: at most 2 levels of 255 from the pair, over any art.
// (Detail and Sources still draw the pair; they sit on a different veil.)
const HERO_SCRIM = require('../assets/hero-scrim.png');

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
// How long after the billboard first appears the first trailer lookup waits
// (see the prepare in Home): the launch's first pictures go first.
const FIRST_PREP_DELAY_MS = 2000;

// THE BLUR IS DONE BY THE SERVER. `blurRadius` made Android run Fresco's
// iterative box blur on the decoded 1920×1080 backdrop — a copy of the whole
// bitmap plus a native blur, once per layer, on every rotation (the
// FrescoBackgroundExecutor bursts measured on the Mi TV). The server makes
// the same picture once and caches it (src/lib/imgvariant.js `?blur=`: the
// identical two-pass box at the source's resolution, then 1280 wide like the
// site's billboard), so the box only decodes a 1280×720 JPEG.
//
// The radius asked for is the one Android would have used, in SOURCE pixels:
// ReactImageView.setBlurRadius takes (dp × density, truncated) / 2, with two
// iterations — 1 px for REST and 2 px for SCROLLED on a 1080p set. A radius
// that comes to 0 on a low-density screen meant "no blur" there, and still
// does (the original, as before).
const deviceBlurPx = (dp: number) => Math.floor(Math.floor(dp * PixelRatio.get()) / 2);
// The site caps the billboard at 1280 (public/js/ui.js heroArtWidth).
const heroPx = (dpWidth: number) => {
  const px = Math.min(1280, Math.ceil(dpWidth * PixelRatio.get()));
  return ART_LADDER.find(s => px <= s) || 1280;
};
type ArtLayer = {src: ImgSource; deviceBlur: number};
type HeroLayers = {rest: ArtLayer; scrolled: ArtLayer | null};
function heroLayers(raw: string, dpWidth: number): HeroLayers | null {
  const plain = imgSrc(raw);
  if (!plain) return null;
  // A library still is a real video frame and stays SHARP in both states: one layer.
  if (plain.uri.includes('/img/still')) return {rest: {src: plain, deviceBlur: 0}, scrolled: null};
  const layer = (dp: number): ArtLayer => {
    const r = deviceBlurPx(dp);
    if (r <= 0) return {src: plain, deviceBlur: 0};
    const path = serverCanBlur() ? artPath(raw, heroPx(dpWidth), r) : null;
    // a host the server does not proxy, or a server too old to blur: on the box, as before
    return path ? {src: imgSrc(path) || plain, deviceBlur: 0} : {src: plain, deviceBlur: dp};
  };
  return {rest: layer(REST.blur), scrolled: layer(SCROLLED.blur)};
}

const HeroArt = React.memo(function HeroArtLayer({
  art,
  scrolledArt,
  atTop,
  h,
  children,
}: {
  art: HeroLayers;
  // The SCROLLED layer's picture (the same pick's), or null while it is not
  // wanted. It is invisible (opacity 0) while focus is up here, so it is not
  // mounted until focus goes down to the shelves, and it is not carried along
  // as the billboard rotates (rotation only happens up here): a rotation
  // decodes ONE picture, the one on show. When focus leaves the hero it is
  // mounted for the current pick and decodes while it fades in — under a
  // layer that is itself fading out with the scroll.
  scrolledArt: HeroLayers | null;
  atTop: Animated.Value;
  h: number;
  // The trailer layer, drawn over the art and UNDER the scrims, so the lockup
  // stays readable while the picture moves.
  children?: React.ReactNode;
}) {
  // A still stays sharp in both states, so it needs one layer; blurred art needs
  // two, because the blur is baked into each picture and cannot be animated.
  const dim = atTop.interpolate({inputRange: [0, 1], outputRange: [SCROLLED.dim, REST.dim]});
  const scrolled = scrolledArt?.scrolled || null;
  return (
    <View style={[styles.artLayer, {height: h}]} pointerEvents="none">
      <Image
        source={art.rest.src}
        style={styles.art}
        resizeMode="cover"
        blurRadius={art.rest.deviceBlur}
        fadeDuration={260}
      />
      {art.scrolled && scrolled ? (
        <Animated.Image
          source={scrolled.src}
          style={[styles.art, {opacity: atTop.interpolate({inputRange: [0, 1], outputRange: [1, 0]})}]}
          resizeMode="cover"
          blurRadius={scrolled.deviceBlur}
          fadeDuration={0}
        />
      ) : null}
      {children}
      <Animated.View style={[styles.artDim, {opacity: dim}]} />
      <Image source={HERO_SCRIM} style={styles.artScrim} resizeMode="stretch" fadeDuration={0} />
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
  // Watch parties running on the server right now — a Join pill per party in
  // the hero band (the site's party strip).
  const [parties, setParties] = useState<PartySummary[]>([]);
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
  // The library changed on the server (a download landed, a rescan): the rows
  // are asked for again through the very path a return to Home uses. Held a
  // moment, because a season finishing says so once per episode; and when Home
  // is not the live screen nothing is fetched at all — the throttle is simply
  // lifted, so the next return to Home re-reads.
  const [libTick, setLibTick] = useState(0);
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onMessage('library_updated', () => {
      lastFetch.current = 0;
      if (!liveRef.current || t) return;
      t = setTimeout(() => {
        t = null;
        lastFetch.current = 0;
        if (!liveRef.current) return;
        console.log('[live] home: library changed, rows re-read');
        setLibTick(n => n + 1);
      }, 2500);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, []);
  useEffect(() => {
    if (!live) return;
    if (data && Date.now() - lastFetch.current < 15000) return;
    let on = true;
    lastFetch.current = Date.now();
    api
      .home(profileId)
      .then(h => {
        if (!on) return;
        setData(h);
        // the TV's own home screen follows: Continue watching + recommendations
        syncHomeScreen(h.rows, profileId);
      })
      .catch(e => on && !data && setError(String(e?.message || e)));
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, reload, live, libTick]);

  // A new build is offered as a sheet the viewer has to answer — on every
  // return to Home and every half hour while browsing, so it is not missed.
  // "Later" buys ten minutes, not the whole run (elia: it has to be
  // noticeable, so people actually upgrade).
  const lastOffer = useRef(0);
  useEffect(() => {
    if (!live) return;
    let on = true;
    const offer = async () => {
      const u = await checkForUpdate();
      if (!on || !u) return;
      setUpdate(u);
      // A TV that can update itself quietly (Android 12+) is given a day to
      // do so — the build is fetched now and installed when the app leaves
      // the screen — before the viewer is asked. Settings still shows it.
      if (await holdPromptFor(u)) return;
      if (!on) return;
      if (overlayOpen() || Date.now() - lastOffer.current < 10 * 60000) return;
      lastOffer.current = Date.now();
      openUpdate(u);
    };
    const t = setTimeout(offer, data ? 1500 : 4000);
    const iv = setInterval(offer, 30 * 60000);
    // A quietly-fetched build says it is ready: once per version, and never
    // over the player or another sheet — it waits for a quiet moment.
    let askedFor = '';
    const askRestart = () => {
      const info = updateReady();
      if (!on || !info || askedFor === info.version) return;
      if (overlayOpen() || currentRouteName() === 'Player') return;
      askedFor = info.version;
      openUpdateReady(info);
    };
    onUpdateReady(() => setTimeout(askRestart, 800));
    const ready = setInterval(askRestart, 20000);
    return () => {
      on = false;
      onUpdateReady(null);
      clearInterval(ready);
      clearTimeout(t);
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // Parties: once on arrival, then live over the socket.
  useEffect(() => {
    if (!live) return;
    let on = true;
    // The same list is the same state: every return to Home asks, and the
    // usual answer (no parties) was a new empty array — one more render of
    // the whole screen during the fade back.
    const put = (next: PartySummary[]) => setParties(prev => (sameParties(prev, next) ? prev : next));
    const load = () => api.parties().then(d => on && put(d.parties || [])).catch(() => {});
    load();
    const off = onMessage('party_list', d => on && put((d.parties as PartySummary[]) || []));
    const off2 = onMessage('welcome', load);
    return () => {
      on = false;
      off();
      off2();
    };
  }, [live]);
  const joinParty = useCallback(
    async (p: PartySummary) => {
      const route = await resolvePartyRoute(p.code);
      if (!route || !canNavigate(navigation)) return;
      track('feat', {f: 'party_join'});
      navigation.push('Player', {...route, party: p.code});
    },
    [navigation],
  );

  // Once Home is up, warm the other sections quietly (prefetch.ts).
  useEffect(() => {
    if (data) warmSections();
  }, [data]);

  const openDetail = useCallback((item: HeroItem) => openItem(navigation, item), [navigation]);
  // A press on one of Aurora's entries on the TV's home screen. "play" is the
  // Continue watching row: a library film goes straight to the player (its
  // card in the app opens the title page; here the viewer asked to resume).
  const openFromLauncher = useCallback(
    (action: 'play' | 'detail', item: HeroItem) => {
      const libraryFilm = item.type === 'movie' && item.source !== 'stream' && !String(item.id).startsWith('torrent|');
      if (action === 'play' && libraryFilm) {
        navigation.push('Player', {id: item.id, title: item.title});
        return;
      }
      // A "New: …" entry or notification for a downloaded episode
      // (homeScreen.ts landedItem): straight into the player, even when the
      // library did not say which show it belongs to.
      const libraryEpisode = !item.type && item.season != null && item.episode != null && !String(item.id).startsWith('torrent|');
      if (action === 'play' && libraryEpisode && !item.showId) {
        if (!canNavigate(navigation)) return;
        navigation.push('Player', {
          id: item.id,
          title: `${item.showTitle || item.title} · S${item.season} E${item.episode}`,
          epTitle: item.title && !/^Episode \d+$/.test(item.title) ? item.title : undefined,
        });
        return;
      }
      openItem(navigation, item);
    },
    [navigation],
  );
  useHomeScreenLinks(openFromLauncher);
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
  // Where the column was last sent. Every card focus calls toRow, so a step
  // ALONG a shelf used to start the page spring again with the target it
  // already had — one native animation start per keypress for no movement
  // (and, mid-slide, a restart of the slide from zero velocity). The spring is
  // started only when the target is a different one; nothing but `slideTo`
  // moves this value, so it is always at, or on its way to, `tyTarget`.
  const tyTarget = useRef(0);
  const slideTo = useCallback(
    (y: number) => {
      if (y === tyTarget.current) return;
      tyTarget.current = y;
      ty.to(y);
    },
    [ty],
  );
  // Made once, not per render (a new interpolation is a new animated node
  // attached to the view each time Home renders).
  const artFadeOpacity = useMemo(
    () =>
      ty.value.interpolate({
        inputRange: [-Math.round(heroH * 0.9), -Math.round(heroH * 0.3), 0],
        outputRange: [0, 1, 1],
        extrapolate: 'clamp',
      }),
    [ty, heroH],
  );
  // Each shelf's y inside the column, measured rather than computed: a Continue
  // Watching row is shorter than a poster row, so there is no single row height.
  const rowY = useRef<number[]>([]);
  // The column's full height, so the slide can be clamped to it. Re-measured as
  // `reach` mounts more shelves.
  const colH = useRef(0);
  // Everything above the focused row stays mounted (you can always come back up)
  // and Row does its own card windowing, so this only stops the whole catalogue
  // mounting at once on first paint.
  //
  // THE FIRST COMMIT MOUNTS TWO SHELVES, NOT FOUR. At rest the hero takes 66%
  // of the screen and only the first shelf shows; shelves 3 and 4 were 12
  // more cards (and 12 more poster requests) in the commit that has to put the
  // first picture on screen. `reach` starts at 1 and goes to 3 — where it
  // always started — one frame after the rows first draw, as a transition.
  //
  // What that must not break, and why it does not:
  //  - DOWN finds a shelf. The first DOWN lands on shelf 0 and the second on
  //    shelf 1; both are in the first commit. Shelf 2 is wanted by the third
  //    press at the earliest, a held key's second repeat (≥ 0.5 s later); the
  //    growth is asked for one frame after the first draw, and toRow asks for
  //    it too (index + 3, as before).
  //  - Where a shelf comes to rest. toRow clamps the slide to the column's
  //    height, and for a frame or two the column is two shelves short: a DOWN
  //    in that window would rest shelf 0 a little low. So the one layout in
  //    which the column grows to its usual height re-runs the slide for the
  //    shelf that holds focus (`settling`, below) — the same target the old
  //    first commit gave.
  const [reach, setReach] = useState(1);
  const settling = useRef(false);
  // The shelf that holds focus (-1: the hero band).
  const curRow = useRef(-1);
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
  const heroIdxRef = useRef(0);
  heroIdxRef.current = heroIdx;
  const holdUntil = useRef(0);
  const swap = useRef(new Animated.Value(1)).current;
  const swapX = useMemo(() => swap.interpolate({inputRange: [0, 1], outputRange: [52, 0]}), [swap]);

  // The site's `.scrolled` boolean, which is the ONLY thing scroll changes there.
  const atTop = useRef(new Animated.Value(1)).current;
  const isTop = useRef(true);
  // Which pick the SCROLLED art layer shows (HeroArt): -1 until focus first
  // leaves the hero, then the pick on show at the moment it left.
  const [scrolledIdx, setScrolledIdx] = useState(-1);
  const setTop = useCallback(
    (next: boolean) => {
      if (next === isTop.current) return;
      isTop.current = next;
      if (!next) {
        const at = heroIdxRef.current;
        defer(() => setScrolledIdx(at));
      }
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
      if (!isTop.current || Date.now() < holdUntil.current || trailerBusy.current) return;
      setHeroIdx(i => (i + 1) % heroes.length);
    }, 9000);
    return () => clearInterval(t);
  }, [heroes.length, live]);

  // ---- the billboard trailer (site: heroTrailer.js) ------------------------
  // A pick that has held still for 4.5s (elia, 2026-10-08) cross-fades to its trailer, muted, for
  // 25s (50s once unmuted), then back to the art and on to the next pick.
  // Anything the viewer does — moving down to the shelves, the rotation
  // moving, leaving the screen — ends it at once. The player exists only
  // while a trailer plays. What plays is resolved first (trailers.ts: Apple's
  // trailer, else a YouTube one resolved on this TV); a title with neither
  // stays on its art, quietly, for the rest of the visit.
  const [trailer, setTrailer] = useState<{t: ResolvedTrailer; key: number} | null>(null);
  const [trailerOn, setTrailerOn] = useState(false);
  const [unmuted, setUnmuted] = useState(false);
  const trailerFade = useRef(new Animated.Value(0)).current;
  const trailerBusy = useRef(false);
  const trailerGen = useRef(0);
  const trailerHandle = useRef<TrailerHandle | null>(null);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef(0);
  const unmutedRef = useRef(false);
  const noTrailer = useRef(new Set<string>()); // YouTube keys and titles that failed once this visit
  const heroTrailersPref = useRef(true);
  useEffect(() => {
    loadPrefs().then(p => {
      heroTrailersPref.current = p.heroTrailers !== false;
    });
  }, []);
  // Trailers are a treat, not a loop. A TV left on Home used to play one
  // after another for as long as it sat there (the usage stats: ~80 trailer
  // starts per visit to Home, and the trailer player's own errors) — each one
  // a YouTube player the box has to run. Two per visit now; coming back to
  // Home starts the count again. And on a box that is struggling as it is
  // (perfTier.ts) there are none: the backdrops still rotate.
  const trailersThisVisit = useRef(0);
  // When the billboard first had a pick to show this run (see the prepare below).
  const heroSince = useRef(0);
  useEffect(() => {
    if (!live) return;
    trailersThisVisit.current = 0;
    // judge the box once Home has had a few seconds to settle
    const t = setTimeout(() => {
      measureOnce();
    }, 5000);
    return () => clearTimeout(t);
  }, [live]);

  const stopTrailer = useCallback(
    (advance = false) => {
      trailerGen.current++;
      trailerBusy.current = false;
      if (capTimer.current) clearTimeout(capTimer.current);
      capTimer.current = null;
      unmutedRef.current = false;
      setUnmuted(false);
      if (trailerOnRef.current) {
        trailerOnRef.current = false;
        setTrailerOn(false);
        // The fade, then the player goes. When Home is LEAVING (a press on
        // Play, Details, a card) this screen is frozen a frame later
        // (freezeOnBlur), and a frozen screen does not commit state: the
        // setTrailer(null) waits until Home is shown again, and the old
        // WebView used to sit under the player all film long still decoding
        // behind it. So the trailer is also told to stop for good the moment
        // the fade has finished, and the unmount follows on return.
        Animated.timing(trailerFade, {toValue: 0, duration: 700, useNativeDriver: true, isInteraction: false}).start(() => {
          trailerHandle.current?.cmd('stop');
          setTrailer(null);
        });
        if (advance) {
          holdUntil.current = 0;
          setHeroIdx(i => (i + 1) % Math.max(1, heroes.length));
        }
      } else {
        setTrailer(null);
      }
    },
    [trailerFade, heroes.length],
  );
  const trailerOnRef = useRef(false);
  const armCap = useCallback(() => {
    if (capTimer.current) clearTimeout(capTimer.current);
    const cap = (unmutedRef.current ? 50 : 25) * 1000;
    capTimer.current = setTimeout(() => stopTrailer(true), Math.max(0, startedAt.current + cap - Date.now()));
  }, [stopTrailer]);
  const onTrailerState = useCallback(
    (s: TrailerState) => {
      if (s === 'playing' && !trailerOnRef.current) {
        trailerOnRef.current = true;
        startedAt.current = Date.now();
        setTrailerOn(true);
        trailersThisVisit.current++;
        track('feat', {f: 'trailer_play'});
        Animated.timing(trailerFade, {toValue: 1, duration: 800, useNativeDriver: true, isInteraction: false}).start();
        armCap();
      } else if (s === 'ended') {
        stopTrailer(true);
      } else if (s === 'error') {
        // (TrailerFrame has already reported it and retried a YouTube stream once)
        if (trailer?.t.ytId) noTrailer.current.add(trailer.t.ytId);
        if (trailer?.t.source === 'apple' && trailer.t.imdbId) noTrailer.current.add(trailer.t.imdbId);
        stopTrailer(false);
      }
    },
    [armCap, stopTrailer, trailer, trailerFade],
  );
  // Arm on every new pick; the cleanup is what ends a trailer when the pick
  // changes or the screen goes away.
  const heroNow = heroes[heroIdx % Math.max(1, heroes.length)] || null;
  const heroId = heroNow ? heroNow.id || heroNow.imdbId : null;
  // Bumped when the nav rail closes over the hero: the pick's hold starts
  // again, as for a fresh pick (the rail opening stopped it — below).
  const [railEpoch, setRailEpoch] = useState(0);
  useEffect(() => {
    const hero = heroNow;
    if (hero && !heroSince.current) heroSince.current = Date.now();
    if (!live || !hero || !heroTrailersPref.current) return;
    if (!hero.imdbId || noTrailer.current.has(hero.imdbId)) return;
    if (isLite() || trailersThisVisit.current >= 2) return;
    const gen = ++trailerGen.current;
    trailerBusy.current = false;
    // Resolve NOW, during the hold, not when it ends (elia, 2026-10-09): the
    // 1-2 s of lookups run while the still art shows, so the trailer is ready
    // at 4.5 s. prepareTrailer remembers the answer for the visit.
    //
    // Except in the first 2 s after the billboard first appears (in effect:
    // the first pick of a run), when the lookups wait: at launch they (a
    // metadata read, /api/trailer, and for YouTube the extractor's network and
    // deciphering on a pool thread) ran against the first posters and the hero
    // backdrop on the same few cores.
    // The trailer still cannot start before 4.5 s, and 2 s + the 1-2 s of
    // lookups is inside that; only a lookup slower than 2.5 s now ends later
    // than it did (the 4.5 s timer waits for it, as it always has).
    const holdPrep = Math.max(0, heroSince.current + FIRST_PREP_DELAY_MS - Date.now());
    const prep: Promise<ResolvedTrailer | null> = (async () => {
      if (holdPrep) {
        await new Promise<void>(r => setTimeout(r, holdPrep));
        if (gen !== trailerGen.current) return null;
      }
      let keys: string[] = [];
      try {
        // the keys this TV already knows — what plays if the server is one
        // without /api/trailer (an older nufurora.com) or cannot be asked
        const m = await api.discoverMeta(hero.type === 'show' ? 'series' : 'movie', hero.imdbId!);
        keys = m.trailers || [];
      } catch {}
      if (gen !== trailerGen.current) return null;
      try {
        return await prepareTrailer({
          imdbId: hero.imdbId,
          type: hero.type === 'show' ? 'show' : 'movie',
          title: hero.title,
          year: hero.year,
          youtubeIds: keys,
          maxYoutube: 2,
          skip: noTrailer.current,
        });
      } catch {
        return null;
      }
    })();
    const timer = setTimeout(async () => {
      if (gen !== trailerGen.current || !isTop.current || railOpen()) return;
      trailerBusy.current = true; // holds the rotation while the trailer runs
      const t = await prep;
      if (!t && gen === trailerGen.current) noTrailer.current.add(hero.imdbId!);
      if (gen !== trailerGen.current || !isTop.current || railOpen() || !t) {
        trailerBusy.current = false;
        return;
      }
      setTrailer({t, key: gen});
    }, 4500);
    return () => {
      clearTimeout(timer);
      stopTrailer(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroId, live, railEpoch]);
  const toggleMute = useCallback(() => {
    if (!trailerOnRef.current) return;
    const next = !unmutedRef.current;
    unmutedRef.current = next;
    setUnmuted(next);
    trailerHandle.current?.cmd(next ? 'unmute' : 'mute');
    if (next) {
      track('feat', {f: 'trailer_unmute'});
      armCap();
    }
  }, [armCap]);

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
    curRow.current = -1;
    setTop(true);
    slideTo(0);
  }, [setTop, slideTo]);

  // THE HERO'S OWN KEYS (elia, 2026-10-06): RIGHT on the last button and LEFT
  // on the first move the billboard a slide, the way the site's dots do with a
  // mouse; UP from any of its buttons opens the nav rail, and so does LEFT
  // from the first one (elia, 2026-10-08: LEFT is "go to the menu" everywhere
  // else on the screen, so it is here too; RIGHT on the last button still
  // turns the slide). The
  // button that holds focus reports its index; `focusJustMoved` keeps a press
  // that merely moved focus between the buttons from also turning the slide.
  const heroBtn = useRef(-1); // index of the focused hero button, -1 = not in the band
  const heroBtnCount = useRef(2);
  // How many buttons the hero band draws right now — the handler's "last button".
  heroBtnCount.current = 2 + (trailerOn ? 1 : 0) + Math.min(2, parties.length);
  const turnHero = useCallback(
    (dir: 1 | -1) => {
      if (heroes.length < 2) return;
      holdUntil.current = Date.now() + 15000;
      if (trailerBusy.current || trailerOnRef.current) stopTrailer(false);
      setHeroIdx(i => (i + dir + heroes.length) % heroes.length);
    },
    [heroes.length, stopTrailer],
  );
  // The hero button the rail was summoned from (UP / LEFT above), so closing
  // it can tell whether that button is still there.
  const railFromBtn = useRef(-1);
  useTVKeys(
    useCallback(
      (evt: {eventType: string}) => {
        const t = evt.eventType;
        if (heroBtn.current < 0 || !isTop.current) return;
        if (t === 'up' || (t === 'left' && heroBtn.current === 0)) {
          railFromBtn.current = heroBtn.current;
          requestRailOpen();
          return;
        }
        if (focusJustMoved(120)) return;
        if (t === 'right' && heroBtn.current === heroBtnCount.current - 1) turnHero(1);
      },
      [turnHero],
    ),
  );
  // THE RAIL OPENS OVER A TRAILER (Mi TV, 2026-10-09): the start check reads
  // `railOpen()`, but nothing stopped a trailer already running, so it played
  // on behind the panel. Opening the rail now ends it — and any pending hold —
  // by the same path as moving down to the shelves; closing it over the hero
  // re-arms the hold for the pick on show.
  useEffect(() => {
    if (!live) return;
    let stoppedPlaying = false;
    const offOpen = onRailOpen(() => {
      stoppedPlaying = trailerOnRef.current;
      stopTrailer(false);
    });
    const offClose = onRailClose(() => {
      // The rail hands focus back to the button it was opened from; when that
      // was Unmute, it went with the trailer, so Play takes it instead.
      if (stoppedPlaying && railFromBtn.current === 2 && isTop.current) {
        setTimeout(() => (escape.current as {requestTVFocus?: () => void} | null)?.requestTVFocus?.(), 0);
      }
      stoppedPlaying = false;
      railFromBtn.current = -1;
      if (isTop.current) setRailEpoch(e => e + 1);
    });
    return () => {
      offOpen();
      offClose();
    };
  }, [live, stopTrailer]);
  const onHeroBtn = useCallback(
    (i: number) => (f: boolean) => {
      if (f) {
        heroBtn.current = i;
        toHero();
      } else if (heroBtn.current === i) heroBtn.current = -1;
    },
    [toHero],
  );

  const toRow = useCallback(
    (index: number) => {
      curRow.current = index;
      setTop(false);
      if (trailerBusy.current || trailerOnRef.current) stopTrailer(false);
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
      slideTo(-Math.min(Math.max(0, y - spacing.pageY), max));
      // Mounting another shelf changes what is mounted, so it goes off the input
      // path — a held DOWN must never wait for a row to render.
      defer(() => setReach(r => (index + 3 > r ? index + 3 : r)));
    },
    [setTop, slideTo, height, stopTrailer],
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

  // The rows have drawn once: now the shelves the first commit left out (see
  // `reach`). A frame later, and as a transition, so it never sits in front of
  // the first picture or a keypress.
  const hasRows = (data?.rows?.length || 0) > 0;
  const rowCount = data?.rows?.length || 0;
  useEffect(() => {
    if (!hasRows) return;
    // only when there ARE more shelves to mount — otherwise the column never
    // grows and there is nothing to settle
    settling.current = rowCount > 2 && reach < 3;
    const raf = requestAnimationFrame(() => defer(() => setReach(r => (r < 3 ? 3 : r))));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRows]);

  // ONE function for every shelf (Row hands its index back). This used to be
  // an arrow written inside renderRow — a new function per row on every Home
  // render, so React.memo(Row) and, through Row's focusCard, React.memo(Card)
  // never held: the hero rotating, a new shelf being reached, a party list
  // arriving each re-rendered every mounted card (the storm motion.ts's
  // useSlide note describes, re-opened).
  const onRowItemFocus = useCallback(
    (it: HeroItem, rowIndex: number) => {
      toRow(rowIndex);
      warmItem(it);
    },
    [toRow],
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
          onItemFocus={onRowItemFocus}
          rowIndex={i}
          showKind
          wide={r.id === 'continue'}
          onRemove={r.id === 'continue' ? removeFromContinue : undefined}
        />
      </View>
    ),
    [openDetail, onRowItemFocus, removeFromContinue],
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
  const artRaw = hero?.backdrop || hero?.cover || null;
  const art = artRaw ? heroLayers(artRaw, width) : null;
  // The scrolled layer exists only for the pick it was mounted for: once the
  // billboard has rotated past it (up at the top, where it is invisible) it is
  // dropped rather than left holding a stale picture, and it is mounted again
  // for the new pick when focus next leaves the hero.
  const n = Math.max(1, heroes.length);
  const scrolledArt = scrolledIdx >= 0 && scrolledIdx % n === heroIdx % n ? art : null;
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
      {/* The artwork is a FIXED layer behind the column that FADES with the
          scroll (elia, 2026-10-07: "under the hero on home it gets cut and it's
          noticeable"). Scrolling WITH the column left a seam where the layer
          ended — the veil's baked colour met the live ambient under the rows,
          a horizon line a third of the way down the screen once the hero had
          scrolled off. Fixed and fading, the art is gone by the time the
          shelves reach the undissolved part of it (the §1.5 objection), and the
          rows always sit on the real background: nothing to meet, no edge. */}
      <Animated.View
        style={[
          styles.artFade,
          {opacity: artFadeOpacity},
        ]}
        pointerEvents="none">
      {art ? (
        <HeroArt art={art} scrolledArt={scrolledArt} atTop={atTop} h={height}>
          {trailer ? (
            <Animated.View style={[styles.trailerLayer, {opacity: trailerFade}]} pointerEvents="none">
              <TrailerFrame
                key={trailer.key}
                trailer={trailer.t}
                muted
                hero
                handle={trailerHandle}
                onState={onTrailerState}
                // 16:9 at 15% over the window: the trailer's own letterbox
                // and burnt-in edges sit outside the frame (the site does the
                // same).
                style={{
                  position: 'absolute',
                  width: Math.round(width * 1.15),
                  height: Math.round((width * 1.15 * 9) / 16),
                  left: -Math.round(width * 0.075),
                  top: Math.round((height - (width * 1.15 * 9) / 16) / 2),
                }}
              />
            </Animated.View>
          ) : null}
        </HeroArt>
      ) : null}
      </Animated.View>
      <Animated.View
        style={[styles.column, {transform: [{translateY: ty.value}]}]}
        onLayout={e => {
          const h = e.nativeEvent.layout.height;
          const grew = h > colH.current;
          colH.current = h;
          // The column has just reached its usual first height (see `reach`):
          // a shelf focused while it was short is sent to where it belongs.
          if (settling.current && grew && reach >= 3) {
            settling.current = false;
            if (curRow.current >= 0) toRow(curRow.current);
          }
        }}
        pointerEvents="box-none">
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
                    {translateX: swapX},
                  ],
                },
              ]}>
            <View style={[styles.info, {maxWidth: Math.round(width * 0.46)}]}>
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
                style={[styles.synopsis, {maxWidth: Math.round(width * 0.42)}]}
                numberOfLines={2}>
                {hero.synopsis}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Btn
                primary
                ref={escape}
                // A stream is a slow start the viewer may not want: the warning
                // sign says so before the press (elia, 2026-10-06).
                icon="play"
                label={hero.source === 'stream' ? 'Stream' : 'Play'}
                hasTVPreferredFocus
                // Not edgeLeft: LEFT here is "previous slide"; UP opens the rail.
                onFocusChange={onHeroBtn(0)}
                onPress={() => {
                  holdUntil.current = Date.now() + 15000;
                  heroPlay(hero);
                }}
              />
              <Btn
                icon="info"
                label="Details"
                onFocusChange={onHeroBtn(1)}
                onPress={() => openDetail(hero)}
              />
              {trailerOn ? (
                <Btn
                  small
                  glyph={unmuted ? '🔊' : '🔇'}
                  label={unmuted ? 'Mute' : 'Unmute'}
                  onFocusChange={onHeroBtn(2)}
                  onPress={toggleMute}
                />
              ) : null}
              {parties.slice(0, 2).map((p, i) => (
                <Btn
                  key={p.code}
                  small
                  glyph="👥"
                  label={`Join ${p.host}'s party`}
                  onFocusChange={onHeroBtn(2 + (trailerOn ? 1 : 0) + i)}
                  onPress={() => joinParty(p)}
                />
              ))}
            </View>
            {parties.length ? (
              <Text style={styles.partyNote} numberOfLines={1}>
                {parties.slice(0, 2).map(p => `${p.host} is watching ${p.title} · ${p.members} in · code ${p.code}`).join('   ·   ')}
              </Text>
            ) : null}
            </View>
            {/* No poster beside the lockup any more (elia, 2026-10-06): the
                backdrop IS the picture, and the card competed with it. */}
            </Animated.View>
            {/* `.hero-dots` (screens.css:221-248). DRAWN, not focusable — the
                site's are <button>s because a mouse needs a target; on a D-pad
                they would be extra stops in the hero band for something the
                rotation already does. Same call as the card's ✕ (P12). */}
            {heroes.length > 1 ? (
              <View style={[styles.dots, {bottom: heroPadBottom + 20}]} pointerEvents="none">
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
  artFade: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  art: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%'},
  // `brightness()` as the scrim it implies. NOT --bg: painting the page colour
  // over the art is what screens.css:13-20 rejects.
  artDim: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000000'},
  // hero-side (72% wide) + ambient-veil (full), baked into one full-window layer
  artScrim: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%'},

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
  // Brighter than --text-dim: over artwork the dim grey was hard to read
  // (elia). Near-white at 0.88 with the shadow doing the lifting.
  synopsis: {
    color: 'rgba(243,244,248,0.88)',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 8,
    marginBottom: 13,
  },
  // `.hero-kind` — the smallest element in the lockup, and it answers "what am I
  // looking at" before you have read a word of the name.
  kicker: {fontSize: 12, fontWeight: '900', letterSpacing: 2, marginBottom: 4},
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
  actions: {flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm + 4, flexWrap: 'wrap', alignItems: 'center'},
  partyNote: {color: colors.textDim, fontSize: fontSize.small, fontWeight: '600', marginTop: 8},
  trailerLayer: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000'},

  // right: --page-x, bottom: 22px → 11dp (page rhythm, ×0.505). The 8dp dot is a
  // graphic at ×1.0; the site's 7px button padding becomes the gap that keeps
  // them apart.
  // glass.css `.hero-dots`: 7dp dots at 0.36, the current one a 22-wide lit
  // pill, sitting on the action buttons' row at the page's right edge.
  dots: {position: 'absolute', right: spacing.pageX, flexDirection: 'row', alignItems: 'center', gap: 5},
  dot: {width: 7, height: 7, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.36)'},
  dotOn: {width: 22, backgroundColor: '#ffffff', boxShadow: '0 0 10px rgba(255,255,255,0.5)'},

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
