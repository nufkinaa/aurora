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
//
// THE RENDER SWITCHES (render.ts; docs/qa/native-lab/), all off by default:
//   `row`   the track is the Fabric view AuroraRow (AuroraRowView.kt) instead of
//           the Animated.View: it starts the slide itself, on the UI thread, in
//           the call that moved focus (the same spring, the same target), so
//           focusCard below does everything but `tx.to`. Same tree otherwise.
//   `pool`  (with `row` and `card`) the cards sit in recycled SLOTS
//           (shelfPool.ts) instead of being keyed by title.
import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Image, StyleSheet, Animated, TVFocusGuideView, useWindowDimensions} from 'react-native';
import Card, {CARD_W, CARD_H, FRAME_W, FRAME_H} from './Card';
import {HeroItem} from '../api';
import {defer, useSlide} from '../motion';
import {aheadOf, heldWindow, nextRun, restWindow, rowWindow, runMargins, slideFor, visibleRange, Dir, Margins, MARGINS, MARGINS_LOW, Run, RowGeom, SETTLE_MS} from '../rowWindow';
import {prefetchable} from '../cardArt';
import {artIdle, limits} from '../artPrefetch';
import {isLowRam} from '../perfTier';
import {fixOn, nativeOn} from '../render';
import {assignSlots, outside} from '../shelfPool';
import {pinFocused, Pin} from '../shelfPin';
import {isFocusLogging} from '../qa';
import AuroraRow from '../specs/AuroraRowNativeComponent';
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

// The render switches (read once at startup, never flip while mounted).
const NATIVE_ROW = nativeOn.row;
const POOL = NATIVE_ROW && nativeOn.card && fixOn.pool;
// The track: AuroraRow takes the geometry as props and slides itself; the
// Animated.View is moved by `tx`.
const Track = (NATIVE_ROW ? AuroraRow : Animated.View) as React.ComponentType<Record<string, unknown>>;
// What identifies a card on the shelf (the keyed shelf's React key).
const keyOf = (item: HeroItem, index: number) => item.id || item.imdbId || `${item.title}-${index}`;
// The same identity without the index, for shelfPin.ts (a title that moved
// must still be found).
const pinKey = (item: HeroItem) => item.id || item.imdbId || item.title;
// After a removal: past the sheet's close and its hand-back of focus, inside
// focus.ts's 120 ms rescue (which then finds focus taken and does nothing).
const REFOCUS_MS = 60;
// The shelf that last had a card focused (Row is Home's alone): the one whose
// focused title is held in place when its items are re-read (shelfPin.ts).
let pinShelf: object | null = null;

// A shelf's geometry, for rowWindow.ts. A wide shelf is Continue Watching,
// which draws the frame card.
export const shelfGeom = (wide: boolean, viewportW: number): RowGeom => ({
  step: (wide ? FRAME_W : CARD_W) + spacing.md,
  cardW: wide ? FRAME_W : CARD_W,
  contentLeft: spacing.contentLeft,
  viewportW,
  lead: LEAD,
});

