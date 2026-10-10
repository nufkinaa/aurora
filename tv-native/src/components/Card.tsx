// The poster card. Every interior measure here is `components.css` × 0.70 (P13),
// because the card is a self-contained scaled unit — with two exemptions the spec
// states outright: an ICON BOX is fixed at ×1.0 (P18: the ✕ box, the kind glyph)
// and TYPE never goes below the 14dp reading floor (P14).
//
// Memoized: rows re-render around it and dozens of cards re-rendering per frame is
// what made D-pad movement stutter.
import React from 'react';
import {View, Text, Image, StyleSheet} from 'react-native';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import Focusable from './Focusable';
import Icon from './Icon';
import {artPath, artPx, imgSrc, HeroItem} from '../api';
import {onMessage} from '../realtime';
import {trackError} from '../usage';
import {blurOf, markDrawn, wasDrawn} from '../blur';
import {openPeek} from '../overlay';
import theme from '../theme';
import {firstPoster} from '../telemetry'; // [analytics]

const {colors, radius, cardAura} = theme;

// The placeholder is a 16-pixel-wide picture stretched over the card, which
// is already soft; this only takes the edge off the stretch. It is applied to
// the SOURCE bitmap (react-native's Android blur runs on the decoded picture,
// at half this many device pixels), so a large value here would flatten 16
// pixels into one colour. Tune on the device if the blocks show.
const BLUR_RADIUS = 1;

// .card-new — the site marks anything added in the last week, but only if you
// haven't started it (components.js:77).
const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const CARD_W = 124;
export const CARD_H = 186; // 176 × 0.70, 2:3 (components.css:321-324)
// `.card.wide` is 300px at 16/9 (components.css:325-328). ×0.59, which is the one
// place the card set is not ×0.70 — D3 pinned both shapes directly.
export const WIDE_W = 176;
export const WIDE_H = 99;
// Continue Watching (glass.css, 2026-10-06): 320px at 16:10 on the site, with
// the picture you stopped on, the title set large on a deep fade and what is
// left under it. ×0.70 here.
// The compact poster (the AI page's results grid, 2026-10-08): 70% of the
// standard poster so eight columns fit a 960dp canvas. Same 2:3, same look.
// Wider than the first cut (88dp): the title and the reason under it were
// not readable from the sofa (elia, 2026-10-09). Six per row at 1080p.
export const COMPACT_W = 116;
export const COMPACT_H = 174;
export const FRAME_W = 224;
export const FRAME_H = 140;

// `.card-shade` (components.css:348) — #05060c from 0.92 at the foot to clear
// 45% up. Baked by tools/gen_ambient.py as an 8×256 strip that varies only
// vertically, sampled LINEARLY between the stops as the SVG gradient it
// replaces was (the older card-shade.png was smoothstepped, 24 levels off),
// so one strip stretched over a poster, a landscape or a compact card draws
// the same ramp. The SVG painted a software bitmap per card, and again on
// every focus change, on the UI thread. tools/check_baked.py: at most one
// level of 255 from the SVG over any picture.
// Width/height spelled out, as row-fade's are: a stretched PNG with only
// absolute insets did not render on the Mi TV.
const CARD_SHADE = require('../assets/card-shade-v.png');
const FRAME_SHADE = require('../assets/card-frame-shade.png');
const Shade = React.memo(function CardShade() {
  return <Image source={CARD_SHADE} style={styles.shade} resizeMode="stretch" fadeDuration={0} />;
});

// The frame card's fade (glass.css `.card.wide .card-shade`): deep at the
// foot so the large title reads over any picture, clear by two-thirds up —
// 0.95 / 0.72 at 24% / 0.18 at 52% / clear at 68%, baked the same way.
const FrameShade = React.memo(function CardFrameShade() {
  return <Image source={FRAME_SHADE} style={styles.shade} resizeMode="stretch" fadeDuration={0} />;
});

