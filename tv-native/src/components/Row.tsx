// A titled horizontal shelf of poster cards.
//
// THE ROW SLIDES; THE HIGHLIGHT DOES NOT WANDER; AND IT CATCHES UP RATHER THAN
// TELEPORTING.
//
// Three separate problems, solved in that order over three rounds:
//
// 1. Left to itself the platform scrolls a focused child into view by the
//    MINIMUM amount needed, so the highlight walks to the right edge of the
//    screen before the row moves at all. Apple TV instead holds the focused card
//    at a fixed slot and slides the shelf underneath it, so the eye never moves
//    and a forty-item row feels like a four-item one.
//
// 2. Doing that with FlatList.scrollToOffset({animated:true}) fixed the resting
//    positions but broke the movement, and this is the interesting one. RN
//    Android implements animated scroll with a REUSED ValueAnimator
//    (ReactScrollViewHelper.smoothScrollTo, 250ms). Calling start() on a running
//    ValueAnimator restarts it from t=0 with the new endpoints and DISCARDS
//    velocity — and its start value comes from the previous animation's TARGET,
//    not from where the content actually is. Android TV repeats a held key ~20x
//    a second, i.e. every 50ms against a 250ms curve, so each animation was
//    killed at a fifth of its travel and relaunched from a position that had
//    never been drawn. The result is the "jump straight to where the focus
//    ended up" that this row used to do: the intermediate motion was computed
//    and thrown away.
//
//    There is no way to retarget that animator, so the scroll view is gone. The
//    shelf is a translated Animated.View on a retargetable spring — motion.ts
//    owns that now, and its header is where the reasoning lives.
//
// 3. Losing FlatList means losing virtualization, so the windowing is done here
//    — rowWindow.ts: the cards that can be on screen for this focus, plus a
//    margin, following focus ONE card per press. (It used to move in blocks of
//    three so that two presses in three rendered nothing; the price was that
//    the right-most cards on screen did not exist until the block moved, and
//    then three mounted at once in view.) A press now re-renders this Row —
//    eleven memoised cards that bail out — and mounts one card, off screen.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Image, StyleSheet, Animated, TVFocusGuideView, useWindowDimensions} from 'react-native';
import Card, {CARD_W, CARD_H, FRAME_W, FRAME_H} from './Card';
import {HeroItem} from '../api';
import {defer, useSlide} from '../motion';
import {aheadOf, restWindow, rowWindow, slideFor, visibleRange, Dir, Margins, MARGINS, MARGINS_LOW, RowGeom} from '../rowWindow';
import {prefetchable} from '../cardArt';
import {artIdle, limits} from '../artPrefetch';
import {isLowRam} from '../perfTier';
import theme from '../theme';

// The page colour melting to clear over the row's left margin, so a card that
// has slid past the edge fades out instead of ending in a cut (elia,
// 2026-10-07). Baked by tools/gen_ambient.py; a stretched PNG always draws on
// the Mi TV where a gradient style did not.
const ROW_FADE = require('../assets/row-fade.png');

const {colors, fontSize, spacing, CLEARANCE, CANCEL} = theme;

// How many cards sit to the LEFT of the focused one once the row is sliding.
// Zero pins focus hard against the page margin, which looks mechanical and hides
// the fact that there is anything behind you; one leaves a card visible on the
// left so the row reads as a strip you are moving along. Apple TV sits at about
// the same place.
const LEAD = 1;

// A shelf's geometry, for rowWindow.ts. A wide shelf is Continue Watching,
// which draws the frame card.
export const shelfGeom = (wide: boolean, viewportW: number): RowGeom => ({
  step: (wide ? FRAME_W : CARD_W) + spacing.md,
  cardW: wide ? FRAME_W : CARD_W,
  contentLeft: spacing.contentLeft,
  viewportW,
  lead: LEAD,
});

