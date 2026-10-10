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
//    — see VISIBLE_AHEAD/BEHIND. It is coarse on purpose: the window only moves
//    in blocks, so most keypresses still cost zero React renders, which is the
//    property the card layer was rebuilt around.
//
// TWO IMPLEMENTATIONS OF THE TRACK (docs/native-rewrite, P3). The default export
// reads `impl.row` once at startup and renders either today's JS body (`JsRow`,
// the reference — untouched but for the QA trace hook) or `NativeRow`, which is
// the same tree with the `Animated.View` track replaced by the Fabric component
// AuroraRow (src/specs/AuroraRowNativeComponent.ts → AuroraRowView.kt). That view
// starts the slide itself, on the UI thread, in the call that moved focus; JS
// keeps the mounted window, fed by its one `onItemFocus {index}` event.
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {View, Text, Image, StyleSheet, Animated, TVFocusGuideView} from 'react-native';
import Card, {CARD_W, CARD_H, FRAME_W, FRAME_H} from './Card';
import {HeroItem} from '../api';
import {defer, useSlide} from '../motion';
import {impl} from '../impl';
import {isTracing, onQaChange, traceValue} from '../qa';
import {LEAD as NATIVE_LEAD, nextAnchor, windowRange} from '../rowMath';
import AuroraRow, {ItemFocusEvent} from '../specs/AuroraRowNativeComponent';
import theme from '../theme';
import {gone} from '../exp';

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

// The window of cards that actually exist, either side of the focused one.
// AHEAD is generous because that is the direction you travel; BEHIND only has to
// cover LEAD plus enough that a quick reversal does not hit an empty slot.
//
// These are mount counts, not pixels: at ~5 visible cards a 14-card window is
// under three screens of shelf.
// EXPERIMENT v46: 9/5 -> 5/3. Every mounted card holds a decoded poster texture,
// and Home keeps every row you have passed mounted, so the live-texture count is
// (rows visited) x (window). Measured before: Home went 53 -> 69 -> 73 -> 650ms
// median frame over four identical bursts, GPU 87 -> 110MB.
const VISIBLE_AHEAD = 5;
const VISIBLE_BEHIND = 3;
// The window is recomputed only when focus leaves the middle of it, so stepping
// one card usually re-renders nothing at all.
const WINDOW_SLACK = 3;

type Props = {
  title: string;
  items: HeroItem[];
  onSelect: (item: HeroItem) => void;
  // Bubbled up from the cards so Home can spotlight whatever has focus.
  onItemFocus?: (item: HeroItem) => void;
  // Passed straight to Card — the FILM / SERIES corner tag, for rows that mix
  // the two.
  showKind?: boolean;
  // Continue Watching draws landscape cards; every other shelf uses posters.
  wide?: boolean;
  // Continue Watching only — draws the ✕ and binds long-press OK to removal.
  onRemove?: (item: HeroItem) => void;
};

/** The switch (01-architecture.md §1.4). Read once at startup; never flips while mounted. */
function Row(props: Props) {
  return impl.row ? <NativeRow {...props} /> : <JsRow {...props} />;
}