// How wide the card's picture is drawn, in dp, for the server's width
// variants. A cover-fitted picture fills the box's HEIGHT when it is wider
// than the box: a 16:9 backdrop or still on the 16:10 frame card is drawn
// FRAME_H × 16/9 wide, not FRAME_W. Posters (2:3) and anything narrower than
// the box are width-bound.
const FRAME_ART_W = Math.ceil((FRAME_H * 16) / 9);

// A picture that will not load is asked for again, but not forever: three
// slow rounds (30 s, 2 min, 8 min — the server remembers a failed upstream
// fetch for five minutes, so quicker rounds would only meet that memory),
// then the card keeps its titled tile until it is mounted again or the
// server connection comes back.
const ROUND_MS = [30000, 120000, 480000];

function Card({
  item,
  index,
  onPress,
  onFocus,
  onRemove,
  hasTVPreferredFocus,
  wide,
  frame,
  hideLabel,
  showKind,
  edgeLeft,
  holdLeft,
  edgeRight,
  compact,
  ref,
}: {
  item: HeroItem;
  // Position in the shelf. Handed back through onFocus so the row can slide to
  // the right offset without closing over the index per card (which would give
  // every card a new callback identity and defeat the memo).
  index?: number;
  onPress: (item: HeroItem) => void;
  // Reports THIS card gaining focus, so the page above can spotlight it. Must be
  // stable across renders or it defeats the memo below.
  onFocus?: (item: HeroItem, index: number) => void;
  // Continue Watching only. Draws the ✕ — which is an advertisement for the
  // gesture, not a target — and binds removal to LONG-PRESS OK on the card
  // itself (P12/P20). The site's ✕ carries no `.focusable` class
  // (components.js:139-149, focus.js:33), so making one here would invent a
  // D-pad stop the site does not have, in the middle of a shelf.
  onRemove?: (item: HeroItem) => void;
  hasTVPreferredFocus?: boolean;
  wide?: boolean;
  // Continue Watching's card: 16:10, the frame you stopped on, the title set
  // large and what is left under it (the site's glass `.card.wide`).
  frame?: boolean;
  hideLabel?: boolean;
  // Draw the FILM / SERIES corner tag, on rows that mix the two.
  showKind?: boolean;
  // First card of its row, or column 0 of a grid: LEFT from here opens the nav
  // rail rather than moving focus.
  edgeLeft?: boolean;
  // LEFT from here stays put (Focusable's holdLeft), so nothing down-left of
  // the row can take the press away from the rail.
  holdLeft?: boolean;
  // Last column of a grid: RIGHT from here opens Browse's filter panel.
  edgeRight?: boolean;
  // The smaller poster (COMPACT_W x COMPACT_H). Posters only; a landscape or
  // frame card ignores it. The default card is untouched.
  compact?: boolean;
  // Forwarded to the Focusable, so a grid can hold its first card as a focus
  // target (requestTVFocus lives on the host instance).
  ref?: React.Ref<View>;
}) {
  const isEpisode = !!item.showId && item.type !== 'show';
  const landscape = wide || isEpisode;
  const prog = item.progress;
  const pct =
    prog && prog.duration > 0 && !prog.finished
      ? Math.min(100, Math.round((prog.position / prog.duration) * 100))
      : null;
  // The picture. A frame card (Continue Watching) shows the moment you stopped
  // on when the server can cut it — a library title with a position — else the
  // title's landscape art, else the poster (components.js:164-170). Posters
  // keep the cover.
  const canFrame = frame && prog && prog.position > 20 && item.id && !String(item.id).startsWith('torrent|');
  const picture = canFrame
    ? `/img/frame/${encodeURIComponent(item.id)}?t=${Math.floor(prog!.position)}`
    : (frame && !isEpisode && item.backdrop) || item.cover || item.poster;
  // At the size it is drawn (api.ts artPath — the site's artUrl): the server
  // sends a variant that wide, so the box decodes the picture once, at size,
  // with no `resizeMethod="resize"` re-encode. Frames and hosts the server
  // does not proxy keep their address (and the on-device resize).
  const artDp = frame
    ? (!isEpisode && item.backdrop) || isEpisode
      ? FRAME_ART_W
      : FRAME_W
    : landscape
    ? WIDE_W
    : compact
    ? COMPACT_W
    : CARD_W;
  const sizedPath = canFrame ? null : artPath(picture, artPx(artDp));
  const src = imgSrc(sizedPath || picture);
  // A picture that fails is asked for again (elia, 2026-10-07: "if the app
  // did not load a cover photo it will just not try again"). Android's image
  // pipeline never retries by itself, so one hiccup on the line used to
  // strand a card for as long as it stayed mounted:
  //   try 1   the same address again, cache-busted ONCE (r=1), after 1.5 s;
  //   try 2   the server's backup poster for the title (its chain of other
  //           sources — /img/poster/<imdb id>), when the title has an id;
  //   then    the titled tile, and up to three slow rounds (ROUND_MS) while
  //           the card is still on screen — a server that was down comes back.
  //           After the third the card stops asking until it is mounted again
  //           or the server's socket reconnects ('welcome'). It used to start
  //           a round every 30 s forever, for every broken card on screen.
  // Keyed by the address, so a card that is handed a new picture starts over.
  const [fail, setFail] = React.useState<{uri: string; n: number} | null>(null);
  const tries = src && fail && fail.uri === src.uri ? fail.n : 0;
  const retryTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const rounds = React.useRef<{uri: string; n: number}>({uri: '', n: 0});
  const [parked, setParked] = React.useState<string | null>(null);
  React.useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);
  // A parked card listens for the server coming back, and only then.
  React.useEffect(() => {
    if (!parked) return;
    return onMessage('welcome', () => {
      rounds.current = {uri: parked, n: 0};
      setParked(null);
      setFail(f => (f && f.uri === parked ? null : f));
    });
  }, [parked]);
  const backupPath =
    !canFrame && /^tt\d+$/.test(String(item.imdbId || ''))
      ? `/img/poster/${item.imdbId}?type=${item.type === 'show' || isEpisode ? 'show' : 'movie'}` +
        (item.showTitle || item.title ? `&t=${encodeURIComponent(String(item.showTitle || item.title).slice(0, 80))}` : '') +
        (item.year ? `&y=${item.year}` : '')
      : null;
  const backup = backupPath ? imgSrc(artPath(backupPath, artPx(artDp)) || backupPath) : null;
  const TILE_AT = backup ? 3 : 2;
  const broken = !!src && tries >= TILE_AT;
  const shown =
    !src || tries === 0
      ? src
      : tries === 2 && backup
      ? backup
      : {...src, uri: `${src.uri}${src.uri.includes('?') ? '&' : '?'}r=1`};
  // Why a picture failed, said to the server (usage "error" events, a few per
  // run): a TV with no pictures in someone's living room is otherwise
  // undiagnosable from here (2026-10-09). The address is reduced to its
  // shape — the route and the size asked for — never the title.
  const onImgError = (e?: {nativeEvent?: {error?: string}}) => {
    if (!src) return;
    const uri = src.uri;
    const n = tries + 1;
    if (n === 1) {
      const shape = uri.replace(/^https?:\/\/[^/]+/, '').replace(/u=[^&]+/, 'u=…').replace(/\/img\/[A-Za-z0-9]{12}/, '/img/<id>').slice(0, 60);
      trackError(`image ${shape}: ${String(e?.nativeEvent?.error || '').slice(0, 90)}`);
    }
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (n >= TILE_AT) {
      setFail({uri, n});
      if (rounds.current.uri !== uri) rounds.current = {uri, n: 0};
      const round = rounds.current.n++;
      if (round >= ROUND_MS.length) {
        setParked(uri);
        return;
      }
      // the slow round: back to the first address
      retryTimer.current = setTimeout(() => setFail(f => (f && f.uri === uri ? null : f)), ROUND_MS[round]);
      return;
    }
    // (the backup poster is tried at once; the plain retry waits a breath)
    retryTimer.current = setTimeout(() => setFail({uri, n}), n === 2 ? 0 : 1500);
  };
  // Blur-up (the site's posterImg, 2026-10-07): when the server sent this
  // picture's tiny placeholder (blur.ts), the slot shows its colours and
  // rough shape from the first frame and the real picture lands over it.
  // The placeholder is keyed by the address AS THE JSON CARRIED IT. A frame
  // card's still has none of its own, so it borrows the title's art — the
  // still takes longest of all to arrive (the server cuts it on demand).
  // Cheap by construction: one extra Image, only while the picture is on its
  // way, never for a picture this run has drawn before, and gone (one state
  // change, this card only) the moment the real one has loaded.
  const blur = blurOf(
    canFrame ? item.backdrop || item.cover || item.poster : (frame && !isEpisode && item.backdrop) || item.cover || item.poster,
  );
  const [loadedUri, setLoadedUri] = React.useState<string | null>(null);
  const showBlur = !!blur && !!src && !broken && loadedUri !== src.uri && !wasDrawn(src.uri);
  const onImgLoad = () => {
    if (!src) return;
    firstPoster(); // [analytics] grid → first poster (one check; only the first after a screen change counts)
    markDrawn(src.uri);
    if (showBlur) setLoadedUri(src.uri);
  };
  const showLabel = !hideLabel && (landscape || item.upNext);
  // "N min left", under the title of a card mid-way (the site's glass look).
  const left =
    frame && prog && pct != null && prog.duration > 0
      ? `${Math.max(1, Math.round((prog.duration - prog.position) / 60))} min left`
      : null;

  // The ✕ works on "up next" cards again: the server grew a real dismissal
  // (upnext-dismiss), and Home routes their removal through it — clearProgress
  // alone used to be a silent no-op for these, which is why the gesture was
  // disabled for a while.
  const removable = onRemove;

  // P16 — NEW and STREAM are both `top:10 left:10` and their predicates are
  // independent, so both can be true. The site resolves it by paint order and
  // leaves STREAM protruding from behind the shorter NEW pill, which is an
  // accident. ONE resolved value, computed here, makes the both-drawn state
  // unreachable: NEW wins.
  const isNew =
    !!item.addedAt && Date.now() - item.addedAt < NEW_WINDOW_MS && !prog;
  //
  // STREAM is drawn on LANDSCAPE cards only. Measured on the Streamer at the
  // pinned type: the pill is ~75dp on a 124dp poster — 60% of its width, sitting
  // across the artwork's own title. PINS left this open (STILL-OPEN item 5) for
  // exactly this measurement, and the escape hatch 02-home names is "drop it on
  // posters"; elia took it. The type is NOT shrunk to make it fit — P11 struck
  // that, and the 14dp floor is the reason the pill is that wide in the first
  // place. A wide card has the width to spare, so it keeps the badge.
  // No STREAM pill any more (the site dropped it, 2026-10-06): NEW is the only
  // left-corner tag.
  const leftTag: 'new' | null = isNew ? 'new' : null;
  // components.js:129 suppresses the kind tag whenever the ✕ is present — that
  // corner belongs to the ✕.
  const kind = showKind && !landscape && !onRemove;

  return (
    <Focusable uiId="card.open"
      // components.css:255 — scale(1.055) translateY(-3px).
      scaleTo={1.055}
      lift={cardAura.lift}
      // tokens.css:65-66. A card's ring is the 2dp hairline at 0.9, NOT the 3dp
      // --focus-ring every other element takes, and the lift shadow under it.
      // `.card::before`'s blurred halo is not ported (P6).
      ringWidth={cardAura.edge.width}
      ringColor={cardAura.edge.color}
      shadow={cardAura.shadow}
      hasTVPreferredFocus={hasTVPreferredFocus}
      ref={ref}
      edgeLeft={edgeLeft}
      holdLeft={holdLeft}
      edgeRight={edgeRight}
      onPress={() => onPress(item)}
      // Hold OK: the peek sheet (site: peek.js). Continue Watching's ✕ lives
      // inside it as "Remove", so the drawn hint still tells the truth.
      onLongPress={() => openPeek(item, removable || undefined)}
      onFocusChange={onFocus ? f => f && onFocus(item, index ?? 0) : undefined}
      focusOverlay={
        <>
          {/* components.css:308-311 — the artwork brightens on focus. `brightness()`
              needs feComponentTransfer, which has no native Android view in
              react-native-svg, so it is a white overlay at the same effective
              lift. P6: this is NOT the halo and is NOT dropped. */}
          <View style={styles.brighten} />
          {/* A poster has no permanent shade — nothing is written on it — but the
              site still fades one in on focus (components.css:350-355). A card
              that already carries a label has its shade at rest instead. */}
          {showLabel ? null : <Shade />}
          {/* The ✕ is drawn only while the card holds focus, exactly as
              components.css:476 + :482-485 do it. Not a focus stop. */}
          {removable ? (
            <View style={styles.remove} pointerEvents="none">
              <Text style={styles.removeGlyph}>✕</Text>
            </View>
          ) : null}
        </>
      }
      style={frame ? styles.cardFrame : landscape ? styles.cardWide : compact ? styles.cardCompact : styles.card}>
      {showBlur ? (
        // under the poster, which is see-through until it has loaded
        <Image source={{uri: blur!}} style={styles.blur} resizeMode="cover" blurRadius={BLUR_RADIUS} fadeDuration={0} />
      ) : null}
      {src && shown && !broken ? (
        // resizeMethod="resize": decode at view size, not source size — dozens of
        // posters decoded full-size is a silent memory/CPU tax on a TV. Only
        // for a picture the server could not size (a frame, an unproxied host):
        // a sized one already IS the view's size, and "resize" would only
        // re-encode it on the box. (The backup poster is sized too.)
        // fadeDuration={0}: Android's 300ms default makes every poster feel late.
        <Image
          source={shown}
          style={styles.poster}
          resizeMode="cover"
          resizeMethod={sizedPath || (tries === 2 && backup) ? 'auto' : 'resize'}
          fadeDuration={0}
          onError={onImgError}
          onLoad={onImgLoad}
        />
      ) : (
        // `.card-fallback` (components.css:333-342) — a 160° gradient tile with
        // the title on it.
        <View style={styles.poster}>
          <Svg style={StyleSheet.absoluteFill}>
            <Defs>
              <LinearGradient id="cardFallback" x1="0" y1="0" x2="0.34" y2="0.94">
                <Stop offset="0" stopColor="#1b1d31" />
                <Stop offset="1" stopColor="#101120" />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width="100%" height="100%" rx={radius.m} fill="url(#cardFallback)" />
          </Svg>
          <View style={styles.fallbackCentre}>
            <Text style={styles.fallbackText} numberOfLines={3}>
              {item.title}
            </Text>
          </View>
        </View>
      )}

      {showLabel ? (frame ? <FrameShade /> : <Shade />) : null}

      {/* `.card-label` — the show name above "S1 E1 · Episode" on an episode card,
          the plain title otherwise. One line, tail-ellipsised: the CSS is
          `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`
          (components.css:372-374). */}
      {showLabel && frame ? (
        // The frame card's words: the show's name (or the film's title) set
        // large, the episode under it, then "▶ N min left".
        <View style={styles.frameLabel} pointerEvents="none">
          <Text style={styles.frameTitle} numberOfLines={1} ellipsizeMode="tail">
            {isEpisode ? item.showTitle || item.title : item.title}
          </Text>
          {isEpisode ? (
            <Text style={styles.frameSub} numberOfLines={1} ellipsizeMode="tail">
              {`S${item.season} E${item.episode} · ${item.title}`}
            </Text>
          ) : null}
          {left ? <Text style={styles.frameMeta}>{`▶  ${left}`}</Text> : null}
        </View>
      ) : showLabel ? (
        <View style={[styles.label, pct != null && styles.labelRaised]} pointerEvents="none">
          {isEpisode ? (
            <>
              <Text style={styles.labelSub} numberOfLines={1} ellipsizeMode="tail">
                {item.showTitle || ''}
              </Text>
              <Text style={styles.labelText} numberOfLines={1} ellipsizeMode="tail">
                {`S${item.season} E${item.episode} · ${item.title}`}
              </Text>
            </>
          ) : (
            <Text style={styles.labelText} numberOfLines={1} ellipsizeMode="tail">
              {item.title}
            </Text>
          )}
        </View>
      ) : null}

      {leftTag === 'new' ? (
        <View style={[styles.tag, styles.tagLeft, styles.tagNew]} pointerEvents="none">
          <Text style={[styles.tagText, styles.tagNewText]}>NEW</Text>
        </View>
      ) : null}

      {/* P11 — the kind tag is ICON-ONLY. An 11dp glyph, a hue and a tinted border
          encode film/series three times over, and dropping the word is what makes
          both corner tags fit on a 124dp card: 76 + 25 + insets 14 = 115 of 124.
          STREAM keeps its word because it has no icon and no hue of its own. */}
      {kind ? (
        <View
          style={[
            styles.tag,
            styles.tagKind,
            item.type === 'show' ? styles.kindSeries : styles.kindFilm,
          ]}
          pointerEvents="none">
          <Icon
            name={item.type === 'show' ? 'series' : 'film'}
            size={11}
            color={item.type === 'show' ? colors.kindSeries : colors.kindFilm}
          />
        </View>
      ) : null}

      {pct != null ? (
        <View style={[styles.progress, frame && styles.progressFrame]} pointerEvents="none">
          <View style={[styles.progressFill, {width: `${pct}%`}]}>
            <View style={styles.progressHead} />
          </View>
        </View>
      ) : null}
    </Focusable>
  );
}