// THE MOUNTED WINDOW, IN NUMBERS (960dp canvas; rowWindow.ts has the rule).
// Posters (step 138): cards f-2 … f+5 intersect the viewport around focus f;
// with two ahead and one behind that is f-3 … f+7 — 11 cards (it was 9, at
// [anchor-3, anchor+5] with the anchor up to 2 behind focus). Continue
// Watching (step 238): f-2 … f+2 visible, 8 mounted (was 9). A shelf nobody
// has focused holds only what shows: 7 posters / 4 frames (was 6 / 6 — the
// seventh poster's 48dp at the right edge did not exist).
// Every mounted card holds a decoded picture and 11–14 views, and Home keeps
// every shelf you have passed, so this stays a margin, not a second screen:
// v46 measured 9/5 (15 cards) against 5/3 and Home's frames went 53 → 650 ms
// over four bursts. A low-memory box keeps one ahead and none behind (9).
function Row({
  title,
  items,
  onSelect,
  onItemFocus,
  rowIndex,
  showKind,
  wide,
  onRemove,
}: {
  title: string;
  items: HeroItem[];
  onSelect: (item: HeroItem) => void;
  // Bubbled up from the cards so Home can spotlight whatever has focus. It is
  // handed `rowIndex` back, so the caller can pass ONE function to every row:
  // a function made per row per render (an inline arrow) is a new prop each
  // time, and this memoised Row — and through `focusCard` every memoised Card
  // in it — then re-renders whenever the caller does.
  onItemFocus?: (item: HeroItem, rowIndex: number) => void;
  rowIndex?: number;
  // Passed straight to Card — the FILM / SERIES corner tag, for rows that mix
  // the two.
  showKind?: boolean;
  // Continue Watching draws landscape cards; every other shelf uses posters.
  wide?: boolean;
  // Continue Watching only — draws the ✕ and binds long-press OK to removal.
  onRemove?: (item: HeroItem) => void;
}) {
  const {width} = useWindowDimensions();
  const geom = useMemo(() => shelfGeom(!!wide, width), [wide, width]);
  // Every card in the row is absolutely positioned, so none of them contributes
  // height and the track would collapse to nothing. Both card shapes have a
  // known size (Card.tsx owns the geometry), so the row states it outright.
  const cardH = wide ? FRAME_H : CARD_H;
  const tx = useSlide();
  const n = items ? items.length : 0;
  // Where focus is and which way it is travelling: what the window is derived
  // from. `m` null = nobody has focused this shelf yet (it holds what shows).
  const [at, setAt] = useState<{f: number; dir: Dir; m: Margins | null}>({f: 0, dir: 1, m: null});
  const win = at.m ? rowWindow(Math.max(0, Math.min(at.f, n - 1)), at.dir, n, geom, at.m) : restWindow(n, geom);
  const from = win.from;
  const to = win.to;
  // What is committed, for the check below.
  const shown = useRef(win);
  useEffect(() => {
    shown.current = {from, to};
  }, [from, to]);
  // Read through a ref: `items` in focusCard's deps would hand every card a
  // new onFocus (and a re-render) each time Home's data is replaced.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const lastIdx = useRef(0);
  const dirRef = useRef<Dir>(1);
  const focusCard = useCallback(
    (item: HeroItem, index: number) => {
      onItemFocus?.(item, rowIndex ?? 0);

      // Moves the TARGET of the spring that is already running (motion.ts).
      tx.to(-slideFor(index, geom));

      if (index !== lastIdx.current) dirRef.current = index > lastIdx.current ? 1 : -1;
      lastIdx.current = index;
      const dir = dirRef.current;
      const m = isLowRam() ? MARGINS_LOW : MARGINS;
      const list = itemsRef.current || [];
      const count = list.length;

      // Should never print: a card of this focus's resting viewport is not
      // mounted yet — the margin was used up (commits running 2+ presses late).
      const v = visibleRange(index, count, geom);
      if (v.last >= shown.current.to || v.first < shown.current.from) {
        console.log(`[row] behind row=${rowIndex ?? 0} idx=${index} visible=${v.first}..${v.last} mounted=${shown.current.from}..${shown.current.to - 1}`);
      }

      // The window follows focus — off the input path, because it changes
      // what is mounted. One card per press in a steady run.
      defer(() => setAt(p => (p.f === index && p.dir === dir && p.m === m ? p : {f: index, dir, m})));

      // And when the remote rests: the pictures of the cards beyond the
      // window, the way focus was travelling (artPrefetch.ts).
      artIdle('row', () => {
        const w = rowWindow(index, dir, count, geom, m);
        return aheadOf(w, dir, count, limits().row).map(i => prefetchable(list[i], {wide, frame: wide}));
      });
    },
    [onItemFocus, rowIndex, geom, tx, wide],
  );

  const window = useMemo(() => items.slice(from, to), [items, from, to]);

  if (!items || items.length === 0) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      {/* trapFocusLeft/Right: at the ends of a row, a horizontal press must be
          a no-op — without the traps Android's proximity search hops to a card
          in ANOTHER row, which reads as focus "jumping to the wrong place".
          These are more reliable here than they were over a ScrollView: on
          react-native-tvos 0.80+ a horizontal scroller's own focusSearch can
          bypass a focus guide entirely (react-native-tvos#1087), and there is no
          longer a scroller in the way. */}
      <TVFocusGuideView
        autoFocus
        trapFocusLeft
        trapFocusRight
        trapFocusUp={false}
        trapFocusDown={false}
        style={styles.viewport}>
        <Animated.View
          style={[styles.track, {height: cardH, transform: [{translateX: tx.value}]}]}>
          {window.map((item, i) => {
            const index = from + i;
            return (
              <View
                // Keyed by IDENTITY, not position. Home refetches on focus
                // regain, and Continue Watching reorders (the just-watched
                // title moves to the front): with the index in the key, every
                // key in the window changed and React REMOUNTED every card —
                // including the focused one, whose loss threw focus to the
                // hero. With identity keys React moves the mounted subtree;
                // the slot's `left` updates in place and focus stays put.
                key={item.id || item.imdbId || `${item.title}-${index}`}
                // Absolute, so a card entering or leaving the window can never
                // reflow the ones already on screen — with a flex row, mounting
                // a card at the front would shove every other card sideways
                // underneath the focus.
                style={[styles.slot, {left: geom.contentLeft + index * geom.step}]}>
                <Card
                  item={item}
                  index={index}
                  onPress={onSelect}
                  onFocus={focusCard}
                  wide={wide}
                  frame={wide}
                  showKind={showKind}
                  onRemove={onRemove}
                  // Nothing sits to the left of card 0, so LEFT from it belongs
                  // to the nav rail. trapFocusLeft below stops the platform
                  // moving focus; NavRail's own handler answers the press.
                  edgeLeft={index === 0}
                />
              </View>
            );
          })}
        </Animated.View>
        <View style={styles.fade} pointerEvents="none">
          <Image source={ROW_FADE} style={styles.fadeImg} resizeMode="stretch" fadeDuration={0} />
        </View>
      </TVFocusGuideView>
    </View>
  );
}