// What a shelf remembers while it is not mounted (Home's vertical window,
// homeWindow.ts): the card focus was on, and which way it was travelling.
// From those two the shelf comes back exactly as it was left — the same slide
// offset, the same cards mounted, and focus returning to that card.
export type ShelfMemory = {f: number; dir: Dir};

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
  store,
  storeKey,
  caption,
}: {
  title: string;
  // [household] the cards print their own line (item.meta, "From Dana") — Card's `caption`
  caption?: boolean;
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
  // Given by a caller that may unmount this shelf and mount it again (Home's
  // vertical window): where this shelf's ShelfMemory is kept, and under which
  // key. Written on every card focus (no render); read ONCE, at mount. Without
  // it the shelf is what it always was.
  store?: Map<string, ShelfMemory>;
  storeKey?: string;
}) {
  const {width} = useWindowDimensions();
  const geom = useMemo(() => shelfGeom(!!wide, width), [wide, width]);
  // Every card in the row is absolutely positioned, so none of them contributes
  // height and the track would collapse to nothing. Both card shapes have a
  // known size (Card.tsx owns the geometry), so the row states it outright.
  const cardH = wide ? FRAME_H : CARD_H;
  const n = items ? items.length : 0;
  // MOUNTED AGAIN (a shelf Home had replaced with a spacer): it starts where
  // it was left, in its first commit —
  //   • the slide already at that card's offset (no travel to see),
  //   • the same cards mounted as when focus was last here,
  //   • and the focus guide pointed at that card (below): a new guide has no
  //     "last focused child", and would hand focus to its first card.
  const kept = store && storeKey != null && n > 0 ? store.get(storeKey) : undefined;
  // (a copy: the kept one is written on every focus)
  const back = useRef(kept ? {f: kept.f, dir: kept.dir} : undefined).current;
  const backF = back ? Math.max(0, Math.min(back.f, n - 1)) : -1;
  const tx = useSlide(back ? -slideFor(backF, geom) : 0);
  // Where focus is and which way it is travelling: what the window is derived
  // from. `m` null = nobody has focused this shelf yet (it holds what shows).
  // `keep`: what stays mounted while the slide is still travelling (rowWindow.ts
  // heldWindow) — null once the remote has rested.
  const [at, setAt] = useState<{f: number; dir: Dir; m: Margins | null; keep: {from: number; to: number} | null}>(() =>
    back ? {f: backF, dir: back.dir, m: isLowRam() ? MARGINS_LOW : MARGINS, keep: null} : {f: 0, dir: 1, m: null, keep: null},
  );
  const resting = at.m ? rowWindow(Math.max(0, Math.min(at.f, n - 1)), at.dir, n, geom, at.m) : restWindow(n, geom);
  const win = at.keep ? {from: Math.max(0, Math.min(at.keep.from, resting.from)), to: Math.min(n, Math.max(at.keep.to, resting.to))} : resting;
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );
  const from = win.from;
  const to = win.to;
  // What is committed, for the check below.
  const shown = useRef(win);
  useEffect(() => {
    shown.current = {from, to};
  }, [from, to]);
  const lastIdx = useRef(back ? backF : 0);
  // RE-READ UNDER FOCUS (shelfPin.ts): the title focus was on stays at the
  // index focus was on, so the window, the slide and the pool — all derived
  // from that index — still hold it, and the card is not unmounted under the
  // focus Android gives back on BACK. Only on the shelf that last held focus.
  const me = useRef({}).current;
  const focusKey = useRef<string | null>(null);
  const focusItem = useRef<HeroItem | undefined>(undefined);
  const pinned = useMemo(() => {
    const pin: Pin<HeroItem> | null = pinShelf === me && focusKey.current != null ? {key: focusKey.current, index: lastIdx.current, item: focusItem.current} : null;
    return {list: pinFocused(items || [], pinKey, pin), pin};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  const list = pinned.list;
  useEffect(() => {
    const p = pinned.pin;
    if (!p) return;
    const server = (items || []).findIndex(it => pinKey(it) === p.key);
    // (adb logcat -s ReactNativeJS | grep "\[row\] reread") kept=held: the re-read no longer
    // had the title, it is held where focus is (shelfPin.ts)
    console.log(`[row] reread row=${rowIndex ?? 0} card=${p.key} at=${p.index} server=${server} kept=${server >= 0 ? 'yes' : 'held'}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned]);
  useEffect(
    () => () => {
      if (pinShelf === me) pinShelf = null;
    },
    [me],
  );
  // Remove from Continue Watching (the peek sheet's button): the title is
  // meant to go, so it is no longer held in place (shelfPin.ts) by the re-read
  // that follows — and focus goes to the card that takes its place. The device
  // pass (Mi TV, 2026-10-18) found it nowhere useful: the removed card unmounted
  // under the sheet's hand-back, and Android sent focus to the billboard (JS
  // row) or to a card past the right edge that the native track never slid to.
  const cardEls = useRef(new Map<number, {requestTVFocus?: () => void}>()).current;
  // One ref function per index, made once: `ref` is a prop to the memoised
  // Card, and a new function each render would re-render every card.
  const refFns = useRef(new Map<number, (el: View | null) => void>()).current;
  const refFor = (index: number) => {
    let fn = refFns.get(index);
    if (!fn) {
      fn = (el: View | null) => {
        if (index === backF) backCard.current = el;
        if (el) cardEls.set(index, el as unknown as {requestTVFocus?: () => void});
        else cardEls.delete(index);
      };
      refFns.set(index, fn);
    }
    return fn;
  };
  const refocusAt = useRef<number | null>(null);
  const removeCard = useCallback(
    (item: HeroItem) => {
      if (focusKey.current === pinKey(item)) {
        focusKey.current = null;
        focusItem.current = undefined;
        refocusAt.current = lastIdx.current;
      }
      onRemove?.(item);
    },
    [onRemove],
  );
  // Read through a ref: `items` in focusCard's deps would hand every card a
  // new onFocus (and a re-render) each time Home's data is replaced.
  const itemsRef = useRef(list);
  itemsRef.current = list;
  const dirRef = useRef<Dir>(back ? back.dir : 1);
  // the run of presses this one belongs to (rowWindow.ts runMargins)
  const runRef = useRef<Run | null>(null);
  // The focus guide, and the card it is pointed at until focus has come in
  // once. `destinations` outranks the guide's own memory (ReactViewGroup
  // .requestFocus), so it is taken away again on the first focus inside:
  // from then on the guide remembers by itself, as it does on a shelf that
  // was never unmounted.
  const guide = useRef<React.ComponentRef<typeof TVFocusGuideView> | null>(null);
  const backCard = useRef<View | null>(null);
  const aimed = useRef(false);
  useLayoutEffect(() => {
    if (!back || !backCard.current || !guide.current?.setDestinations) return;
    guide.current.setDestinations([backCard.current]);
    aimed.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const focusCard = useCallback(
    (item: HeroItem, index: number) => {
      onItemFocus?.(item, rowIndex ?? 0);
      pinShelf = me;
      focusKey.current = pinKey(item);
      focusItem.current = item;
      if (isFocusLogging()) console.log(`[row] focus row=${rowIndex ?? 0} idx=${index} card=${pinKey(item)}`);
      if (aimed.current) {
        aimed.current = false;
        guide.current?.setDestinations?.([]);
      }

      // Moves the TARGET of the spring that is already running (motion.ts).
      // (The native track has already started it, inside the focus change.)
      if (!NATIVE_ROW) tx.to(-slideFor(index, geom));

      if (index !== lastIdx.current) dirRef.current = index > lastIdx.current ? 1 : -1;
      lastIdx.current = index;
      const dir = dirRef.current;
      if (store && storeKey != null) {
        const mem = store.get(storeKey);
        if (mem) {
          mem.f = index;
          mem.dir = dir;
        } else store.set(storeKey, {f: index, dir});
      }
      // a held key leads further, either way (rowWindow.ts runMargins)
      runRef.current = nextRun(runRef.current, dir, Date.now());
      const m = runMargins(isLowRam() ? MARGINS_LOW : MARGINS, runRef.current.n);
      const list = itemsRef.current || [];
      const count = list.length;

      // A card of this focus's resting viewport is not mounted yet: the
      // margin was used up (commits running 2+ presses late, or a turn).
      const v = visibleRange(index, count, geom);
      const behind = v.last >= shown.current.to || v.first < shown.current.from;
      if (behind) {
        console.log(`[row] behind row=${rowIndex ?? 0} idx=${index} visible=${v.first}..${v.last} mounted=${shown.current.from}..${shown.current.to - 1}`);
      }

      // The window follows focus — off the input path, because it changes
      // what is mounted. One card per press in a steady run.
      // While focus keeps moving nothing mounted is let go (the slide trails a
      // held key by several cards); SETTLE_MS after the last move the window
      // is cut back to what rests on screen.
      // EXCEPT when a card that is on screen is missing: then the window is
      // committed NOW (an urgent update, the next frame), not in a transition
      // that a held key's stream of urgent work can keep postponing — the card
      // used to arrive a press or more late (Mi TV, 2026-10-18).
      const first = shown.current;
      const follow = () =>
        setAt(p => {
          if (p.f === index && p.dir === dir && p.m === m) return p;
          const next = rowWindow(index, dir, count, geom, m);
          return {f: index, dir, m, keep: heldWindow(p.keep || first, next, dir)};
        });
      if (behind) follow();
      else defer(follow);
      if (settle.current) clearTimeout(settle.current);
      settle.current = setTimeout(() => {
        settle.current = null;
        // at rest the plain margins again: the held lead was for the run
        const plain = isLowRam() ? MARGINS_LOW : MARGINS;
        defer(() => setAt(p => (p.keep || (p.m && p.m !== plain) ? {...p, keep: null, m: plain} : p)));
      }, SETTLE_MS);

      // And when the remote rests: the pictures of the cards beyond the
      // window, the way focus was travelling (artPrefetch.ts).
      artIdle('row', () => {
        const w = rowWindow(index, dir, count, geom, m);
        return aheadOf(w, dir, count, limits().row).map(i => prefetchable(list[i], {wide, frame: wide}));
      });
    },
    [onItemFocus, rowIndex, geom, tx, wide, store, storeKey, me],
  );

  const window = useMemo(() => list.slice(from, to), [list, from, to]);
  // (removeCard) after the removal's commit, and after the sheet's own
  // hand-back of focus to the card that is gone: the card now at that index
  useEffect(() => {
    const i = refocusAt.current;
    if (i == null) return;
    refocusAt.current = null;
    const at = Math.min(i, list.length - 1);
    if (at < 0) return;
    const t = setTimeout(() => {
      const el = cardEls.get(at);
      if (!el?.requestTVFocus) return;
      el.requestTVFocus();
      console.log(`[row] removed: focus to idx=${at} row=${rowIndex ?? 0}`);
    }, REFOCUS_MS);
    return () => clearTimeout(t);
  }, [list, cardEls, rowIndex]);
  // (`pool`) the slots: which title each one shows, and where on the shelf.
  const slotKeys = useRef<(string | null)[]>([]);
  const slotted = useMemo(() => {
    if (!POOL) return null;
    const at = new Map<string, number>();
    list.forEach((it, i) => at.set(keyOf(it, i), i));
    const focusedItem = list[lastIdx.current];
    const next = assignSlots(
      slotKeys.current,
      window.map((it, i) => keyOf(it, from + i)),
      k => {
        const i = at.get(k);
        return i == null ? Infinity : outside(i, from, to);
      },
      focusedItem ? keyOf(focusedItem, lastIdx.current) : null,
    );
    slotKeys.current = next;
    const index = next.map(k => (k == null ? -1 : at.get(k) ?? -1));
    return {items: index.map(i => (i < 0 ? null : list[i])), index};
  }, [list, window, from, to]);

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
        ref={guide}
        autoFocus
        trapFocusLeft
        trapFocusRight
        trapFocusUp={false}
        trapFocusDown={false}
        style={styles.viewport}>
        <Track
          style={[styles.track, {height: cardH}, NATIVE_ROW ? null : {transform: [{translateX: tx.value}]}]}
          {...(NATIVE_ROW
            ? {step: geom.step, lead: geom.lead, contentLeft: geom.contentLeft, count: n, initialIndex: backF > 0 ? backF : 0}
            : null)}>
          {(slotted ? slotted.items : window).map((item, i) => {
            if (!item) return null;
            const index = slotted ? slotted.index[i] : from + i;
            return (
              <View
                // Keyed by IDENTITY, not position. Home refetches on focus
                // regain, and Continue Watching reorders (the just-watched
                // title moves to the front): with the index in the key, every
                // key in the window changed and React REMOUNTED every card —
                // including the focused one, whose loss threw focus to the
                // hero. With identity keys React moves the mounted subtree;
                // the slot's `left` updates in place and focus stays put.
                key={slotted ? `slot-${i}` : keyOf(item, index)}
                // Absolute, so a card entering or leaving the window can never
                // reflow the ones already on screen — with a flex row, mounting
                // a card at the front would shove every other card sideways
                // underneath the focus.
                style={[styles.slot, {left: geom.contentLeft + index * geom.step}]}>
                <Card
                  item={item}
                  index={index}
                  ref={refFor(index)}
                  onPress={onSelect}
                  onFocus={focusCard}
                  wide={wide}
                  frame={wide}
                  showKind={showKind}
                  onRemove={onRemove ? removeCard : undefined}
                  caption={caption}
                  // Nothing sits to the left of card 0, so LEFT from it belongs
                  // to the nav rail. trapFocusLeft below stops the platform
                  // moving focus; NavRail's own handler answers the press.
                  edgeLeft={index === 0}
                />
              </View>
            );
          })}
        </Track>
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
