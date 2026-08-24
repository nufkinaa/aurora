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
import {imgSrc, HeroItem} from '../api';
import theme from '../theme';

const {colors, radius, cardAura} = theme;

// .card-new — the site marks anything added in the last week, but only if you
// haven't started it (components.js:77).
const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const CARD_W = 124;
export const CARD_H = 186; // 176 × 0.70, 2:3 (components.css:321-324)
// `.card.wide` is 300px at 16/9 (components.css:325-328). ×0.59, which is the one
// place the card set is not ×0.70 — D3 pinned both shapes directly.
export const WIDE_W = 176;
export const WIDE_H = 99;

// `.card-shade` (components.css:348) — a two-stop axis-aligned gradient, drawn as
// one. It was a stretched PNG, which put a single bitmap across both a 124×186 and
// a 176×99 box: the anisotropy §4.3 forbids for the aura, and the reason the old
// asset needed its width/height spelling out to render at all.
const Shade = React.memo(function CardShade() {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id="cardShade" x1="0" y1="1" x2="0" y2="0">
          <Stop offset="0" stopColor="#05060c" stopOpacity="0.92" />
          <Stop offset="0.45" stopColor="#05060c" stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" rx={radius.m} fill="url(#cardShade)" />
    </Svg>
  );
});

function Card({
  item,
  index,
  onPress,
  onFocus,
  onRemove,
  hasTVPreferredFocus,
  wide,
  hideLabel,
  showKind,
  edgeLeft,
  edgeRight,
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
  hideLabel?: boolean;
  // Draw the FILM / SERIES corner tag, on rows that mix the two.
  showKind?: boolean;
  // First card of its row, or column 0 of a grid: LEFT from here opens the nav
  // rail rather than moving focus.
  edgeLeft?: boolean;
  // Last column of a grid: RIGHT from here opens Browse's filter panel.
  edgeRight?: boolean;
  // Forwarded to the Focusable, so a grid can hold its first card as a focus
  // target (requestTVFocus lives on the host instance).
  ref?: React.Ref<View>;
}) {
  const isEpisode = !!item.showId && item.type !== 'show';
  const landscape = wide || isEpisode;
  // `cover` on BOTH shapes, which is what the site does — components.js:121 hands
  // `item.cover` to the <img> with no branch and lets `.card.wide` crop it 16:9.
  // A landscape still would read better and elia is fixing that ON THE SITE
  // first; see SPEC/99-open.md §I.2. Do not change it here ahead of the site.
  const src = imgSrc(item.cover || item.poster);
  const showLabel = !hideLabel && (landscape || item.upNext);
  const prog = item.progress;
  const pct =
    prog && prog.duration > 0 && !prog.finished
      ? Math.min(100, Math.round((prog.position / prog.duration) * 100))
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
  const leftTag: 'new' | 'stream' | null = isNew
    ? 'new'
    : item.source === 'stream' && landscape
    ? 'stream'
    : null;
  // components.js:129 suppresses the kind tag whenever the ✕ is present — that
  // corner belongs to the ✕.
  const kind = showKind && !landscape && !onRemove;

  return (
    <Focusable
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
      edgeRight={edgeRight}
      onPress={() => onPress(item)}
      onLongPress={removable ? () => removable(item) : undefined}
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
      style={landscape ? styles.cardWide : styles.card}>
      {src ? (
        // resizeMethod="resize": decode at view size, not source size — dozens of
        // posters decoded full-size is a silent memory/CPU tax on a TV.
        // fadeDuration={0}: Android's 300ms default makes every poster feel late.
        <Image
          source={src}
          style={styles.poster}
          resizeMode="cover"
          resizeMethod="resize"
          fadeDuration={0}
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

      {showLabel ? <Shade /> : null}

      {/* `.card-label` — the show name above "S1 E1 · Episode" on an episode card,
          the plain title otherwise. One line, tail-ellipsised: the CSS is
          `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`
          (components.css:372-374). */}
      {showLabel ? (
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
      {leftTag === 'stream' ? (
        <View style={[styles.tag, styles.tagLeft]} pointerEvents="none">
          {/* maxWidth 81 on a 124dp card = 124 − 7 − 25 − 7 − 4 (§B row 58). At the
              estimated advance the pill measures ~76dp and the clamp never
              engages; it exists so the word can never reach the kind tag or the
              card edge. NEVER shrink the type to make it fit — P11 struck that. */}
          <Text style={styles.tagText} numberOfLines={1} ellipsizeMode="tail">
            STREAM
          </Text>
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
        <View style={styles.progress} pointerEvents="none">
          <View style={[styles.progressFill, {width: `${pct}%`}]} />
        </View>
      ) : null}
    </Focusable>
  );
}

export default React.memo(Card);

const styles = StyleSheet.create({
  // No overflow:'hidden' — `.card` is explicitly not clipped (components.css:237-241),
  // and clipping here would cut the focus treatment off every card.
  card: {width: CARD_W, height: CARD_H, borderRadius: radius.m, backgroundColor: colors.bgRaised},
  cardWide: {width: WIDE_W, height: WIDE_H, borderRadius: radius.m, backgroundColor: colors.bgRaised},
  poster: {width: '100%', height: '100%', borderRadius: radius.m},
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
  tagNew: {backgroundColor: colors.accentStrong, borderColor: 'transparent'},
  tagNewText: {color: colors.white},
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
  progressFill: {height: '100%', backgroundColor: colors.progress, borderRadius: 2},
});