export default React.memo(Card);

const styles = StyleSheet.create({
  // No overflow:'hidden' — `.card` is explicitly not clipped (components.css:237-241),
  // and clipping here would cut the focus treatment off every card.
  // The site's hairline: `outline: 1px solid rgba(226,229,238,.3)` on every
  // card (glass.css, 2026-10-06) — a light edge that lifts the artwork off the
  // page. Drawn as the card's own border, inside the radius.
  card: {width: CARD_W, height: CARD_H, borderRadius: radius.m, backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: 'rgba(226,229,238,0.3)'},
  cardCompact: {width: COMPACT_W, height: COMPACT_H, borderRadius: radius.m, backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: 'rgba(226,229,238,0.3)'},
  cardWide: {width: WIDE_W, height: WIDE_H, borderRadius: radius.m, backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: 'rgba(226,229,238,0.3)'},
  cardFrame: {width: FRAME_W, height: FRAME_H, borderRadius: radius.m, backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: 'rgba(226,229,238,0.3)'},
  poster: {width: '100%', height: '100%', borderRadius: radius.m - 1},
  // The baked shades: the padding box, at the card's radius (the SVG's rx).
  shade: {position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', borderRadius: radius.m},
  blur: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: radius.m - 1},
  // The frame card's words — glass.css `.card.wide .card-label`: 16/16/24 → ×0.7.
  frameLabel: {position: 'absolute', left: 11, right: 11, bottom: 17},
  frameTitle: {color: colors.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.2, lineHeight: 20, textShadowColor: 'rgba(0,0,0,0.6)', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 10},
  frameSub: {color: 'rgba(243,244,248,0.84)', fontSize: 13, fontWeight: '600', marginTop: 1},
  frameMeta: {color: 'rgba(243,244,248,0.8)', fontSize: 13, fontWeight: '600', marginTop: 3},
  progressFrame: {left: 11, right: 11, bottom: 9, height: 3},
  fallbackCentre: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    // components.css:336 `padding: 14px` inside `.card-fallback`, a card
    // interior at ×0.70 → 10 (02-home finding 8: it was converted at 0.505).
    padding: 10,
  },
  fallbackText: {color: colors.textDim, fontSize: 14, fontWeight: '700', textAlign: 'center'},
  // components.css:308-311, as an overlay: white at 0.055.
  brighten: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#ffffff',
    opacity: 0.055,
    borderRadius: radius.m,
  },

  // `.card-label` 12/12/10 → 8/8/7. Type is 0.9rem = 14.4 and `.card-sub`
  // 0.75rem = 12; both land on the 14dp floor (P13's one exception — type inside
  // a card stays reading-tier).
  label: {position: 'absolute', left: 8, right: 8, bottom: 7},
  // `.card-progress ~ .card-label { bottom: 20 }` → 14.
  labelRaised: {bottom: 14},
  labelText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 6,
  },
  labelSub: {
    color: colors.textDim,
    fontSize: 14,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 6,
  },

  // `.card-tag` top 10 → 7, padding 3/8 → 2/6, radius 7 → 5. The fill is the
  // authored rgba(6,8,16,0.72); `backdrop-filter: blur(4px)` has no RN equivalent
  // and is dropped rather than compensated for by darkening the fill.
  tag: {
    position: 'absolute',
    top: 7,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 5,
    backgroundColor: 'rgba(6,8,16,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  tagLeft: {left: 7, maxWidth: 81},
  // 0.62rem = 9.92px, raised to the 14dp floor (P11/P14: the width problem is
  // solved by dropping the kind tag's WORD, never by shrinking type).
  // letter-spacing 0.12em on 14dp = 1.68.
  tagText: {color: '#cbd2e6', fontSize: 14, fontWeight: '900', letterSpacing: 1.68},
  // NEW is a quieter pill than the kind tag (elia, 2026-10-09: "a bit
  // smaller"): 11dp type, 1/5 insets - still readable at 3 m, no longer the
  // loudest thing on the card.
  tagNew: {backgroundColor: colors.accentStrong, borderColor: 'transparent', paddingVertical: 1, paddingHorizontal: 5, borderRadius: 4},
  tagNewText: {color: colors.white, fontSize: 11, letterSpacing: 1.2},
  // `.card-tag.kind` right 10 → 7. gap 4 → 3 is moot with the word gone.
  tagKind: {left: undefined, right: 7, flexDirection: 'row', alignItems: 'center'},
  kindFilm: {borderColor: 'rgba(240,198,126,0.32)'},
  kindSeries: {borderColor: 'rgba(127,209,232,0.32)'},

  // `.card-remove` — 30dp box and 15dp glyph at ×1.0 (P18, an icon box), but the
  // INSET is a card interior measure and takes ×0.70: 8 → 6. `:hover`'s red is
  // dropped; there is no pointer and this is never focused, so it has no state to
  // paint it in.
  remove: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeGlyph: {color: colors.text, fontSize: 15, fontWeight: '800'},

  // `.card-progress` 12/12/8 → 8/8/6. The 4dp height is RULE B at ×1.0: it is a
  // graphic line, not an interior measure, and ×0.70 would give 2.8dp — thinner
  // than the focus ring it sits beside.
  progress: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 6,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
  },
  // The site's timeline (glass.css .scrubber-fill): the violet → cyan → mint
  // ramp with a glow, and a lit bead at its head (elia, 2026-10-07: "make the
  // resume watching timeline match how it looks really, with the green and
  // the dot").
  progressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: '#8cffbe',
    experimental_backgroundImage: 'linear-gradient(90deg, #8b7bff, #7fd1e8, #8cffbe)',
    boxShadow: '0 0 10px rgba(140,255,190,0.55)',
  },
  // The glass look's capsule head: a lit bead at the end of the fill.
  progressHead: {
    position: 'absolute',
    right: -3,
    top: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ffffff',
    boxShadow: '0 0 8px rgba(255,255,255,0.9)',
  },
});
