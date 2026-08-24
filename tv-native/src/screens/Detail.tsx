// Detail page. Three shapes:
//   • library movie  → Play button (→ Player)
//   • library show   → season rail + episode list (each episode → Player)
//   • stream title   → info from the passed home item; movies → Sources,
//                      shows → Cinemeta episodes → Sources by (season, episode)
// My List toggle works for library items (by id) and stream titles (by ref).
//
// Shows use a fixed two-pane 10-foot layout instead of one long scroll page:
// left rail = My List + seasons, right pane = the episodes of the selected
// season in their own FlatList (focused rows scroll into view). From anywhere
// in the episode list one LEFT press reaches the rail — no climbing back up
// through every episode.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  Image,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  BackHandler,
  TVFocusGuideView,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useIsFocused} from '@react-navigation/native';
import Focusable from '../components/Focusable';
import Card, {CARD_W} from '../components/Card';
import NavRail from '../components/NavRail';
import {api, imgSrc, ImgSource, Item, Episode, HeroItem, Progress, StreamRef, DiscoverMeta} from '../api';
import {canNavigate} from '../navLock';
import {useFocusFallback, useKeyTrap} from '../focus';
import {SourcesPanel} from './Sources';
import {useApp} from '../AppContext';
import type {NavSection} from '../navSection';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

// tools/gen_side_scrim.py — the left-to-right and bottom-up ramps that let the
// artwork stay ARTWORK while the title lockup sits on it (see DetailHero).
const HERO_SIDE = require('../assets/hero-side.png');
// The taller veil — Detail's hero runs further down the screen than Home's.
// See the note in Home.tsx for why this is a veil and not an opaque ramp.
const HERO_VEIL = require('../assets/ambient-veil-tall.png');

const {colors, radius, fontSize, spacing} = theme;

const isStream = (it: HeroItem) => it.source === 'stream' || !it.id;

// Taller than the old 64: the row carries a second line now (runtime, badges,
// synopsis), matching the site's reworked episode list.
// The rail's card: a 16:9 still plus two lines under it. Sized so a 540dp screen
// shows four and a half of them — enough that the row obviously scrolls.
const EP_W = 202;
// The ART is not EP_W wide. `Focusable` reserves its 3dp ring INSIDE the box it
// is given (RN is border-box), so a Focusable at EP_W has a 196dp content area —
// and the 16:9 still has to be derived from THAT, or the ring and the artwork
// disagree. They did: the still was an absolute EP_THUMB_H inside a content box
// 6dp shorter, so it hung 6dp below the ring. Measured on the Streamer before
// the fix — ring 320.5..433.0dp, artwork 320.5..439.0dp.
const EP_ART_W = EP_W - theme.focus.borderWidth * 2;
const EP_ART_H = Math.round((EP_ART_W * 9) / 16);
// What the Focusable is given, so its CONTENT box is exactly the still.
const EP_THUMB_H = EP_ART_H + theme.focus.borderWidth * 2;
const SEASON_H = 54;
// The whole dock: thumb + title + facts + padding, plus room for the focus glow.
const RAIL_H = EP_THUMB_H + 62 + theme.CLEARANCE.above * 2;

// ui.js fmtDuration, ported.
const fmtDuration = (seconds?: number) => {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};
// ui.js fmtBytes / resBadge, ported — the site puts both on the detail page and
// they are exactly the two facts that tell you what you actually have on disk.
const fmtBytes = (b?: number) => {
  if (!b) return '';
  const gb = b / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
};
const resBadge = (height?: number) => {
  if (!height) return null;
  if (height >= 2000) return '4K';
  if (height >= 1000) return 'HD';
  if (height >= 700) return '720p';
  return 'SD';
};
// Cinemeta hands back HTML-escaped text — "Josh O&apos;Connor" rendered
// literally on the page. A browser decodes entities for free when it sets
// textContent; RN's <Text> does not, so the five that actually occur are decoded
// here. (A general decoder would be a parser for a problem this isn't.)
const unescapeHtml = (t?: string) =>
  (t || '')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