// =============================================================================
// The JS reference implementation — today's body, untouched except for the QA
// trace hook.
// =============================================================================
function JsRow({title, items, onSelect, onItemFocus, showKind, wide, onRemove}: Props) {
  // One step = a card plus the gap after it.
  // A wide shelf is Continue Watching, which draws the frame card now.
  const step = (wide ? FRAME_W : CARD_W) + spacing.md;
  // Every card in the row is absolutely positioned, so none of them contributes
  // height and the track would collapse to nothing. Both card shapes have a
  // known size (Card.tsx owns the geometry), so the row states it outright.
  const cardH = wide ? FRAME_H : CARD_H;
  const tx = useSlide();
  // QA trace (tools/tv-pixel-diff/PROTOCOL.md §4): `[anim] … row.tx` for the
  // shelf's translateX while the receiver has tracing on — a JS round-trip per
  // frame, so never on during a perf run. Nothing is attached otherwise.
  useEffect(() => {
    let off: (() => void) | null = null;
    const attach = () => {
      off?.();
      off = isTracing() ? traceValue('row.tx', tx.value) : null;
    };
    attach();
    const un = onQaChange(attach);
    return () => {
      un();
      off?.();
    };
  }, [tx]);
  // Where the window is centred. State, because it changes what is mounted —
  // but it only changes when focus nears the window's edge (WINDOW_SLACK), not
  // on every keypress.
  const [anchor, setAnchor] = useState(0);
  const focusCard = useCallback(
    (item: HeroItem, index: number) => {
      onItemFocus?.(item);

      // Moves the TARGET of the spring that is already running (motion.ts).
      tx.to(-Math.max(0, (index - LEAD) * step));

      // Widen the mounted window only when focus approaches its edge — and off
      // the input path, because it changes what is mounted.
      defer(() =>
        setAnchor(prev => (Math.abs(index - prev) >= WINDOW_SLACK ? index : prev)),
      );
    },
    [onItemFocus, step, tx],
  );

  const from = Math.max(0, anchor - VISIBLE_BEHIND);
  const to = Math.min(items.length, anchor + VISIBLE_AHEAD + 1);
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
                style={[styles.slot, {left: spacing.contentLeft + index * step}]}>
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

// =============================================================================
// The native track. The tree is JsRow's, element for element — the same heading,
// focus guide, slots, cards and fade strip, all still React children laid out by
// Yoga — with one substitution: the `Animated.View` is an `AuroraRow`.
//
// What that view does that the Animated.View could not: Android tells it, inside
// the focus change itself, that one of its descendants took focus; it reads the
// slot's left edge, names the card, and retargets its own spring there and then.
// So the shelf's first frame no longer waits for this thread.
//
// What stays here, and why:
//   - the heading, the guide (traps, autoFocus), the fade: not on the hot path,
//     and leaving them RN views is what keeps their pixels the JS row's;
//   - the cards: P3 does not care which implementation they are;
//   - THE MOUNTED WINDOW. Same rule, same constants, same deferral — the only
//     change is its trigger, the track's `onItemFocus {index}` instead of the
//     card's onFocus prop (so Card gets no onFocus here: one event, not two).
//     Moving the window native means the row creating its own cards from an
//     `items` prop, which is the full P3 of 00-plan.md and needs the native card
//     to carry its texts first; rowMath.ts / RowMath.kt already hold the rule
//     for that step.
// =============================================================================
function NativeRow({title, items, onSelect, onItemFocus, showKind, wide, onRemove}: Props) {
  const step = (wide ? FRAME_W : CARD_W) + spacing.md;
  const cardH = wide ? FRAME_H : CARD_H;
  const [anchor, setAnchor] = useState(0);
  const onTrackFocus = useCallback(
    (e: {nativeEvent: ItemFocusEvent}) => {
      const index = e.nativeEvent.index;
      const item = items[index];
      if (item) onItemFocus?.(item);
      defer(() => setAnchor(prev => nextAnchor(prev, index)));
    },
    [items, onItemFocus],
  );

  const {from, to} = windowRange(anchor, items ? items.length : 0);
  const window = useMemo(() => (items ? items.slice(from, to) : []), [items, from, to]);

  if (!items || items.length === 0) return null;
  return (
    <View style={styles.row}>
      <Text style={[styles.title, gone('x_rowtitle')]}>{title}</Text>
      <TVFocusGuideView
        autoFocus
        trapFocusLeft
        trapFocusRight
        trapFocusUp={false}
        trapFocusDown={false}
        style={styles.viewport}>
        <AuroraRow
          style={[styles.track, {height: cardH}]}
          step={step}
          lead={NATIVE_LEAD}
          contentLeft={spacing.contentLeft}
          count={items.length}
          onItemFocus={onTrackFocus}>
          {window.map((item, i) => {
            const index = from + i;
            return (
              <View
                key={item.id || item.imdbId || `${item.title}-${index}`}
                style={[styles.slot, {left: spacing.contentLeft + index * step}]}>
                <Card
                  item={item}
                  index={index}
                  onPress={onSelect}
                  wide={wide}
                  frame={wide}
                  showKind={showKind}
                  onRemove={onRemove}
                  edgeLeft={index === 0}
                />
              </View>
            );
          })}
        </AuroraRow>
        <View style={[styles.fade, gone('x_fade')]} pointerEvents="none">
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
  // mounted (the window starts at `anchor - VISIBLE_BEHIND`), and clipping here
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
