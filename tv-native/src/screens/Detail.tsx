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
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  BackHandler,
  TVFocusGuideView,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useIsFocused} from '@react-navigation/native';
import Focusable from '../components/Focusable';
import Icon, {IconName} from '../components/Icon';
const DETAIL_MASK = require('../assets/detail-mask.png');
// An episode we hold: green rising from the card's foot and fading toward the
// top (elia, 2026-10-07) — baked, the one kind of gradient the Mi TV draws.
const OWNED_GLOW = require('../assets/owned-glow.png');
// The episode to watch next (the site's .up-next): the same rise, in the accent.
const UPNEXT_GLOW = require('../assets/upnext-glow.png');
// Up next AND on disk: green at the foot rising into the accent (elia).
const OWNED_UPNEXT_GLOW = require('../assets/owned-upnext-glow.png');
import Card, {CARD_W, CARD_H} from '../components/Card';
import NavRail from '../components/NavRail';
import {api, imgSrc, ImgSource, Item, Episode, HeroItem, Progress, StreamRef, DiscoverMeta} from '../api';
import {canNavigate} from '../navLock';
import {openTrailer, openActions, openXray} from '../overlay';
import {showToast} from '../toast';
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
// GLASS (elia, 2026-10-07, "the same glass look like the website"): the card
// is a translucent box with the site's 1px edge (glass.css `.episode`), the
// still inset inside it like the site's 176px still inside its 10px padding.
// The 1dp edge + 5dp of glass replace the ring's reserved 3dp: the ring (3dp)
// is drawn at inset 0 over the edge and the first 2dp of glass.
const EP_EDGE = 1;
const EP_PAD = 5;
const EP_ART_W = EP_W - (EP_EDGE + EP_PAD) * 2;
const EP_ART_H = Math.round((EP_ART_W * 9) / 16);
// What the Focusable is given, so its CONTENT box is exactly the still.
const EP_THUMB_H = EP_ART_H + (EP_EDGE + EP_PAD) * 2;
const SEASON_H = 54;
// The glass body under the still: kicker 14 + title 18 + two synopsis lines 32 +
// their gaps 5 + the foot line 18 + its gap 6 + top padding 8 = 101, rounded.
const EP_BODY_H = 102;
// The film page's shelf: a poster row with its heading, the focus glow's room
// above, and the safe inset added at render.
// heading (26) + the rail's own padding (20 above for the focus glow, 8
// below) + a poster; the safe inset is added at render on both sides.
const LIKE_H = 26 + 20 + CARD_H + 8;
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
// By width OR height (the site's resTier): a 2.40:1 film is 1920x800, and by
// height alone it read as 720p — which is why nearly every film said 720p.
const resBadge = (height?: number, width?: number) => {
  if (!height) return null;
  const w = width || 0;
  if (w >= 3200 || height >= 2000) return '4K';
  if (w >= 1600 || height >= 1000) return 'HD';
  if (w >= 1100 || height >= 700) return '720p';
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
  poster,
  secondary,
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
  // The site's `.detail-poster`: portrait art at the lockup's left (films; a
  // show page's dock has no room for it). Skipped when the backdrop IS the
  // poster — the same picture twice reads as broken.
  poster?: ImgSource | null;
  // A second, smaller row of actions under the main one (the site's icon row).
  secondary?: React.ReactNode;
  children?: React.ReactNode; // the actions row
}) {
  const meta = metaParts.filter(Boolean).map(String);
  const badgeList = badges.filter(Boolean) as string[];
  return (
    <View style={[styles.hero, {paddingBottom: bottomInset + spacing.md}]} pointerEvents="box-none">
      <View style={styles.lockupRow} pointerEvents="box-none">
      {poster ? (
        <Image source={poster} style={styles.poster} resizeMode="cover" resizeMethod="resize" fadeDuration={200} />
      ) : null}
      <View style={[styles.lockup, poster && styles.lockupBeside]} pointerEvents="box-none">
        {/* ORDER (Max): kicker · title · facts · the buttons · the synopsis ·
            genres · cast. The buttons sit right under the facts, so the first
            press is one glance from the title; the paragraph reads after. */}
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
        {children ? (
          <View style={[styles.actions, dense && styles.actionsDense]}>{children}</View>
        ) : null}
        {secondary ? <View style={styles.actionsSecondary}>{secondary}</View> : null}
        {synopsis ? (
          <Text style={styles.synopsis} numberOfLines={synopsisLines}>
            {unescapeHtml(synopsis)}
          </Text>
        ) : null}
        {genres && genres.length ? (
          <Text style={styles.genreLine} numberOfLines={1}>
            {genres.slice(0, 4).join('  ·  ')}
          </Text>
        ) : null}
        {cast && cast.length ? (
          <Text style={styles.cast} numberOfLines={1}>
            <Text style={styles.castLabel}>Cast </Text>
            {unescapeHtml(cast.slice(0, 4).join(', '))}
          </Text>
        ) : null}
        {note ? <Text style={styles.note}>{note}</Text> : null}
      </View>
      </View>
    </View>
  );
}