const fmtClock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`;
};

// Resolve a library title to its IMDb id, RETRYING WITHOUT THE YEAR.
//
// The year is a disambiguator, and when it disagrees with the catalogue's it
// excludes the only right answer instead of narrowing the field. Measured on the
// live server: `Disclosure Day` resolves to tt15047880 with no year and to
// nothing at all with &year=2020 — which is why Sources came up empty for it.
const resolveImdb = async (
  kind: 'movie' | 'show',
  title: string,
  year?: number,
): Promise<string | null> => {
  try {
    if (year) {
      const withYear = await api.imdbFor(kind, title, year);
      if (withYear.imdbId) return withYear.imdbId;
    }
    const plain = await api.imdbFor(kind, title);
    return plain.imdbId || null;
  } catch {
    return null;
  }
};

// Find a library item for a STREAMED title — the site's libMatch/findInLibrary
// (discover-detail.js), ported verbatim. Exact normalized title first, then a
// prefix match with the year agreeing: folder names carry extra words, and a
// copy of Avatar (2009) sitting in a folder called "Avatar Movie" is still your
// copy. This is what lets a Discover card's page say "Play" instead of sending
// you to stream a film the server already holds on disk.
const libNorm = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const libMatch = <T extends {title: string; year?: number}>(
  pool: T[],
  title: string,
  year?: number | null,
): T | null => {
  const want = libNorm(title);
  if (!want) return null;
  const exact = pool.find(i => libNorm(i.title) === want);
  if (exact) return exact;
  return (
    pool.find(i => {
      const have = libNorm(i.title);
      // STRICTER than the site's version, deliberately: on the site a wrong
      // prefix match only mislabels a button, but here it decides what the hero
      // Play button and the sources redirect actually PLAY. So the fuzzy branch
      // requires both years present and agreeing — "alien" must not bind to an
      // unyeared "Alien Resurrection" folder. A library folder without a year
      // can still exact-match above; it just doesn't get the fuzzy benefit.
      if (!year || !i.year || Math.abs(i.year - year) > 1) return false;
      if (Math.min(have.length, want.length) < 4) return false;
      return have.startsWith(want) || want.startsWith(have);
    }) || null
  );
};

// .badge — the small outlined facts (certificate, resolution, CC).
const Badge = ({text}: {text: string}) => (
  <View style={styles.badge}>
    <Text style={styles.badgeText}>{text}</Text>
  </View>
);
// The detail hero, rebuilt for a 10-foot screen.
//
// The previous version was the site's `.detail-hero` transplanted: poster left,
// a column of facts beside it, everything packed against the top of the page
// under a heavily dimmed backdrop. On a 1280px page that is generous; on a 540dp
// TV it is a wall of text with the artwork hidden behind it — "claustrophobic"
// is exactly right.
//
// This is the Apple TV shape instead:
//
//   • The ARTWORK IS THE PAGE. Full-bleed, barely dimmed, no poster competing
//     with it — the backdrop already shows you what the title is.
//   • The lockup sits in the LEFT 52%, low, over a horizontal ramp (HERO_SIDE)
//     that darkens only the side the type is on. A flat dim over everything is
//     what made the art look broken rather than composed.
//   • One line of facts, one clamped paragraph, one row of buttons. Anything
//     more belongs below the fold, which is where the episode rail lives.
//
// `bottomInset` reserves the rail's height on a show page so the lockup lands
// above it instead of behind it.
function DetailHero({
  kicker,
  title,
  rating,
  metaParts,
  badges,
  genres,
  synopsis,
  synopsisLines = 2,
  cast,
  note,
  dense,
  bottomInset = 0,
  children,
}: {
  kicker: string;
  title: string;
  rating?: number | null;
  metaParts: (string | number | false | null | undefined)[];
  badges: (string | null | undefined)[];
  genres?: string[];
  synopsis?: string;
  synopsisLines?: number;
  cast?: string[];
  note?: string;
  // A show page keeps a season dock pinned under the hero, so the lockup has
  // roughly 180dp to live in rather than the whole frame. Dense drops the title
  // to the section size and the genre line entirely — without it the title ran
  // up off the top of the screen and under the nav.
  dense?: boolean;
  bottomInset?: number;
  children?: React.ReactNode; // the actions row
}) {
  const meta = metaParts.filter(Boolean).map(String);
  const badgeList = badges.filter(Boolean) as string[];
  return (
    <View style={[styles.hero, {paddingBottom: bottomInset + spacing.lg}]} pointerEvents="box-none">
      <View style={styles.lockup} pointerEvents="box-none">
        {/* No kicker in dense mode. "SERIES" is 22dp of vertical budget spent
            saying what the season pills and the episode rail below already say,
            and it was the line that ended up tucked behind the nav. */}
        {dense ? null : <Text style={styles.kicker}>{kicker}</Text>}
        <Text style={[styles.title, dense && styles.titleDense]} numberOfLines={dense ? 1 : 2}>
          {unescapeHtml(title)}
        </Text>
        <View style={styles.metaRow}>
          {rating ? <Text style={styles.rating}>{`★ ${rating}`}</Text> : null}
          {meta.length ? <Text style={styles.meta}>{meta.join('  ·  ')}</Text> : null}
          {badgeList.map(b => (
            <Badge key={b} text={b} />
          ))}
        </View>
        {genres && genres.length ? (
          <Text style={styles.genreLine} numberOfLines={1}>
            {genres.slice(0, 4).join('  ·  ')}
          </Text>
        ) : null}
        {synopsis ? (
          <Text style={styles.synopsis} numberOfLines={synopsisLines}>
            {unescapeHtml(synopsis)}
          </Text>
        ) : null}
        {cast && cast.length ? (
          <Text style={styles.cast} numberOfLines={1}>
            <Text style={styles.castLabel}>Cast </Text>
            {unescapeHtml(cast.slice(0, 4).join(', '))}
          </Text>
        ) : null}
        {children ? (
          <View style={[styles.actions, dense && styles.actionsDense]}>{children}</View>
        ) : null}
        {note ? <Text style={styles.note}>{note}</Text> : null}
      </View>
    </View>
  );
}

// The backdrop stack every detail page sits on: art, a light overall dim, the
// left ramp that carries the type, and the bottom ramp that lands the page.
function HeroArt({art, sharp}: {art?: ImgSource | null; sharp: boolean}) {
  if (!art) return <View style={styles.artFallback} />;
  return (
    <>
      <Image
        source={art}
        style={styles.art}
        resizeMode="cover"
        resizeMethod="resize"
        // FADE IN, do not pop. Measured on the Streamer: the screen itself
        // swaps in ~130ms after the press, and then the backdrop arrived about
        // 1.1s later and changed 13% of the frame in a single step — that hard
        // slam is the "glitch when opening details". The fetch is over the
        // internet (metahub), so it cannot be made instant; what it can be is
        // gradual, which reads as the page settling rather than as a fault.
        // Every other Image in the app keeps fadeDuration={0} on purpose — a
        // shelf of posters must not feel late — but this is one full-screen
        // element whose arrival is the most visible event on the page.
        fadeDuration={260}
        // A real backdrop stays SHARP — it is the composition. Only a poster
        // pressed into service as one gets blurred, because a 2:3 image stretched
        // across a 16:9 frame is not artwork, it is an artefact.
        blurRadius={sharp ? 0 : 28}
      />
      <View style={styles.artDim} />
      <Image source={HERO_SIDE} style={styles.artSide} resizeMode="stretch" />
      <Image source={HERO_VEIL} style={styles.artVeil} resizeMode="stretch" />
    </>
  );
}

// The two button shapes the site uses on this page: .btn.btn-primary (white
// fill, violet offset ring on focus) and .btn (surface).
const PrimaryBtn = ({
  label,
  hasTVPreferredFocus,
  edgeLeft,
  onPress,
}: {
  label: string;
  hasTVPreferredFocus?: boolean;
  edgeLeft?: boolean;
  onPress: () => void;
}) => (
  <Focusable
    round
    light
    ring="violet"
    hasTVPreferredFocus={hasTVPreferredFocus}
    edgeLeft={edgeLeft}
    onPress={onPress}
    style={styles.playBtn}>
    <Text style={styles.playText}>{label}</Text>
  </Focusable>
);
const GhostBtn = ({
  label,
  hasTVPreferredFocus,
  edgeLeft,
  onPress,
  ref,
}: {
  label: string;
  hasTVPreferredFocus?: boolean;
  edgeLeft?: boolean;
  onPress: () => void;
  // Forwarded to the Focusable so the page can register one of these as its
  // focus fallback (requestTVFocus lives on the host instance).
  ref?: React.Ref<View>;
}) => (
  <Focusable
    round
    ref={ref}
    hasTVPreferredFocus={hasTVPreferredFocus}
    edgeLeft={edgeLeft}
    onPress={onPress}
    style={styles.ghost}>
    <Text style={styles.ghostText}>{label}</Text>
  </Focusable>
);

type UiEp = {
  key: string;
  num: number;
  label: string;
  onPlay: () => void;
  // Everything below mirrors the site's .episode row.
  owned?: boolean; // in the library, so it plays instantly
  durationLabel?: string;
  hasSubs?: boolean;
  watched?: boolean;
  pct?: number; // part-watched progress, 0..100
  overview?: string;
  thumb?: string | null;
};
type UiSeason = {number: number; episodes: UiEp[]};

// One episode as a CARD in the season rail: a 16:9 still, the number and name
// under it, then the facts. This is how a TV shows a season — the old full-width
// rows were a settings list with pictures missing, and only three of them fitted
// on screen.
const EpisodeCard = React.memo(function EpisodeCardItem({ep, edgeLeft}: {ep: UiEp; edgeLeft?: boolean}) {
  // The focus treatment wraps the WHOLE card — still, title and badges.
  //
  // It used to wrap only the artwork, on the argument that a ring around a
  // transparent card encloses empty space. elia asked for the whole card
  // (2026-08-04), which is also what the site does: `.episode` is one focusable
  // element containing its own caption. The title and badges now light up with
  // the still instead of sitting outside it.
  return (
    <Focusable
      scaleTo={1.045}
      lift={theme.cardAura.lift}
      shadow={theme.cardAura.shadow}
      edgeLeft={edgeLeft}
      onPress={ep.onPlay}
      style={styles.epCard}>
        <View style={styles.epThumb}>
          {ep.thumb ? (
            <Image
              source={imgSrc(ep.thumb) as ImgSource}
              style={styles.epThumbImg}
              resizeMode="cover"
              resizeMethod="resize"
              fadeDuration={0}
            />
          ) : null}
          {/* The number lives ON the still, like Apple TV's, so the line below is
              free for the name at a readable size. */}
          <Text style={styles.epNumOnArt}>{ep.num}</Text>
          {ep.owned ? <Text style={styles.epOwnedTag}>{'✓'}</Text> : null}
          {ep.pct ? (
            <View style={styles.epBar} pointerEvents="none">
              <View style={[styles.epBarFill, {width: `${ep.pct}%`}]} />
            </View>
          ) : null}
        </View>
      <Text style={styles.epTitle} numberOfLines={1}>
        {unescapeHtml(ep.label)}
      </Text>
      <View style={styles.epSub}>
        {ep.durationLabel ? <Text style={styles.epDur}>{ep.durationLabel}</Text> : null}
        {ep.hasSubs ? <Text style={styles.epBadge}>CC</Text> : null}
        {ep.watched ? <Text style={styles.epBadge}>WATCHED</Text> : null}
        {!ep.owned ? <Text style={styles.epBadge}>STREAM</Text> : null}
      </View>
    </Focusable>
  );
});

export default function Detail({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'Detail'>) {
  const {item} = route.params;
  const {profileId} = useApp();
  // Which nav section this title belongs to. Computed once: inside the movie
  // branch TypeScript has already narrowed item.type, so an inline comparison
  // against 'show' there is a type error rather than a runtime one.
  const navSection: NavSection = item.type === 'show' ? 'shows' : 'movies';
  const {width, safeBottom} = useTvMetrics();
  const stream = isStream(item);

  const [full, setFull] = useState<Item | null>(null);
  // Watch progress for this profile, so an episode row can say "Watched" and
  // carry a part-watched bar the way the site's does.
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [streamMeta, setStreamMeta] = useState<DiscoverMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [season, setSeason] = useState<number | null>(null);
  const [inList, setInList] = useState(false);
  // The inline sources panel. `null` = closed. A whole screen for one list threw
  // away most of a 960dp display and made picking a source feel like leaving the
  // title behind; for a show it also hid the episode you had just chosen. Both
  // now happen ON this page — see the panel at the bottom of the render.
  const [srcPanel, setSrcPanel] = useState<{
    type: 'movie' | 'series';
    imdbId: string;
    season?: number | null;
    episode?: number | null;
    label?: string;
    sub?: string;
  } | null>(null);

  // Bumped when a download finishes while this page is open (the sources panel
  // reports it) — both fetches below re-run, so the new copy on disk is offered
  // without leaving the page. The site does this off its download_update socket.
  const [libraryTick, setLibraryTick] = useState(0);

  // Where focus goes if it is ever lost on this page (a focused episode card
  // unmounting when the merged season list changes shape, for instance). The
  // My List button exists on every variant of this screen.
  const listBtnRef = useRef(null);
  useFocusFallback(listBtnRef);

  // Library items get their full record (movies: videoUrl; shows: seasons).
  //
  // THE GUARD IS `!item.id` ALONE. It used to be `stream || !item.id`, and that
  // `stream` term is why a DOWNLOADED EPISODE OPENED AS A STREAM: `source` says
  // which shelf the card came from, not whether the title is on disk. Open a show
  // you own from any card tagged `stream` and `full` was never fetched, so the
  // season/episode map below stayed empty, every episode came out `owned: false`,
  // and `onPlay` sent all of them to Sources instead of playing the local file.
  //
  // A genuine stream card carries no `id` at all (only `imdbId`), so `!item.id`
  // already covers the case the `stream` term was there for — this only ADDS the
  // fetch for items that do have a library id, which is exactly when we want it.
  useEffect(() => {
    if (!item.id) {
      setLoading(false);
      return;
    }
    let live = true;
    api
      .item(item.id, profileId)
      .then(f => {
        if (!live) return;
        setFull(f);
        if (f.seasons && f.seasons.length) {
          setSeason(prev => (prev == null ? f.seasons![0].number : prev));
        }
      })
      // A stub or a miss just leaves `full` null, which is what it was before.
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [item.id, profileId, libraryTick]);

  // A STREAM card can still be a title the server holds on disk — the card only
  // says which SHELF it came from. The site resolves this with findInLibrary and
  // prefers the copy everywhere; without this the TV's answer to a title it
  // already owned was "Stream now", which is the reported "prefers streamed
  // content even when downloaded is available". `inLibrary` (set by the server
  // on discover/catalog/search cards) is the fast path; a card that arrived
  // without one (hero, watchlist) gets the same title match the site does.
  useEffect(() => {
    if (!stream) return;
    let live = true;
    (async () => {
      try {
        let libId = item.inLibrary || null;
        if (!libId) {
          const l = await api.library();
          if (!live) return;
          const pool = item.type === 'show' ? l.shows : l.movies;
          libId = libMatch(pool, item.title, item.year)?.id || null;
        }
        if (!libId || !live) return;
        const f = await api.item(libId, profileId);
        if (!live) return;
        setFull(f);
        if (f.seasons && f.seasons.length) {
          setSeason(prev => (prev == null ? f.seasons![0].number : prev));
        }
      } catch {
        // No match (or the library call failed) just means the page stays a
        // stream page, which is what it was before.
      }
    })();
    return () => {
      live = false;
    };
  }, [stream, item.inLibrary, item.type, item.title, item.year, profileId, libraryTick]);

  // Seed the My List toggle from the server so an already-saved title shows
  // "✓ In My List" instead of "+ My List".
  useEffect(() => {
    let live = true;
    api
      .watchlist(profileId)
      .then(w => {
        if (!live) return;
        const key = item.imdbId || item.id;
        setInList(
          (w.items || []).some(
            x => (x.id && x.id === item.id) || (x.imdbId && x.imdbId === key),
          ),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profileId, item.id, item.imdbId]);

  // A LIBRARY show still needs Cinemeta's episode list.
  //
  // Without this the show's detail page listed only the episodes already on
  // disk, so once you had three of them the other nineteen were unreachable —
  // there was no way to fetch them. The site solved the same problem by
  // resolving a library title to its IMDb id (/api/imdb-for) and rendering ONE
  // merged list. `imdbId` is what Sources is keyed by, so it is needed anyway.
  const [libImdb, setLibImdb] = useState<string | null>(null);
  const imdbKind: 'movie' | 'show' = item.type === 'show' ? 'show' : 'movie';
  // Resolve the library title to its IMDb id. This used to be gated to
  // `item.type === 'show'`, which is why SOURCES WERE BROKEN FOR EVERY LIBRARY
  // FILM: with no id resolved, openSources fell back to the library key and the
  // provider answered with an empty list, which the Sources screen then reported
  // as "No sources with active peers". Measured against the live server: the
  // library id returns 0 streams, the real IMDb id returns 56 in 0.1s.
  useEffect(() => {
    if (stream) return; // a Discover title already carries its own id
    const known = item.imdbId || full?.imdbId;
    if (known) {
      setLibImdb(known);
      return;
    }
    if (!item.title) return;
    let live = true;
    resolveImdb(imdbKind, item.title, item.year)
      .then(id => live && id && setLibImdb(id))
      .catch(() => {}); // no id just means we fall back to the local list
    return () => {
      live = false;
    };
  }, [stream, imdbKind, item.imdbId, item.title, item.year, full?.imdbId]);

  // Cinemeta metadata for a LIBRARY title — the episode list for a show, the
  // cast and runtime for a film. Also previously shows-only, and keyed 'series'
  // regardless, so a film could never get either.
  useEffect(() => {
    if (stream || !libImdb) return;
    let live = true;
    api
      .discoverMeta(imdbKind === 'show' ? 'series' : 'movie', libImdb)
      .then(m => live && setStreamMeta(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [stream, libImdb, imdbKind]);

  // What Sources must be given. Resolving on PRESS as well as on mount closes
  // the race that remained even once the effect ran for films: pressing the
  // button in the first second of the page would still have sent the library id.
  // Returns null when the title genuinely cannot be resolved, and the caller
  // says so rather than opening a screen that can only be empty.
  const [srcNote, setSrcNote] = useState('');
  const ensureImdb = useCallback(async (): Promise<string | null> => {
    if (item.imdbId) return item.imdbId;
    if (libImdb) return libImdb;
    setSrcNote('Looking this title up…');
    try {
      const r = await api.imdbFor(imdbKind, item.title, item.year);
      if (r.imdbId) {
        setLibImdb(r.imdbId);
        setSrcNote('');
        return r.imdbId;
      }
    } catch {}
    setSrcNote('Could not match this title to a source catalogue.');
    setTimeout(() => setSrcNote(''), 4000);
    return null;
  }, [item.imdbId, item.title, item.year, imdbKind, libImdb]);

  // Stream shows: Cinemeta metadata for the episode list (episodes have no
  // library id — they're played by (season, episode) through Sources).
  useEffect(() => {
    if (!stream) return;
    let live = true;
    setLoading(true);
    api
      // Movies too, not just shows: the browser client fetches the full meta for
      // either, and the runtime it carries is what gives a torrent's scrubber a
      // real total length.
      .discoverMeta(item.type === 'show' ? 'series' : 'movie', item.imdbId || item.id)
      .then(m => {
        if (!live) return;
        setStreamMeta(m);
        // Functional: the library resolution above may already have picked a
        // season, and whichever landed first should not be overridden.
        if (m.seasons && m.seasons.length) {
          setSeason(prev => (prev == null ? m.seasons![0].number : prev));
        }
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [stream, item.type, item.imdbId, item.id]);

  const toggleList = async () => {
    const next = !inList;
    setInList(next); // optimistic
    try {
      if (stream) {
        const ref: StreamRef = {
          imdbId: item.imdbId || libImdb || item.id,
          // A saved stream ref is always one or the other; anything reaching here
          // without a type is a film as far as the watchlist is concerned.
          type: item.type || 'movie',
          title: item.title,
          poster: item.cover || item.poster,
          year: item.year,
          // Stored with the ref so My List's genre filter and rating sort work
          // for streamable titles (the server keeps only what it is sent).
          genres: genreSource.length ? genreSource : undefined,
          rating: item.rating ?? streamMeta?.rating ?? undefined,
        };
        await api.toggleWatchlist(profileId, ref, next);
      } else {
        await api.toggleWatchlist(profileId, item.id, next);
      }
    } catch {
      setInList(!next); // revert on failure
    }
  };

  // The one id a movie page plays and tracks progress against. A library card's
  // own id, or — for a stream card whose title the library-resolution effect
  // matched — the resolved copy's id. Null means there is nothing on disk and
  // the page is a genuine stream page.
  const ownedMovieId = !stream ? item.id : full?.videoUrl ? full.id : null;

  const playMovie = () => {
    if (!ownedMovieId || !canNavigate(navigation)) return;
    navigation.push('Player', {id: ownedMovieId, title: item.title});
  };
  // The site's `?restart=1`: same title, ignore the saved position. It is a
  // separate button rather than a prompt because the answer is obvious to the
  // person pressing it and a dialog would cost two presses to say so.
  const playFromStart = () => {
    if (!ownedMovieId || !canNavigate(navigation)) return;
    navigation.push('Player', {id: ownedMovieId, title: item.title, restart: true});
  };
  // Mark watched / unwatched, against the library id. The site saves a full-
  // duration progress entry rather than inventing a "watched" flag, so Continue
  // Watching and every progress bar agree with it for free.
  const movieProg = ownedMovieId ? progress[ownedMovieId] : undefined;
  const movieWatched = !!movieProg?.finished;
  const movieResume =
    movieProg && !movieProg.finished && movieProg.position > 10 ? movieProg.position : 0;
  const toggleWatched = async () => {
    if (!ownedMovieId) return;
    const dur = full?.duration || movieProg?.duration || 1;
    const next = !movieWatched;
    // Optimistic: the row redraws now, and a failure just leaves the server as
    // it was — this is a convenience, not a transaction.
    setProgress(p => ({
      ...p,
      [ownedMovieId]: next
        ? {position: dur, duration: dur, finished: true}
        : {position: 0, duration: dur, finished: false},
    }));
    try {
      if (next) await api.saveProgress(profileId, ownedMovieId, dur, dur);
      else await api.clearProgress(profileId, ownedMovieId);
    } catch {}
  };
  // ---- More like this -------------------------------------------------------
  // Neither the server nor the site has a per-title "similar" feature; the
  // closest designed-for-this surface is the genre catalog (/api/catalog) the
  // Browse tabs already page through — cached server-side, carries `inLibrary`,
  // and its cards open Detail exactly like a Browse card does. So "more like
  // this" is: the title's own genres, top-rated first, with the title itself
  // filtered out.
  const [likePanel, setLikePanel] = useState(false);
  const [similar, setSimilar] = useState<HeroItem[] | null>(null);
  const [similarErr, setSimilarErr] = useState(false);
  // First NON-EMPTY list, not `||`: a library record with `genres: []` is
  // truthy, so the plain-or chain stopped there and Cinemeta's genres were
  // never consulted — measured on the Streamer with Dune, whose empty library
  // genres turned "More like this" into a generic trending grid.
  const genreSource =
    [full?.genres, streamMeta?.genres, item.genres].find(g => g && g.length) || [];
  useEffect(() => {
    if (!likePanel || similar !== null) return;
    // Opened before the metadata landed: hold the fetch until the genres are
    // known (or the page has given up loading), or the panel would cache a
    // generic trending list for a title whose genres arrive a second later.
    if (genreSource.length === 0 && loading) return;
    let live = true;
    (async () => {
      const kind: 'movie' | 'show' = item.type === 'show' ? 'show' : 'movie';
      const selfImdb = item.imdbId || libImdb;
      const selfTitle = libNorm(item.title);
      const seen = new Set<string>();
      const pool: HeroItem[] = [];
      const take = (items: HeroItem[]) => {
        for (const s of items) {
          const key = s.imdbId || libNorm(s.title);
          if (!key || seen.has(key)) continue;
          if (selfImdb && s.imdbId === selfImdb) continue;
          if (libNorm(s.title) === selfTitle) continue;
          seen.add(key);
          // Tagged `stream` like a Browse card; a title the library holds still
          // opens right, because Detail's own library resolution runs on it
          // (fast-pathed by the `inLibrary` these cards carry).
          pool.push({...s, source: 'stream'});
        }
      };
      try {
        // Top-rated within the first genre is the strongest "like this" signal;
        // trending within the second widens it. No genres at all (rare) falls
        // back to plain trending, which is at least the same kind of thing.
        const wanted = genreSource.slice(0, 2);
        if (wanted.length === 0) {
          const r = await api.catalog({type: kind, category: 'trending', page: 0});
          take(r.items || []);
        } else {
          for (const [i, g] of wanted.entries()) {
            if (pool.length >= 18) break;
            const r = await api
              .catalog({type: kind, category: i === 0 ? 'top' : 'trending', genre: g, page: 0})
              .catch(() => ({items: [] as HeroItem[]}));
            take(r.items || []);
          }
        }
        if (!live) return;
        setSimilar(pool.slice(0, 18));
        setSimilarErr(pool.length === 0);
      } catch {
        if (!live) return;
        setSimilar([]);
        setSimilarErr(true);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [likePanel, similar, loading, genreSource.length]);

  // Closing the panel after a FAILED fetch clears the cached failure, so the
  // next open retries instead of showing "try again later" with no way to.
  const closeLikePanel = useCallback(() => {
    setLikePanel(false);
    if (similarErr) {
      setSimilar(null);
      setSimilarErr(false);
    }
  }, [similarErr]);

  // The panels trap focus, so every key handler outside them goes deaf (§5.8(a)).
  useKeyTrap(!!srcPanel);
  useKeyTrap(likePanel);

  // Back closes an open panel before it leaves the page — the same rule the
  // genre picker on Browse follows, and the reason the panels can afford to
  // cover the page at all.
  useEffect(() => {
    if (!srcPanel && !likePanel) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSrcPanel(null);
      closeLikePanel();
      return true;
    });
    return () => sub.remove();
  }, [srcPanel, likePanel, closeLikePanel]);

  const openSources = async () => {
    // isFocused, not canNavigate: canNavigate ALSO consumes navLock's 350ms
    // one-shot gate, so spending it here meant the real check after the await
    // always failed and the button did nothing at all.
    if (!navigation.isFocused()) return;
    // Torrent search is keyed by IMDb id; a library item's `id` is a local key
    // and the provider returns nothing for it. Never fall back to it.
    const id = await ensureImdb();
    if (!id) return;
    setSrcPanel({type: 'movie', imdbId: id, label: item.title});
  };
  const playEpisode = useCallback(
    (ep: Episode) => {
      if (!canNavigate(navigation)) return;
      navigation.push('Player', {
        id: ep.id,
        title: `${item.title} · S${ep.season} E${ep.episode}`,
      });
    },
    [navigation, item.title],
  );
  const openEpisodeSources = useCallback(
    async (s: number, e: number) => {
      // The RESOLVED IMDb id, never the library key, and resolved on press if
      // the lookup hasn't landed yet. No navigation guard: this opens a panel on
      // the page it is already on, so there is no push to race.
      const id = await ensureImdb();
      if (!id) return;
      setSrcPanel({
        type: 'series',
        imdbId: id,
        season: s,
        episode: e,
        label: `S${s} E${e}`,
        sub: item.title,
      });
    },
    [ensureImdb, item.title],
  );

  const backdrop = imgSrc(item.backdrop || item.cover || item.poster);
  // Portrait art beside the title, like the web's `.detail-poster`. Skipped when
  // the backdrop already IS the poster — the same picture twice looks broken.

  // Normalize episodes from either source into one list the JSX renders:
  // library shows play by episode id; stream shows open Sources by (s, e).
  // Memoized so episode rows (React.memo) aren't re-rendered by unrelated
  // state like the My List toggle.
  // Refetched every time the screen regains focus: coming back from the Player
  // is exactly when the numbers changed, and without this the hero still said
  // "Play" (no Resume, no Start over) for the film you just watched half of.
  const isFocused = useIsFocused();
  useEffect(() => {
    if (!isFocused) return;
    let live = true;
    api
      .state(profileId)
      .then(st => live && setProgress(st.progress || {}))
      .catch(() => {}); // best-effort: no progress just means no badges
    return () => {
      live = false;
    };
  }, [profileId, isFocused]);

  const uiSeasons: UiSeason[] = useMemo(() => {
    // Local copies, keyed by season/episode so the merged list can find them.
    const local = new Map<string, Episode>();
    for (const se of full?.seasons || []) {
      for (const ep of se.episodes) local.set(`${se.number}x${ep.episode}`, ep);
    }

    // Decorate one episode with everything the site's row shows.
    const build = (
      seasonNo: number,
      episodeNo: number,
      title: string | undefined,
      overview: string | undefined,
      thumb?: string | null,
    ): UiEp => {
      const ep = local.get(`${seasonNo}x${episodeNo}`);
      const pr = ep ? progress[ep.id] : undefined;
      const pct =
        pr && pr.duration > 0 && !pr.finished
          ? Math.min(100, Math.round((pr.position / pr.duration) * 100))
          : 0;
      return {
        // ALWAYS the season/episode pair, never ep.id: the key must not change
        // when `full` lands. A stream show resolves its library copy a beat
        // after the page opens, and a key that flips from "1x5" to the library
        // id remounts the very cell the viewer is focused on — Android hands
        // that focus nowhere. The library id still drives onPlay via `ep`.
        key: `${seasonNo}x${episodeNo}`,
        num: episodeNo,
        label: title || ep?.title || `Episode ${episodeNo}`,
        // Owned episodes play straight from disk; the rest go to Sources, which
        // is what makes the un-downloaded ones reachable at all.
        onPlay: ep
          ? () => playEpisode(ep)
          : () => openEpisodeSources(seasonNo, episodeNo),
        owned: !!ep,
        durationLabel: fmtDuration(ep?.duration),
        hasSubs: !!ep?.subtitles?.length,
        watched: !!pr?.finished,
        pct,
        overview,
        thumb,
      };
    };

    // Cinemeta's list is the COMPLETE one, so it drives the layout whenever it is
    // available — for a library show as well as a stream one. Using the library's
    // own season list here is what hid every episode that wasn't downloaded yet.
    if (streamMeta?.seasons?.length) {
      return streamMeta.seasons.map(se => ({
        number: se.number,
        episodes: se.episodes.map(ep =>
          build(se.number, ep.episode, ep.title, ep.overview, ep.thumbnail),
        ),
      }));
    }
    // No metadata (offline, or the title didn't resolve): fall back to whatever
    // is on disk rather than showing an empty page.
    if (full?.seasons?.length) {
      return full.seasons.map(se => ({
        number: se.number,
        episodes: se.episodes.map(ep => build(se.number, ep.episode, ep.title, undefined)),
      }));
    }
    return [];
  }, [full, streamMeta, progress, playEpisode, openEpisodeSources]);

  // Fall back to the first season rather than rendering nothing: the selected
  // number is set from whichever list arrived first, and the merged list can
  // legitimately not contain it (a library show whose only downloaded season is
  // numbered differently from Cinemeta's, a specials season, and so on).
  const curSeason = uiSeasons.find(s => s.number === season) || uiSeasons[0];

  // What the show page's primary button does — the site's `nextUp`. In order of
  // preference: the episode you are part-way through, else the first downloaded
  // one you haven't finished. A show page whose only action is "My List" makes
  // you hunt for your own place in it, which is the one thing you came for.
  const nextUp = useMemo(() => {
    let firstUnwatched: {season: number; ep: UiEp} | null = null;
    for (const se of uiSeasons) {
      for (const ep of se.episodes) {
        if (!ep.owned) continue;
        if (ep.pct) return {season: se.number, episode: ep.num, resume: true, play: ep.onPlay};
        if (!ep.watched && !firstUnwatched) firstUnwatched = {season: se.number, ep};
      }
    }
    if (firstUnwatched) {
      return {
        season: firstUnwatched.season,
        episode: firstUnwatched.ep.num,
        resume: false,
        play: firstUnwatched.ep.onPlay,
      };
    }
    return null;
  }, [uiSeasons]);
  // The two facts the site puts in a show's meta line.
  const ownedCount = useMemo(
    () => uiSeasons.reduce((n, se) => n + se.episodes.filter(e => e.owned).length, 0),
    [uiSeasons],
  );
  const anySubs = useMemo(
    () => uiSeasons.some(se => se.episodes.some(e => e.hasSubs)),
    [uiSeasons],
  );
  const renderEpisode = useCallback(
    ({item: ep, index}: {item: UiEp; index: number}) => (
      <EpisodeCard ep={ep} edgeLeft={index === 0} />
    ),
    [],
  );

  // ---------- Shows ----------
  // Hero over full-bleed art, with the season pills and a HORIZONTAL rail of
  // episode cards along the bottom. The old two-pane (a narrow rail of seasons
  // beside a vertical list) fitted three rows on a 540dp screen and made the
  // page feel like a form; a rail is how a TV shows a season, and it leaves the
  // artwork visible behind it.
  // SOURCES, ON THIS PAGE — built once, rendered by BOTH branches below.
  //
  // This is why the panel never appeared: Detail returns separately for shows and
  // for movies, and the overlay had only been added to the movie return. It was
  // tested on a show, so the JSX was never in the tree — while the state WAS set,
  // which is why Back got swallowed by a panel nobody could see. zIndex and
  // elevation were never involved.
  //
  // The guide traps all four directions so the D-pad cannot reach the page
  // underneath while the panel is up.
  // The copy on disk for whatever the panel is showing — the movie itself, or
  // the exact episode the panel was opened for. Computed live from `full`, so a
  // download that finishes while the panel is open (libraryTick refetch) makes
  // the owned row appear in place, exactly like the site's re-render.
  // Memoized: a fresh {id} literal per render would invalidate the panel's
  // renderStream memo and re-render its whole list on every Detail render.
  const panelOwned = useMemo(() => {
    if (!srcPanel) return null;
    if (srcPanel.type === 'movie') return ownedMovieId ? {id: ownedMovieId} : null;
    const se = full?.seasons?.find(s => s.number === srcPanel.season);
    const ep = se?.episodes.find(e => e.episode === srcPanel.episode);
    return ep ? {id: ep.id} : null;
  }, [srcPanel, ownedMovieId, full]);

  const playLibraryFromPanel = useCallback(
    (pid: string) => {
      if (!srcPanel || !canNavigate(navigation)) return;
      setSrcPanel(null);
      navigation.push('Player', {
        id: pid,
        // Same composed title playEpisode uses, so the player's heading splits
        // it back into show + episode line.
        title: srcPanel.season
          ? `${item.title} · S${srcPanel.season} E${srcPanel.episode}`
          : item.title,
      });
    },
    [srcPanel, navigation, item.title],
  );
  const bumpLibraryTick = useCallback(() => setLibraryTick(t => t + 1), []);

  // The "More like this" panel — same overlay shell as Sources, rendered by
  // BOTH branches below (see the sourcesOverlay note for why that matters).
  const likeCols = Math.max(
    3,
    Math.floor((width - spacing.contentLeft - spacing.pageX + spacing.md) / (CARD_W + spacing.md)),
  );
  const openSimilar = useCallback((sim: HeroItem) => {
    if (!canNavigate(navigation)) return;
    setLikePanel(false);
    navigation.push('Detail', {item: sim});
  }, [navigation]);
  const renderSimilar = useCallback(
    ({item: sim, index}: {item: HeroItem; index: number}) => (
      <Card item={sim} index={index} onPress={openSimilar} hasTVPreferredFocus={index === 0} />
    ),
    [openSimilar],
  );
  const moreOverlay = likePanel ? (
    <TVFocusGuideView
      style={styles.likeOverlay}
      autoFocus
      trapFocusUp
      trapFocusDown
      trapFocusLeft
      trapFocusRight>
      <View style={styles.likeHead}>
        <View style={styles.likeHeadText}>
          <Text style={styles.likeTitle}>More like this</Text>
          <Text style={styles.likeSub} numberOfLines={1}>
            {genreSource.length
              ? `${unescapeHtml(item.title)} · ${genreSource.slice(0, 2).join(' · ')}`
              : unescapeHtml(item.title)}
          </Text>
        </View>
        {/* A persistent focusable: without one an empty/loading panel has no
            focus target inside the trap and the remote goes dead (same rule as
            the Sources screen's Back). */}
        <Focusable round onPress={closeLikePanel} style={styles.likeBack}>
          <Text style={styles.likeBackText}>‹ Back</Text>
        </Focusable>
      </View>
      {similar === null ? (
        <View style={styles.likeCenter}>
          <ActivityIndicator color={colors.text} size="large" />
        </View>
      ) : similarErr || similar.length === 0 ? (
        <Text style={styles.likeEmpty}>
          Couldn't find similar titles right now — try again later.
        </Text>
      ) : (
        <FlatList
          data={similar}
          key={`like-${likeCols}`}
          numColumns={likeCols}
          keyExtractor={s => s.imdbId || s.id || s.title}
          columnWrapperStyle={styles.likeRowGap}
          contentContainerStyle={styles.likeGrid}
          initialNumToRender={12}
          windowSize={3}
          renderItem={renderSimilar}
        />
      )}
    </TVFocusGuideView>
  ) : null;

  const sourcesOverlay = srcPanel ? (
    <TVFocusGuideView
      style={styles.srcOverlay}
      autoFocus
      trapFocusUp
      trapFocusDown
      trapFocusLeft
      trapFocusRight>
        <View style={styles.srcLeft}>
          <Image
            source={imgSrc(item.cover || item.poster) || undefined}
            style={styles.srcPoster}
            resizeMode="cover"
            fadeDuration={160}
          />
          <Text style={styles.srcLabel} numberOfLines={2}>
            {srcPanel.label}
          </Text>
          {srcPanel.sub ? (
            <Text style={styles.srcSub} numberOfLines={2}>
              {srcPanel.sub}
            </Text>
          ) : null}
        </View>
        <View style={styles.srcRight}>
          <SourcesPanel
            embedded
            type={srcPanel.type}
            imdbId={srcPanel.imdbId}
            title={item.title}
            year={item.year}
            season={srcPanel.season}
            episode={srcPanel.episode}
            runtime={streamMeta?.runtime ?? null}
            poster={item.cover ?? item.poster ?? null}
            owned={panelOwned}
            onPlayLibrary={playLibraryFromPanel}
            onOwnershipChange={bumpLibraryTick}
            onBack={() => setSrcPanel(null)}
            onPlay={playItem => {
              if (!canNavigate(navigation)) return;
              setSrcPanel(null);
              navigation.push('Player', {
                id: playItem.id,
                title: item.title,
                stream: playItem,
              });
            }}
          />
        </View>
    </TVFocusGuideView>
  ) : null;

  if (item.type === 'show') {
    return (
      <View style={styles.root}>
        <HeroArt art={backdrop} sharp={!!item.backdrop} />
        {/* The panels trap focus, so the rail is unreachable while one is up —
            §5.8(a). */}
        <NavRail active={navSection} disabled={!!srcPanel || likePanel} />
        <DetailHero
          kicker="SERIES"
          title={item.title}
          rating={item.rating}
          metaParts={[
            item.year && String(item.year),
            uiSeasons.length ? `${uiSeasons.length} season${uiSeasons.length === 1 ? '' : 's'}` : null,
            ownedCount ? `${ownedCount} downloaded` : null,
          ]}
          badges={[streamMeta?.certificate, anySubs ? 'CC' : null]}
          dense
          synopsis={full?.synopsis || streamMeta?.synopsis || item.synopsis}
          synopsisLines={1}
          note={srcNote}
          bottomInset={RAIL_H + (uiSeasons.length > 1 ? SEASON_H : 0)}>
          {nextUp ? (
            <PrimaryBtn
              hasTVPreferredFocus
              edgeLeft
              label={
                nextUp.resume
                  ? `▶  Continue S${nextUp.season} E${nextUp.episode}`
                  : `▶  Play S${nextUp.season} E${nextUp.episode}`
              }
              onPress={nextUp.play}
            />
          ) : null}
          <GhostBtn
            ref={listBtnRef}
            hasTVPreferredFocus={!nextUp}
            edgeLeft={!nextUp}
            label={inList ? '✓  In My List' : '+  My List'}
            onPress={toggleList}
          />
          <GhostBtn label="More like this" onPress={() => setLikePanel(true)} />
        </DetailHero>

        {/* Season pills + the episode rail, pinned to the bottom of the screen
            so the hero above them never has to guess how much room is left. */}
        <View style={[styles.bottomDock, {paddingBottom: safeBottom}]}>
          {uiSeasons.length > 1 ? (
            <FlatList
              data={uiSeasons}
              horizontal
              keyExtractor={se => `s${se.number}`}
              showsHorizontalScrollIndicator={false}
              style={styles.seasonRow}
              contentContainerStyle={styles.seasonRowContent}
              renderItem={({item: se, index}) => (
                <Focusable
                  round
                  light={se.number === season}
                  edgeLeft={index === 0}
                  onPress={() => setSeason(se.number)}
                  style={[styles.pill, se.number === season && styles.pillOn]}>
                  <Text style={[styles.pillText, se.number === season && styles.pillTextOn]}>
                    {`Season ${se.number}`}
                  </Text>
                </Focusable>
              )}
            />
          ) : null}
          {loading && !curSeason ? (
            <ActivityIndicator color={colors.text} style={styles.railSpinner} />
          ) : (
            <FlatList
              key={`season-${season}`}
              data={curSeason?.episodes || []}
              horizontal
              keyExtractor={ep => ep.key}
              showsHorizontalScrollIndicator={false}
              style={styles.rail}
              contentContainerStyle={styles.railContent}
              initialNumToRender={6}
              windowSize={5}
              renderItem={renderEpisode}
            />
          )}
        </View>
        {sourcesOverlay}
        {moreOverlay}
      </View>
    );
  }

  // ---------- Movies (library + stream) ----------
  // One screen, no scrolling: art, lockup, buttons. A film has nothing below the
  // fold worth a second screenful, and the empty half the scroll page left under
  // the buttons was the emptiest thing in the app.
  return (
    <View style={styles.root}>
      <HeroArt art={backdrop} sharp={!!item.backdrop} />
      {/* Both returns need this. A change made to one is invisible on the
          other — that has cost a full debugging cycle before. */}
      <NavRail active={navSection} disabled={!!srcPanel || likePanel} />
      <DetailHero
        kicker="FILM"
        title={item.title}
        rating={item.rating}
        metaParts={[
          item.year && String(item.year),
          fmtDuration(full?.duration) || (streamMeta?.runtime ? String(streamMeta.runtime) : null),
          fmtBytes(full?.sizeBytes),
        ]}
        badges={[
          full?.certificate || streamMeta?.certificate,
          resBadge(full?.height),
          full?.subtitles?.length ? 'CC' : null,
        ]}
        genres={genreSource}
        // The CARD's payload is the poorest of the three and was the only one
        // being read. `full` is /api/item (the library record) and `streamMeta`
        // is Cinemeta; whichever arrives is richer than the card, and the card
        // stays as the fallback so this can only ever add text, never remove it.
        synopsis={full?.synopsis || streamMeta?.synopsis || item.synopsis}
        synopsisLines={3}
        cast={streamMeta?.cast}
        note={srcNote}
        bottomInset={safeBottom}>
        {/* Keyed on OWNERSHIP, not on which shelf the card came from: a title
            the library holds plays the copy — starts instantly, seeks anywhere —
            and streaming becomes "Other versions". This is the site's own hero
            logic, and its absence is why the TV preferred streaming titles it
            already had on disk. */}
        {ownedMovieId ? (
          <PrimaryBtn
            hasTVPreferredFocus
            edgeLeft
            label={movieResume ? `▶  Resume ${fmtClock(movieResume)}` : '▶  Play'}
            onPress={playMovie}
          />
        ) : (
          <PrimaryBtn hasTVPreferredFocus edgeLeft label="▶  Stream now" onPress={openSources} />
        )}
        {ownedMovieId && movieResume ? (
          <GhostBtn label="↺  Start over" onPress={playFromStart} />
        ) : null}
        {ownedMovieId ? <GhostBtn label="Other versions" onPress={openSources} /> : null}
        <GhostBtn
          ref={listBtnRef}
          label={inList ? '✓  In My List' : '+  My List'}
          onPress={toggleList}
        />
        <GhostBtn label="More like this" onPress={() => setLikePanel(true)} />
        {ownedMovieId ? (
          <GhostBtn label={movieWatched ? '✓  Watched' : 'Mark watched'} onPress={toggleWatched} />
        ) : null}
      </DetailHero>
      {loading ? <ActivityIndicator color={colors.text} style={styles.loading} /> : null}
      {sourcesOverlay}
      {moreOverlay}
    </View>
  );
}

const styles = StyleSheet.create({
  // No backgroundColor: android:windowBackground is already this colour, and
  // painting it again cost a second full-screen fill on every frame.
  root: {flex: 1},
  // ---- inline sources ------------------------------------------------------
  srcOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // zIndex AND elevation, both required on Android. Painting order alone was
    // not enough: this is the last child of the root, but the hero's buttons
    // carry boxShadows, and a view with elevation out-ranks a later sibling that
    // has none — so the panel mounted and handled Back (proved on the device:
    // the first Back was swallowed, the second left the page) while never
    // becoming visible.
    zIndex: 10,
    elevation: 10,
    flexDirection: 'row',
    // Dark enough to read a list on, translucent enough that the title's own
    // artwork still shows through and the panel reads as part of this page.
    backgroundColor: 'rgba(8,9,16,0.985)',
    paddingTop: 56,
    paddingLeft: spacing.contentLeft,
    paddingRight: spacing.pageX,
    paddingBottom: spacing.lg,
    gap: spacing.xl,
  },
  // ---- more like this -------------------------------------------------------
  // Same shell as the sources overlay: dark wash over the page, zIndex AND
  // elevation (see srcOverlay for why both), content inside the safe frame.
  likeOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    elevation: 10,
    backgroundColor: 'rgba(8,9,16,0.985)',
    paddingTop: 40,
    paddingLeft: spacing.contentLeft,
    paddingRight: spacing.pageX,
  },
  likeHead: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm},
  likeHeadText: {flex: 1, minWidth: 0},
  likeTitle: {color: colors.text, fontSize: fontSize.title, fontWeight: '900'},
  likeSub: {color: colors.textDim, fontSize: fontSize.small, fontWeight: '600', marginTop: 2},
  likeBack: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 8,
    paddingHorizontal: 18,
    flexShrink: 0,
  },
  likeBackText: {color: colors.text, fontSize: fontSize.small, fontWeight: '700'},
  likeCenter: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  likeEmpty: {color: colors.textDim, fontSize: fontSize.body, marginTop: spacing.xl},
  // The grid clearance rules are Browse's: padding, no cancelling margins on
  // recycled cells.
  likeGrid: {paddingTop: theme.CLEARANCE.above, paddingBottom: theme.CLEARANCE.below},
  likeRowGap: {gap: spacing.md, marginBottom: spacing.md},

  srcLeft: {width: 190},
  srcPoster: {width: 190, height: 285, borderRadius: radius.m, backgroundColor: colors.bgRaised},
  srcLabel: {color: colors.text, fontSize: fontSize.title, fontWeight: '900', marginTop: spacing.md},
  srcSub: {color: colors.textDim, fontSize: fontSize.small, fontWeight: '700', marginTop: 4},
  srcRight: {flex: 1},

  // ---- the artwork stack --------------------------------------------------
  art: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  artFallback: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bgRaised},
  // Light. The site multiplies its backdrop down to 0.42 brightness because a
  // web page has to carry body text over it; here the ramps do that job on the
  // side the text is actually on, so the picture keeps its own life.
  artDim: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(6,7,14,0.34)'},
  // 78% wide: the ramp is transparent by its own right edge, so the artwork's
  // right side is untouched.
  artSide: {position: 'absolute', top: 0, left: 0, bottom: 0, width: '78%', height: '100%'},
  artVeil: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%'},

  // ---- the lockup ---------------------------------------------------------
  // Bottom-anchored: the title sits low over the art, which is the Apple TV
  // composition and leaves the top two thirds of the frame to the picture.
  hero: {flex: 1, justifyContent: 'flex-end', paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX, paddingTop: 72},
  // 64%: four actions on a film need the width, and the ramp is still
  // transparent well before the artwork's subject on the right.
  lockup: {maxWidth: '64%'},
  kicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 3},
  title: {
    color: colors.text,
    fontSize: fontSize.hero,
    fontWeight: '900',
    letterSpacing: -1.2,
    marginTop: spacing.xs,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: {width: 0, height: 3},
    textShadowRadius: 24,
  },
  titleDense: {fontSize: fontSize.title + 6, letterSpacing: -0.8},
  metaRow: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.sm},
  rating: {color: colors.star, fontSize: fontSize.body, fontWeight: '800'},
  meta: {color: colors.textDim, fontSize: fontSize.body, fontWeight: '600'},
  // Genres as a plain line, not chips. Five pills under a 52dp title is a second
  // row of furniture competing with the buttons for the eye.
  genreLine: {color: colors.textFaint, fontSize: fontSize.small, fontWeight: '700', marginTop: 6},
  synopsis: {color: colors.textDim, fontSize: fontSize.body, lineHeight: 26, marginTop: spacing.sm},
  cast: {color: colors.textDim, fontSize: fontSize.small, marginTop: 6},
  castLabel: {color: colors.textFaint, fontWeight: '800'},
  badge: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {color: colors.text, fontSize: 12, fontWeight: '900', letterSpacing: 1},
  actions: {flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, flexWrap: 'wrap'},
  actionsDense: {marginTop: spacing.md},
  playBtn: {backgroundColor: colors.white, paddingVertical: 13, paddingHorizontal: 28},
  playText: {color: colors.bg, fontSize: fontSize.body, fontWeight: '800'},
  // Translucent rather than the flat surface colour: these sit on artwork now,
  // and a solid slab there reads as a hole punched in the picture.
  ghost: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 13,
    paddingHorizontal: 18,
    alignSelf: 'flex-start',
  },
  ghostText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  note: {color: colors.accent, fontSize: fontSize.small, fontWeight: '700', marginTop: spacing.sm},
  loading: {position: 'absolute', bottom: spacing.xl, left: spacing.contentLeft},

  // ---- the season dock ----------------------------------------------------
  bottomDock: {position: 'absolute', left: 0, right: 0, bottom: 0},
  seasonRow: {flexGrow: 0, height: SEASON_H},
  seasonRowContent: {
    paddingLeft: spacing.contentLeft,
    paddingRight: spacing.pageX,
    gap: spacing.sm,
    alignItems: 'center',
  },
  pill: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingVertical: 8,
    paddingHorizontal: 18,
    alignSelf: 'center',
  },
  pillOn: {backgroundColor: colors.white},
  pillText: {color: colors.text, fontSize: fontSize.small, fontWeight: '700'},
  pillTextOn: {color: colors.bg},
  rail: {flexGrow: 0},
  // The vertical padding is the focus glow's room; without it the rail's own
  // bounds slice the light off the top and bottom of a focused card.
  // Only the ABOVE clearance both sides for now: this rail is pinned to the
  // bottom of the screen, so spending the full 61dp below would push it off.
  // 05-detail-show owns the dock's geometry and closes this.
  railContent: {
    paddingLeft: spacing.contentLeft,
    paddingRight: spacing.pageX,
    paddingVertical: theme.CLEARANCE.above,
    gap: spacing.md,
  },
  railSpinner: {alignSelf: 'flex-start', marginLeft: spacing.contentLeft, marginBottom: spacing.xl},

  // ---- episode card -------------------------------------------------------
  // The Focusable itself now. Padding-bottom keeps the ring off the badges, and
  // the radius is what the ring follows.
  epCard: {width: EP_W, borderRadius: radius.m, paddingBottom: 8},
  // '100%' on BOTH axes, so the still is exactly the content box and the ring
  // hugs it. The width was already '100%'; only the height was absolute, which
  // is the whole of the bug.
  epThumb: {
    width: '100%',
    // Explicit again: the still no longer sits inside a Focusable that was
    // sizing it, so it states its own 16:9 box off the ART width (EP_W minus the
    // ring's reserved 3dp each side).
    height: EP_ART_H,
    borderRadius: radius.m,
    backgroundColor: colors.bgRaised,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  epThumbImg: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  epNumOnArt: {
    position: 'absolute',
    left: 10,
    top: 6,
    color: colors.white,
    fontSize: fontSize.row,
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 8,
  },
  // A green tick, not the old "✓ DOWNLOADED" slab: on a 230dp card the word was
  // most of the picture.
  epOwnedTag: {
    position: 'absolute',
    right: 8,
    top: 6,
    color: colors.bg,
    backgroundColor: '#4ade80',
    fontSize: 11,
    fontWeight: '900',
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  epBar: {position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, backgroundColor: 'rgba(255,255,255,0.18)'},
  epBarFill: {height: '100%', backgroundColor: colors.progress},
  // 4dp horizontal inset: the caption sits inside the Focusable, and without it
  // the focus ring's stroke was drawn over the first letter (seen on-device:
  // "Thanksgiving" lost the top of its T).
  epTitle: {
    color: colors.text,
    fontSize: fontSize.small,
    fontWeight: '700',
    marginTop: 8,
    paddingHorizontal: 4,
  },
  epSub: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 3,
    paddingHorizontal: 4,
  },
  epDur: {color: colors.textFaint, fontSize: 13, fontWeight: '700'},
  epBadge: {
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 4,
    paddingHorizontal: 5,
  },
});