export default React.memo(Row);

const styles = StyleSheet.create({
  // 11dp above the heading — the first term of 02-home §3.4's 247dp shelf pitch
  // (11 + 30 heading + 7 + 5 + 186 card + 8).
  row: {marginTop: 8},
  title: {
    color: colors.text,
    fontSize: fontSize.row,
    fontWeight: '800',
    // 7dp — the gap between a shelf heading and its cards in 02-home §3.4's
    // pitch (11 + 30 heading + 7 + 5 + 186 card + 8 = 247dp).
    marginBottom: 7,
    paddingLeft: spacing.contentLeft,
    paddingRight: spacing.pageX,
  },
  // No overflow:'hidden'. The cards that slide past the left edge are simply not
  // mounted (rowWindow.ts), and clipping here
  // would cut the focus halo off the top and bottom of every card — the same
  // slicing the vertical padding exists to prevent.
  // Padding AND the cancelling margins on the SAME box, which is how the site
  // does it (components.css:536-542). Putting the margins on the row wrapper
  // instead pulls the heading up with them — measured on the Streamer, "New
  // Episodes" landed on top of the shelf above it. The padding is what stops a
  // focused card being sliced; the margins mean the page rhythm never pays for it
  // (net 5dp above / 8dp below).
  viewport: {
    paddingTop: CLEARANCE.above,
    paddingBottom: CLEARANCE.below,
    marginTop: CANCEL.top,
    marginBottom: CANCEL.bottom,
  },
  // Height comes from the absolutely-positioned cards, which contribute none, so
  // it is set from the tallest thing a slot can hold. `alignSelf: flex-start`
  // stops the track stretching to the row's full width.
  track: {alignSelf: 'flex-start'},
  // Over the cards, under the rail: the strip spans the row's full height
  // (padding included, so the focus halo fades too) and a little past the
  // content edge, where the ramp is already near clear.
  fade: {position: 'absolute', left: 0, top: 0, bottom: 0, width: spacing.contentLeft + 10},
  fadeImg: {position: 'absolute', left: 0, top: 0, width: spacing.contentLeft + 10, height: '100%'},
  slot: {position: 'absolute', top: 0},
});