// The backdrop stack every detail page sits on: art, a light overall dim, the
// left ramp that carries the type, and the bottom ramp that lands the page.
function HeroArt({art, sharp}: {art?: ImgSource | null; sharp: boolean}) {
  if (!art) return null;
  // SEPARATION (elia): the picture lives in the upper right — from 30% of the
  // width to the edge, 76% of the height — and the text column on the left
  // sits on the plain page, never under it.
  return (
    <>
    <View style={styles.artBox} pointerEvents="none">
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
    </View>
    {/* The ramps are SIBLINGS of the box, positioned over it in screen terms:
        overlays drawn inside the box did not render on the Mi TV (neither the
        veil that works full-screen, nor PNG tiles, nor an SVG gradient), while
        full-screen overlays always have. Left ramp over the box's first 55%,
        foot ramp over its lower 45%. */}
    <Image source={DETAIL_MASK} style={styles.artMask} resizeMode="stretch" fadeDuration={0} />
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
// A round 40dp icon with a tiny label under it — Max's My List / Trailer row.
const IconBtn = ({
  icon,
  glyph,
  label,
  on,
  onPress,
  ref,
}: {
  icon?: IconName;
  glyph?: string;
  label: string;
  on?: boolean; // a filled disc: in the list, marked watched
  onPress: () => void;
  ref?: React.Ref<View>;
}) => (
  <Focusable round ref={ref} onPress={onPress} style={styles.iconBtn} accessibilityLabel={label}>
    <View style={[styles.iconBtnDisc, on && styles.iconBtnDiscOn]}>
      {icon ? (
        <Icon name={icon} size={18} color={on ? colors.bg : colors.text} />
      ) : (
        <Text style={[styles.iconBtnGlyph, on && {color: colors.bg}]}>{glyph}</Text>
      )}
    </View>
    <Text style={styles.iconBtnLabel} numberOfLines={1}>
      {label}
    </Text>
  </Focusable>
);

const GhostBtn = ({
  label,
  hasTVPreferredFocus,
  edgeLeft,
  small,
  onPress,
  ref,
}: {
  label: string;
  hasTVPreferredFocus?: boolean;
  edgeLeft?: boolean;
  small?: boolean;
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
    style={[styles.ghost, small && styles.ghostSmall]}>
    <Text style={[styles.ghostText, small && styles.ghostTextSmall]}>{label}</Text>
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
  // Whole minutes for the kicker's "· 53 MIN": the file's own length when the
  // episode is on disk, else the show's typical runtime from the catalogue —
  // Cinemeta carries no per-episode runtime, and a card with no runtime at
  // all read as missing data (elia, 2026-10-07: "why still there is no runtime
  // for episode 3 and 4?").
  durationMin?: number;
  hasSubs?: boolean;
  watched?: boolean;
  pct?: number; // part-watched progress, 0..100
  overview?: string;
  thumb?: string | null;
  // The air date as the site shows it ("29 Sep", "12 Mar 2024"), and which of
  // the site's three states the episode is in (ui.js resolveAirStates).
  airLabel?: string;
  air: 'aired' | 'upcoming' | 'tba';
  // for the card's long-press menu and the season pill
  season: number;
  episode: number;
  epId?: string; // the library file, when there is one
  durationSec?: number;
  // a download in flight for this episode (the site's card carries the same)
  dl?: {status: string; progress: number};
  // the first aired episode not yet watched, once anything in the season is
  upNext?: boolean;
};
const dlText = (dl: {status: string; progress: number}) => {
  if (dl.status === 'pending') return 'REQUESTED';
  const pct = Math.round((dl.progress || 0) * 100);
  if (dl.status !== 'downloading' || !(pct > 0)) return 'STARTING';
  return `SAVING ${pct}%`;
};
type UiSeason = {number: number; episodes: UiEp[]};

// ui.js fmtAirDate, ported — by hand rather than toLocaleDateString, so it does
// not depend on the TV's Intl data. Same-year dates drop the year.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const airTime = (released?: string | null) => (released ? Date.parse(released) : NaN);
const fmtAirDate = (released?: string | null) => {
  const t = airTime(released);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
};
// "49 min" / "1h 2min" / 49 → whole minutes, or undefined when the catalogue
// has no runtime for the show.
const parseRuntimeMin = (rt?: string | number | null): number | undefined => {
  if (typeof rt === 'number') return rt > 0 ? Math.round(rt) : undefined;
  if (!rt) return undefined;
  const h = /(\d+)\s*h/i.exec(rt);
  const m = /(\d+)\s*m/i.exec(rt);
  const mins = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  if (mins > 0) return mins;
  const n = parseInt(rt, 10);
  return n > 0 ? n : undefined;
};
// ui.js resolveAirStates, ported. Cinemeta lists episodes as soon as they are
// ANNOUNCED: a dated future episode is "upcoming", and a date-less one past the
// last dated episode of its season is "tba". A date-less episode in a season
// with no dates at all is simply aired — old shows carry no dates anywhere.
const resolveAirStates = (eps: {episode: number; released?: string | null; local?: boolean}[]) => {
  const now = Date.now();
  let lastDated: number | null = null;
  for (const ep of eps) {
    if (Number.isFinite(airTime(ep.released))) lastDated = Math.max(lastDated ?? -Infinity, ep.episode || 0);
  }
  return eps.map((ep): UiEp['air'] => {
    if (ep.local) return 'aired';
    const t = airTime(ep.released);
    if (Number.isFinite(t)) return t > now ? 'upcoming' : 'aired';
    if (lastDated === null) return 'aired';
    return (ep.episode || 0) > lastDated ? 'tba' : 'aired';
  });
};

// One episode as a CARD in the season rail: a 16:9 still, the number and name
// under it, then the facts. This is how a TV shows a season — the old full-width
// rows were a settings list with pictures missing, and only three of them fitted
// on screen.
const EpisodeCard = React.memo(function EpisodeCardItem({
  ep,
  edgeLeft,
  onFocus,
  onMore,
}: {
  ep: UiEp;
  edgeLeft?: boolean;
  onFocus?: () => void;
  onMore?: () => void; // hold OK: Mark watched / Sources / Play
}) {
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
      onLongPress={onMore}
      onFocusChange={onFocus ? f => f && onFocus() : undefined}
      // glass.css: `.episode:focus { background: rgba(255,255,255,.09) }` —
      // a lighter glass while focused, on top of the resting 0.06.
      highlightColor="rgba(255,255,255,0.04)"
      // an episode we hold: green glass rising from the foot, not a tick on the picture
      style={[styles.epCard, ep.owned && styles.epCardOwned, ep.upNext && styles.epCardUpNext]}>
        {ep.upNext && ep.owned ? (
          <Image source={OWNED_UPNEXT_GLOW} style={styles.epOwnedGlow} resizeMode="stretch" fadeDuration={0} />
        ) : ep.upNext ? (
          <Image source={UPNEXT_GLOW} style={styles.epOwnedGlow} resizeMode="stretch" fadeDuration={0} />
        ) : ep.owned ? (
          <Image source={OWNED_GLOW} style={styles.epOwnedGlow} resizeMode="stretch" fadeDuration={0} />
        ) : null}
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
          {/* No number on the still (elia, 2026-10-07): the kicker under it says
              "EPISODE N", and the picture is the picture. */}
        </View>
        {/* glass.css .episode-bar: a 3px track on the seam between the still
            and the glass, the violet fill with its glow, and a 7px white bead
            at the head — the site's timeline, not a slab inside the picture. */}
        {ep.dl ? (
          <View style={styles.epBar} pointerEvents="none">
            <View style={[styles.epBarFill, styles.epBarFillDl, {width: `${Math.max(2, Math.round((ep.dl.progress || 0) * 100))}%`}]}>
              <View style={styles.epBarHead} />
            </View>
          </View>
        ) : ep.pct ? (
          <View style={styles.epBar} pointerEvents="none">
            <View style={[styles.epBarFill, {width: `${ep.pct}%`}]}>
              <View style={styles.epBarHead} />
            </View>
          </View>
        ) : null}
      {/* The body is the site's (discover-detail.js, glass look): the kicker
          "EPISODE 2 · 53 MIN", the name, the synopsis, and a foot line that
          leads with the air date — for an episode you don't own it is the one
          fact there is, which is why cards 3 and 4 used to have nothing under
          them. A fixed height keeps the row even when a synopsis is missing. */}
      <View style={[styles.epBody, ep.air !== 'aired' && styles.epBodyUnaired]}>
        <View>
          <View style={styles.epKickerRow}>
            <Text style={[styles.epKicker, ep.dl && styles.epKickerDl]} numberOfLines={1}>
              {ep.dl ? `EPISODE ${ep.num}  ·  ${dlText(ep.dl)}` : `EPISODE ${ep.num}${ep.durationMin ? `  ·  ${ep.durationMin} MIN` : ''}`}
            </Text>
            {/* a saving episode wears a small download glyph after its text (elia, 2026-10-07) */}
            {ep.dl ? <Icon name="download" size={11} color="#8cffbe" /> : null}
          </View>
          <Text style={styles.epTitle} numberOfLines={1}>
            {unescapeHtml(ep.label)}
          </Text>
          {ep.overview ? (
            <Text style={styles.epOverview} numberOfLines={2}>
              {unescapeHtml(ep.overview)}
            </Text>
          ) : null}
        </View>
        <View style={styles.epFoot}>
          {ep.air === 'tba' ? (
            <Text style={[styles.epAir, styles.epAirDim]}>Date TBA</Text>
          ) : ep.airLabel ? (
            <>
              <Icon name="play" size={11} color={ep.air === 'upcoming' ? colors.textFaint : colors.textDim} />
              <Text style={[styles.epAir, ep.air === 'upcoming' && styles.epAirDim]}>{ep.airLabel}</Text>
            </>
          ) : null}
          {ep.hasSubs ? <Text style={styles.epBadge}>CC</Text> : null}
          <View style={styles.epFootSpacer} />
          {ep.watched ? <Icon name="check" size={14} color={colors.textDim} /> : null}
        </View>
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
  const {width, safeBottom, height} = useTvMetrics();
  const stream = isStream(item);

  const [full, setFull] = useState<Item | null>(null);
  // Watch progress for this profile, so an episode row can say "Watched" and
  // carry a part-watched bar the way the site's does.
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [fullTick, setFullTick] = useState(0);
  const pollArmed = useRef(false);
  // Streamed episodes' progress, keyed "imdb:season:episode" (the site's
  // episodeProgressFor) — a TV never showed one as watched before.
  const [epProgress, setEpProgress] = useState<Record<string, Progress>>({});
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
      .item(item.id, profileId, libraryTick > 0)
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
  // Downloads in flight for this show's episodes, by "SxE" (the site's card
  // carries the same). The TV has no socket: polled every few seconds while
  // one is running, once after a request, and when the page comes back.
  const [epJobs, setEpJobs] = useState<Record<string, {status: string; progress: number}>>({});
  const loadEpJobs = useCallback(async () => {
    const imdb = item.imdbId || libImdb;
    if (!imdb) return false;
    try {
      const jobs = await api.downloads();
      const next: Record<string, {status: string; progress: number}> = {};
      let live = false;
      for (const j of jobs) {
        if (j.imdbId !== imdb || !j.season || !j.episode) continue;
        if (!['pending', 'approved', 'downloading'].includes(j.status)) continue;
        const k = `${j.season}x${j.episode}`;
        if (!next[k]) next[k] = {status: j.status, progress: j.progress || 0};
        live = true;
      }
      setEpJobs(next);
      return live;
    } catch {
      return false;
    }
  }, [item.imdbId, libImdb]);
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
    // Films load their shelf as the page opens; a show's list waits for the
    // "More like this" button (its dock is the episode rail).
    if ((item.type === 'show' && !likePanel) || similar !== null) return;
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
    (ep: Episode, epTitle?: string) => {
      if (!canNavigate(navigation)) return;
      navigation.push('Player', {
        id: ep.id,
        title: `${item.title} · S${ep.season} E${ep.episode}`,
        epTitle,
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

  // THE PICTURE: the title's key art (metahub's background, by IMDb id) before
  // a frame still — a library show's still is a random scene, often letterboxed.
  const keyImdb = item.imdbId || libImdb;
  const keyArt = keyImdb ? `https://images.metahub.space/background/medium/${keyImdb}/img` : null;
  const backdrop = imgSrc(keyArt || item.backdrop || item.cover || item.poster);
  const backdropSharp = !!(keyArt || item.backdrop);
  // The lockup begins at 42% of the screen — low, on the part of the picture
  // the ramps have already taken down (Max puts its title there too); the
  // words and buttons never sit on the subject.
  const artTop = Math.round(height * 0.22);
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
      .then(st => {
        if (!live) return;
        setProgress(st.progress || {});
        setEpProgress(st.episodeProgress || {});
      })
      .catch(() => {}); // best-effort: no progress just means no badges
    // the download poll: every 4 s while something runs, then it stops by itself
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const running = await loadEpJobs();
      if (!live) return;
      if (running) timer = setTimeout(tick, 4000);
      else {
        // a finished download is a new library file: the page re-reads it
        setFullTick(t => t + 1);
      }
    };
    pollArmed.current = true;
    tick();
    return () => {
      live = false;
      pollArmed.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [isFocused, profileId, loadEpJobs, fullTick]);

  const uiSeasons: UiSeason[] = useMemo(() => {
    // Local copies, keyed by season/episode so the merged list can find them.
    const showRuntimeMin = parseRuntimeMin(streamMeta?.runtime);
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
      released?: string | null,
      air: UiEp['air'] = 'aired',
    ): UiEp => {
      const ep = local.get(`${seasonNo}x${episodeNo}`);
      // Owned: the file's own progress. Streamed: the site's two keys for an
      // episode watched without a file (episodeProgressFor + the stream|… key).
      const imdbForKeys = item.imdbId || libImdb;
      const pr = ep
        ? progress[ep.id]
        : (imdbForKeys && (epProgress[`${imdbForKeys}:${seasonNo}:${episodeNo}`] || progress[`stream|${imdbForKeys}|${seasonNo}|${episodeNo}`])) ||
          undefined;
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
        // Owned: play. Not owned: a press SAVES the best source, the card
        // carries the download, and a hold brings the source list (elia,
        // 2026-10-07: the site's flow — "press on it downloads the best source
        // and only a long press opens the source list").
        onPlay: ep
          ? () => playEpisode(ep, title || (ep.title && !/^Episode \d+$/.test(ep.title) ? ep.title : undefined))
          : () => downloadBestRef.current(seasonNo, episodeNo, air),
        owned: !!ep,
        durationLabel: fmtDuration(ep?.duration),
        durationMin: ep?.duration ? Math.round(ep.duration / 60) : showRuntimeMin,
        hasSubs: !!ep?.subtitles?.length,
        watched: !!pr?.finished,
        pct,
        overview,
        thumb,
        airLabel: fmtAirDate(released),
        air,
        season: seasonNo,
        episode: episodeNo,
        epId: ep?.id,
        durationSec: ep?.duration,
        dl: ep ? undefined : epJobs[`${seasonNo}x${episodeNo}`],
      };
    };

    // Cinemeta's list is the COMPLETE one, so it drives the layout whenever it is
    // available — for a library show as well as a stream one. Using the library's
    // own season list here is what hid every episode that wasn't downloaded yet.
    if (streamMeta?.seasons?.length) {
      return streamMeta.seasons.map(se => {
        const airs = resolveAirStates(
          se.episodes.map(ep => ({episode: ep.episode, released: ep.released, local: local.has(`${se.number}x${ep.episode}`)})),
        );
        const eps = se.episodes.map((ep, i) =>
          build(se.number, ep.episode, ep.title, ep.overview, ep.thumbnail, ep.released, airs[i]),
        );
        // the site's up-next: the first aired episode not finished, once any is
        if (eps.some(e => e.watched)) {
          const next = eps.find(e => e.air === 'aired' && !e.watched);
          if (next) next.upNext = true;
        }
        return {number: se.number, episodes: eps};
      });
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
  }, [full, streamMeta, progress, epProgress, epJobs, playEpisode, item.imdbId, libImdb]);

  // Fall back to the first season rather than rendering nothing: the selected
  // number is set from whichever list arrived first, and the merged list can
  // legitimately not contain it (a library show whose only downloaded season is
  // numbered differently from Cinemeta's, a specials season, and so on).
  const curSeason = uiSeasons.find(s => s.number === season) || uiSeasons[0];

  // ---- marking watched (elia, 2026-10-07: "tv should also have the control
  // like the web for things like mark season watched"). The same two writes
  // the site makes: the file's own id when we hold the episode, else the
  // stream key with the episode's identity so Continue Watching and the
  // watched tick agree across the web and the TV.
  const reloadProgress = useCallback(
    () =>
      api
        .state(profileId)
        .then(st => {
          setProgress(st.progress || {});
          setEpProgress(st.episodeProgress || {});
        })
        .catch(() => {}),
    [profileId],
  );
  const setEpisodeWatched = useCallback(
    async (ep: UiEp, watched: boolean) => {
      const imdb = item.imdbId || libImdb;
      const dur = ep.durationSec && ep.durationSec > 0 ? ep.durationSec : 1;
      if (ep.epId) {
        if (watched) await api.saveProgress(profileId, ep.epId, dur, dur);
        else await api.clearProgress(profileId, ep.epId);
      } else if (imdb) {
        const key = `stream|${imdb}|${ep.season}|${ep.episode}`;
        if (watched) await api.saveProgress(profileId, key, dur, dur, {imdbId: imdb, season: ep.season, episode: ep.episode, title: item.title});
        else await api.clearProgress(profileId, key);
      }
    },
    [item.imdbId, item.title, libImdb, profileId],
  );
  // Save the best source for an episode we don't hold: the server's
  // recommended stream (or the best-seeded one), requested with the same
  // fields the Sources screen sends. The card shows the job from here.
  const downloadBest = useCallback(
    async (s: number, e: number, air: UiEp['air']) => {
      if (air !== 'aired') {
        showToast(air === 'tba' ? 'Not scheduled yet' : 'Not aired yet', '⏳');
        return;
      }
      const running = epJobs[`${s}x${e}`];
      if (running) {
        showToast(`${dlText(running).toLowerCase().replace(/^\w/, c => c.toUpperCase())} — hold the episode for its sources`, '⏳');
        return;
      }
      const imdb = await ensureImdb();
      if (!imdb) {
        openEpisodeSources(s, e);
        return;
      }
      showToast(`Finding the best source for S${s} E${e}…`, '⬇');
      try {
        const {streams} = await api.torrentSources({type: 'series', title: imdb, year: item.year ?? undefined, season: s, episode: e});
        const alive = (streams || []).filter(x => x.seeders > 0);
        const pick = alive.find(x => x.recommended) || alive[0] || (streams || [])[0];
        if (!pick) {
          showToast('No sources for this episode yet', '⚠');
          return;
        }
        const res = await api.requestDownload({
          infoHash: pick.infoHash,
          fileIdx: pick.fileIdx,
          type: 'show',
          imdbId: imdb,
          title: item.title,
          label: `${item.title} · S${s} E${e}`,
          year: item.year ?? undefined,
          quality: pick.quality,
          sizeBytes: pick.sizeBytes,
          provider: pick.provider,
          seeders: pick.seeders,
          season: s,
          episode: e,
          profile: profileId,
        });
        if (res.alreadyAvailable) showToast("Already yours — it's in the library", '✅');
        else if (res.duplicate) showToast('Already queued. Patience.', '⏳');
        else if (res.needsApproval) showToast(`Requested ${pick.quality} · ${pick.sizeString || ''} — waiting for approval`, '⬇');
        else showToast(`Saving ${pick.quality} · ${pick.sizeString || ''} — the card shows the progress`, '⬇');
        // show it on the card at once, then let the poll take over
        setEpJobs(prev => ({...prev, [`${s}x${e}`]: {status: res.needsApproval ? 'pending' : 'approved', progress: 0}}));
        setTimeout(() => {
          if (!pollArmed.current) setFullTick(t => t + 1); // re-arms the poll via the focus effect
        }, 1500);
      } catch (err) {
        showToast((err as Error)?.message || "Couldn't request the download", '⚠');
      }
    },
    [epJobs, ensureImdb, openEpisodeSources, item.title, item.year, profileId],
  );
  const downloadBestRef = useRef<(s: number, e: number, air: UiEp['air']) => void>(() => {});
  downloadBestRef.current = downloadBest;
  const episodeActions = useCallback(
    (ep: UiEp) => {
      openActions({
        title: unescapeHtml(ep.label),
        sub: `${item.title} · S${ep.season} E${ep.episode}`,
        items: [
          ...(!ep.owned ? [{label: 'Sources', tag: 'streams and downloads', onPress: () => openEpisodeSources(ep.season, ep.episode)}] : []),
          {
            label: ep.watched ? 'Mark unwatched' : 'Mark watched',
            tag: ep.watched ? 'back to unseen' : 'ticks it off',
            onPress: () => {
              setEpisodeWatched(ep, !ep.watched)
                .then(() => {
                  showToast(ep.watched ? `S${ep.season} E${ep.episode} marked unwatched` : `S${ep.season} E${ep.episode} marked watched`, '✓');
                  return reloadProgress();
                })
                .catch(() => showToast("Couldn't save that", '⚠'));
            },
          },
          ...(ep.owned ? [{label: 'Play', tag: 'your copy', onPress: ep.onPlay}, {label: 'Sources', tag: 'other versions', onPress: () => openEpisodeSources(ep.season, ep.episode)}] : []),
        ],
      });
    },
    [item.title, setEpisodeWatched, reloadProgress, openEpisodeSources],
  );
  const episodeActionsRef = useRef<(ep: UiEp) => void>(() => {});
  episodeActionsRef.current = episodeActions;
  const seasonAired = (curSeason?.episodes || []).filter(e => e.air === 'aired');
  const seasonAllWatched = seasonAired.length > 0 && seasonAired.every(e => e.watched);
  const [seasonBusy, setSeasonBusy] = useState(false);
  const markSeason = useCallback(
    async (watched: boolean) => {
      if (!curSeason || seasonBusy) return;
      setSeasonBusy(true);
      try {
        for (const e of curSeason.episodes) {
          if (e.air !== 'aired' || e.watched === watched) continue;
          await setEpisodeWatched(e, watched);
        }
        showToast(watched ? `Season ${curSeason.number} marked watched` : `Season ${curSeason.number} marked unwatched`, '✓');
        await reloadProgress();
      } catch {
        showToast("Couldn't save that", '⚠');
      } finally {
        setSeasonBusy(false);
      }
    },
    [curSeason, seasonBusy, setEpisodeWatched, reloadProgress],
  );

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
  // The rail is the page's last row. RN scrolls a focused card just far enough
  // to be visible, which left its bottom edge ON the screen edge (Mi TV,
  // 2026-10-07: the glass box's foot at 1075 of 1080px, no air under it) — so a
  // focused card scrolls the page to its end instead, where the bottom padding
  // is. The film page's shelf does the same.
  const scrollRef = useRef<ScrollView>(null);
  const scrollToEnd = useCallback(() => scrollRef.current?.scrollToEnd({animated: true}), []);
  const renderEpisode = useCallback(
    ({item: ep, index}: {item: UiEp; index: number}) => (
      <EpisodeCard ep={ep} edgeLeft={index === 0} onFocus={scrollToEnd} onMore={() => episodeActionsRef.current(ep)} />
    ),
    [scrollToEnd],
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
  const renderShelfCard = useCallback(
    ({item: sim, index}: {item: HeroItem; index: number}) => (
      <Card item={sim} index={index} onPress={openSimilar} edgeLeft={index === 0} onFocus={scrollToEnd} />
    ),
    [openSimilar, scrollToEnd],
  );
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
        <HeroArt art={backdrop} sharp={backdropSharp} />
        {/* The panels trap focus, so the rail is unreachable while one is up —
            §5.8(a). */}
        <NavRail active={navSection} disabled={!!srcPanel || likePanel} />
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={{paddingTop: artTop, paddingBottom: safeBottom}}
          showsVerticalScrollIndicator={false}>
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
          synopsis={full?.synopsis || streamMeta?.synopsis || item.synopsis}
          synopsisLines={2}
          cast={streamMeta?.cast}
          note={srcNote}
          bottomInset={0}
          secondary={
            <>
              <IconBtn ref={listBtnRef} icon={inList ? 'check' : 'plus'} on={inList} label="My List" onPress={toggleList} />
              {streamMeta?.trailers?.length ? (
                <IconBtn icon="film" label="Trailer" onPress={() => openTrailer(streamMeta.trailers!, item.title)} />
              ) : null}
              <IconBtn glyph="⋯" label="Similar" onPress={() => setLikePanel(true)} />
              <IconBtn
                icon="xray"
                label="X-Ray"
                onPress={() => openXray({query: full?.id ? {itemId: full.id} : {type: 'series', imdbId: item.imdbId || libImdb}, title: item.title})}
              />
            </>
          }>
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
          {!nextUp ? (
            <PrimaryBtn hasTVPreferredFocus edgeLeft label="▶  Play S1 E1" onPress={() => uiSeasons[0]?.episodes[0]?.onPlay()} />
          ) : null}
        </DetailHero>

        {/* Season pills + the episode rail, in flow under the lockup. */}
        <Text style={styles.dockTitle}>Episodes</Text>
        <View>
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
          {/* the site's season pill: one press ticks the aired episodes off (or back) */}
          {seasonAired.length > 0 ? (
            <View style={styles.seasonTools}>
              <Focusable round onPress={() => markSeason(!seasonAllWatched)} style={styles.pill}>
                <Text style={styles.pillText}>
                  {seasonBusy ? 'Saving…' : seasonAllWatched ? 'Mark season unwatched' : `Mark season watched${seasonAired.filter(e => !e.watched).length < seasonAired.length ? ` (${seasonAired.filter(e => !e.watched).length} left)` : ''}`}
                </Text>
              </Focusable>
              <Text style={styles.seasonHint}>Hold OK on an episode for more</Text>
            </View>
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
        </ScrollView>
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
      <HeroArt art={backdrop} sharp={backdropSharp} />
      {/* Both returns need this. A change made to one is invisible on the
          other — that has cost a full debugging cycle before. */}
      <NavRail active={navSection} disabled={!!srcPanel || likePanel} />
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={{paddingTop: artTop, paddingBottom: safeBottom}}
        showsVerticalScrollIndicator={false}>
      <DetailHero
        kicker="FILM"
        title={item.title}
        rating={item.rating}
        metaParts={[
          item.year && String(item.year),
          fmtDuration(full?.duration) || (streamMeta?.runtime ? String(streamMeta.runtime) : null),
        ]}
        badges={[
          full?.certificate || streamMeta?.certificate,
          resBadge(full?.height, full?.width),
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
        bottomInset={0}
        secondary={
          <>
            <IconBtn ref={listBtnRef} icon={inList ? 'check' : 'plus'} on={inList} label="My List" onPress={toggleList} />
            {streamMeta?.trailers?.length ? (
              <IconBtn icon="film" label="Trailer" onPress={() => openTrailer(streamMeta.trailers!, item.title)} />
            ) : null}
            {ownedMovieId ? <IconBtn glyph="≡" label="Versions" onPress={openSources} /> : null}
            <IconBtn
              icon="xray"
              label="X-Ray"
              onPress={() => openXray({query: ownedMovieId ? {itemId: ownedMovieId} : {type: 'movie', imdbId: item.imdbId || libImdb}, title: item.title})}
            />
            {ownedMovieId ? (
              <IconBtn icon="check" on={movieWatched} label="Watched" onPress={toggleWatched} />
            ) : null}
          </>
        }>
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
          // "Stream" — the site's word; a title not on disk streams, and the
          // list of sources is where that choice is made.
          <PrimaryBtn hasTVPreferredFocus edgeLeft label="⚠  Stream" onPress={openSources} />
        )}
      </DetailHero>
      {/* The shelf: titles like this one, below the fold like Max's Extras. */}
      <View>
        <Text style={styles.dockTitle}>More like this</Text>
        {similar === null ? (
          <ActivityIndicator color={colors.text} style={styles.railSpinner} />
        ) : similar.length === 0 ? (
          <Text style={styles.dockEmpty}>Nothing close enough to suggest.</Text>
        ) : (
          <FlatList
            data={similar}
            horizontal
            keyExtractor={(it, i) => `${it.imdbId || it.id}-${i}`}
            showsHorizontalScrollIndicator={false}
            style={styles.rail}
            contentContainerStyle={styles.likeRailContent}
            initialNumToRender={8}
            windowSize={5}
            renderItem={renderShelfCard}
          />
        )}
      </View>
      </ScrollView>
      {loading ? <ActivityIndicator color={colors.text} style={styles.loading} /> : null}
      {sourcesOverlay}
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
    // OPAQUE. It was 98.5%, meant to let the artwork breathe — but at that
    // depth no artwork survives, only the page's TEXT does: the title, the
    // synopsis and the episode names ghosted faintly between the source rows,
    // and a TV panel's lifted blacks make faint very visible (Mi TV,
    // 2026-10-06). Solid reads as a sheet; the poster at its left is the art.
    backgroundColor: colors.bg,
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
    backgroundColor: colors.bg, // opaque, as srcOverlay (the page ghosted through)
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
  artBox: {position: 'absolute', top: 0, right: 0, left: '30%', height: '76%'},
  // Screen-relative: the box is left 38% → right, top 0 → 76% high.
  // One full-screen RGBA image (tools/gen_ambient.py detail-mask) carries both
  // ramps — the only overlay shape this box has drawn reliably.
  artMask: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%'},
  art: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  artFallback: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bgRaised},
  // Light. The site multiplies its backdrop down to 0.42 brightness because a
  // web page has to carry body text over it; here the ramps do that job on the
  // side the text is actually on, so the picture keeps its own life.
  artDim: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(6,7,14,0.18)'},
  // 78% wide: the ramp is transparent by its own right edge, so the artwork's
  // right side is untouched.
  artSide: {position: 'absolute', top: 0, left: 0, bottom: 0, width: '84%', height: '100%'},
  artVeil: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%'},

  // ---- the lockup ---------------------------------------------------------
  // Bottom-anchored: the title sits low over the art, which is the Apple TV
  // composition and leaves the top two thirds of the frame to the picture.
  hero: {paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX},
  scroll: {flex: 1},
  // Max's icon row: a 40dp disc with a tiny label under it.
  iconBtn: {alignItems: 'center', width: 74, paddingVertical: 2},
  iconBtnDisc: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  iconBtnDiscOn: {backgroundColor: colors.white, borderColor: colors.white},
  iconBtnGlyph: {color: colors.text, fontSize: 18, fontWeight: '800', lineHeight: 22},
  iconBtnLabel: {color: colors.textDim, fontSize: 11, fontWeight: '700', marginTop: 4},
  // 64%: four actions on a film need the width, and the ramp is still
  // transparent well before the artwork's subject on the right.
  // Full width now that no poster shares the row: six 40dp buttons sit on one
  // line (64% wrapped them under each other and into the shelf below).
  lockup: {maxWidth: '42%'},
  lockupRow: {flexDirection: 'row', alignItems: 'flex-end', gap: spacing.lg},
  lockupBeside: {flex: 1, maxWidth: '72%'},
  // `.detail-poster` — 240px → 150dp, 2:3, the large radius and a deep shadow.
  poster: {
    width: 120,
    height: 180,
    borderRadius: radius.l,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: 'rgba(226,229,238,0.3)',
    boxShadow: '0 18px 40px rgba(0,0,0,0.55)',
  },
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
  metaRow: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm + 2, marginTop: 6},
  rating: {color: colors.star, fontSize: fontSize.small, fontWeight: '800'},
  meta: {color: colors.textDim, fontSize: fontSize.small, fontWeight: '600'},
  // Genres as a plain line, not chips. Five pills under a 52dp title is a second
  // row of furniture competing with the buttons for the eye.
  genreLine: {color: colors.textFaint, fontSize: fontSize.small, fontWeight: '700', marginTop: 6},
  genreRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8},
  genreChip: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '700',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 10,
    overflow: 'hidden',
  },
  synopsis: {color: 'rgba(243,244,248,0.86)', fontSize: fontSize.body, lineHeight: 22, marginTop: spacing.md},
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
  actionsSecondary: {flexDirection: 'row', gap: 2, marginTop: spacing.sm, marginLeft: -16, flexWrap: 'wrap'},
  playBtn: {backgroundColor: colors.white, paddingVertical: 9, paddingHorizontal: 22, minHeight: 40, justifyContent: 'center'},
  playText: {color: colors.bg, fontSize: fontSize.body, fontWeight: '800'},
  // Translucent rather than the flat surface colour: these sit on artwork now,
  // and a solid slab there reads as a hole punched in the picture.
  ghost: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 9,
    paddingHorizontal: 16,
    minHeight: 40,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  ghostText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  ghostSmall: {paddingVertical: 6, paddingHorizontal: 12, minHeight: 32, backgroundColor: 'rgba(255,255,255,0.09)'},
  ghostTextSmall: {fontSize: fontSize.small},
  note: {color: colors.accent, fontSize: fontSize.small, fontWeight: '700', marginTop: spacing.sm},
  loading: {position: 'absolute', bottom: spacing.xl, left: spacing.contentLeft},

  // ---- the season dock ----------------------------------------------------
  bottomDock: {position: 'absolute', left: 0, right: 0, bottom: 0},
  seasonRow: {flexGrow: 0, height: SEASON_H},
  seasonTools: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX, marginBottom: 4},
  seasonHint: {color: colors.textFaint, fontSize: fontSize.small},
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
  dockTitle: {
    color: colors.text,
    fontSize: fontSize.row,
    lineHeight: 24,
    fontWeight: '800',
    paddingLeft: spacing.contentLeft,
    marginBottom: 2,
  },
  dockEmpty: {color: colors.textDim, fontSize: fontSize.small, paddingLeft: spacing.contentLeft, paddingTop: spacing.md},
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
  likeRailContent: {
    paddingLeft: spacing.contentLeft,
    paddingRight: spacing.pageX,
    paddingTop: 20,
    paddingBottom: 8,
    gap: spacing.md,
  },
  railSpinner: {alignSelf: 'flex-start', marginLeft: spacing.contentLeft, marginBottom: spacing.xl},

  // ---- episode card -------------------------------------------------------
  // The Focusable itself now. Padding-bottom keeps the ring off the badges, and
  // the radius is what the ring follows.
  epCard: {
    width: EP_W,
    borderRadius: radius.m,
    borderWidth: EP_EDGE,
    borderColor: 'rgba(226,229,238,0.3)',
    backgroundColor: colors.surface,
    padding: EP_PAD,
    paddingBottom: 8,
  },
  epCardOwned: {borderColor: 'rgba(74,222,128,0.38)'},
  epCardUpNext: {borderColor: 'rgba(139,123,255,0.5)'},
  // Insets only, no percent size: a percent width here is of the CONTENT box
  // (the card minus its padding), which drew the glow short of the right and
  // bottom edges (elia's photo). The four insets fill the padding box.
  // Sized to the card's PADDING box in dp (the Mi TV did not draw the image
  // from insets alone, and a percent size is of the content box, which drew
  // it short of the right and bottom edges).
  epOwnedGlow: {position: 'absolute', top: 0, left: 0, width: EP_W - EP_EDGE * 2, height: EP_PAD + EP_ART_H + EP_BODY_H + 8, borderRadius: radius.m - 1},
  // '100%' on BOTH axes, so the still is exactly the content box and the ring
  // hugs it. The width was already '100%'; only the height was absolute, which
  // is the whole of the bug.
  epThumb: {
    width: '100%',
    // Explicit again: the still no longer sits inside a Focusable that was
    // sizing it, so it states its own 16:9 box off the ART width (EP_W minus the
    // ring's reserved 3dp each side).
    height: EP_ART_H,
    // Rounded on top only (the site's card still, glass.css:3389): the
    // timeline lies along the still's foot, and against rounded bottom corners
    // its ends poked out past the picture (elia's photo, 2026-10-07).
    borderTopLeftRadius: radius.s,
    borderTopRightRadius: radius.s,
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
  epBar: {
    position: 'absolute',
    // Yoga places an absolute child against the padding box, so the glass
    // padding is added back to keep the bar on the still's own edges.
    left: EP_PAD,
    right: EP_PAD,
    // On the still's own bottom edge — 2dp over the picture, 1dp over the glass.
    top: EP_PAD + EP_ART_H - 2,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  epBarFill: {
    height: '100%',
    backgroundColor: '#8b7bff',
    experimental_backgroundImage: 'linear-gradient(90deg, #8b7bff, #a6c8ff)',
    boxShadow: '0 0 10px rgba(139,123,255,0.6)',
  },
  // a download in flight: the mint ramp, like the site's card
  epBarFillDl: {backgroundColor: '#8cffbe', experimental_backgroundImage: 'linear-gradient(90deg, #7fd1e8, #8cffbe)', boxShadow: '0 0 10px rgba(140,255,190,0.55)'},
  epKickerDl: {color: '#8cffbe'},
  epKickerRow: {flexDirection: 'row', alignItems: 'center', gap: 5},
  epBarHead: {
    position: 'absolute',
    right: -3,
    top: -2,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#ffffff',
    boxShadow: '0 0 8px rgba(255,255,255,0.9)',
  },
  // 4dp horizontal inset: the caption sits inside the Focusable, and without it
  // the focus ring's stroke was drawn over the first letter (seen on-device:
  // "Thanksgiving" lost the top of its T).
  epBody: {height: EP_BODY_H, paddingTop: 8, paddingHorizontal: 3, justifyContent: 'space-between'},
  // Announced, not yet watchable: the site greys the whole row.
  epBodyUnaired: {opacity: 0.6},
  // glass.css .episode-kicker: 0.72rem 700, 0.08em tracking, uppercase, 0.7 white.
  epKicker: {
    color: 'rgba(243,244,248,0.7)',
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 0.9,
  },
  epTitle: {
    color: colors.text,
    fontSize: fontSize.small,
    lineHeight: 18,
    fontWeight: '800',
    letterSpacing: -0.1,
    marginTop: 2,
  },
  epOverview: {color: 'rgba(243,244,248,0.62)', fontSize: 12, lineHeight: 16, marginTop: 3},
  epFoot: {flexDirection: 'row', alignItems: 'center', gap: 6, height: 18},
  epFootSpacer: {flex: 1},
  epAir: {color: colors.textDim, fontSize: 12, fontWeight: '600'},
  epAirDim: {color: colors.textFaint},
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
