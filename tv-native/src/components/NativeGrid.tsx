// The recycling grid of poster cards (`impl.grid`, letter G) — what stands where a
// screen's vertical `FlatList numColumns` stood (docs/native-rewrite/00-plan.md P6;
// docs/qa/native-bench/POOL-PLAN.md).
//
// WHAT THE FLATLIST COST. It decides which rows exist from the scroll offset, in JS,
// after the scroll: rows are mounted and unmounted in batches as you move — six cards
// a row, some forty host views each way through Fabric on the UI thread — and its own
// bookkeeping runs on every scroll event.
//
// WHAT THIS DOES INSTEAD. A fixed pool of rows (8, poolMath.ts) is mounted once.
// Row r lives in row-slot r mod 8, every card in a slot keyed by its slot number,
// listed in slot order. When focus has moved two rows the window follows it, and the
// rows that fell out are handed the items of the rows that came in — one commit that
// changes props on views that already exist. Nothing is created, deleted or
// re-ordered; a card that stays in the window is not even re-rendered.
//
// WHAT IS KEPT, so the picture and the movement are the FlatList's:
//   - the same tree around the cards: a focus guide that mirrors the list's style and
//     traps UP / DOWN while rows exist beyond the mounted ones (VirtualizedList's own
//     guide), a React Native ScrollView inside it with the caller's content padding,
//     the footer after the cards;
//   - the same geometry, stated instead of flowed: card (r, c) at c × (CARD_W + gap),
//     r × (CARD_H + gap) — the FlatList's rows are `gap` apart with a trailing
//     `marginBottom: gap`, which is this arithmetic;
//   - THE SCROLL. Not replaced by a spring: the FlatList's "slide" is Android's
//     ScrollView bringing the focused card into view by the smallest move, at once.
//     The same ScrollView with the same card rectangle scrolls by the same amount.
//
// What the native container (AuroraGrid → AuroraGridView.kt) adds: the grid's ONE
// focus event (`onItemFocus {index}`, read from the focused card's laid-out edges —
// the cards get no onFocus prop), painting the slots in item order, and leaving
// off-screen rows out of the display list.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ScrollView, StyleSheet, TVFocusGuideView, View} from 'react-native';
import type {StyleProp, ViewStyle} from 'react-native';
import Card, {CARD_W, CARD_H} from './Card';
import {HeroItem} from '../api';
import {defer} from '../motion';
import {GRID_AHEAD, GRID_BEHIND, gridAnchor, gridRows, gridSlotItems, gridWindow, poolSize} from '../poolMath';
import AuroraGrid, {GridItemFocusEvent} from '../specs/AuroraGridNativeComponent';

const POOL_ROWS = poolSize(GRID_BEHIND, GRID_AHEAD);

type FocusNode = {requestTVFocus?: () => void};

type Props = {
  items: HeroItem[];
  cols: number;
  // The space between cards, across and down (Browse: GRID_GAP).
  gap: number;
  onSelect: (item: HeroItem) => void;
  // The focused card, from the container's one event. Must not need a stable
  // identity: it is read through a ref.
  onItemFocus?: (item: HeroItem, index: number) => void;
  // `hasTVPreferredFocus` per index (focus.ts useListClaim).
  claims?: (index: number) => boolean;
  // Handed something with `requestTVFocus()` that lands on the FIRST card — the
  // screen's focus fallback. The FlatList always kept its first cells mounted; the
  // pool may have handed row 0's slots on, so this brings the window back to the
  // top first when it has.
  firstRef?: React.MutableRefObject<unknown>;
  // RIGHT from the last column belongs to the screen (Browse's filter panel).
  edgeRight?: boolean;
  // The FlatList's `style` (mirrored onto the focus guide, as the list did).
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  footer?: React.ReactElement | null;
};

// The anchor a grid of `rows` rows can have (the list may have shrunk under it).
const clampRow = (anchor: number, rows: number) => Math.max(0, Math.min(anchor, rows - 1));

function NativeGrid({
  items,
  cols,
  gap,
  onSelect,
  onItemFocus,
  claims,
  firstRef,
  edgeRight,
  style,
  contentContainerStyle,
  footer,
}: Props) {
  const count = items.length;
  const rows = gridRows(count, cols);
  const colPitch = CARD_W + gap;
  const rowPitch = CARD_H + gap;

  // Which row the mounted window is centred on. State, because it changes what the
  // slots show — but it follows focus only every GRID_SLACK rows, off the input path.
  const [anchor, setAnchor] = useState(0);
  // The newest focused row this thread has heard of, and the grid's length, read when
  // the deferred anchor update finally runs — gridAnchor's guard.
  const latestRow = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const focusCb = useRef(onItemFocus);
  focusCb.current = onItemFocus;

  const onGridFocus = useCallback(
    (e: {nativeEvent: GridItemFocusEvent}) => {
      const index = e.nativeEvent.index;
      const item = itemsRef.current[index];
      if (item) focusCb.current?.(item, index);
      const row = Math.floor(index / cols);
      latestRow.current = row;
      defer(() => setAnchor(prev => gridAnchor(clampRow(prev, rowsRef.current), row, latestRow.current, rowsRef.current)));
    },
    [cols],
  );

  const {from, to} = gridWindow(clampRow(anchor, rows), rows);
  const slots = useMemo(() => gridSlotItems(from, to, cols, count, POOL_ROWS), [from, to, cols, count]);

  // ---- the first card, wherever the window is ---------------------------------
  const scroll = useRef<ScrollView>(null);
  const card0 = useRef<View | null>(null);
  const wantFirst = useRef(false);
  const first = useRef<FocusNode>({
    requestTVFocus: () => {
      const node = card0.current as FocusNode | null;
      if (node?.requestTVFocus) {
        node.requestTVFocus();
        return;
      }
      // Row 0 is not mounted: bring the window (and the page) back to the top, then
      // focus the card when it exists (the effect below).
      wantFirst.current = true;
      scroll.current?.scrollTo({y: 0, animated: false});
      setAnchor(0);
    },
  }).current;
  useEffect(() => {
    if (!firstRef) return;
    firstRef.current = first;
    return () => {
      if (firstRef.current === first) firstRef.current = null;
    };
  }, [firstRef, first]);
  useEffect(() => {
    if (!wantFirst.current) return;
    const node = card0.current as FocusNode | null;
    if (!node?.requestTVFocus) return;
    wantFirst.current = false;
    node.requestTVFocus();
  });

  return (
    <TVFocusGuideView style={style} trapFocusUp={from > 0} trapFocusDown={to < rows}>
      <ScrollView ref={scroll} style={style} contentContainerStyle={contentContainerStyle}>
        <AuroraGrid
          style={{height: rows * rowPitch}}
          cols={cols}
          colPitch={colPitch}
          rowPitch={rowPitch}
          count={count}
          onItemFocus={onGridFocus}>
          {slots.map((index, slot) =>
            // A slot with no item (a short last row, a grid shorter than the pool)
            // renders nothing and keeps its place and key.
            index < 0 || !items[index] ? null : (
              <View
                key={slot}
                style={[styles.cell, {left: (index % cols) * colPitch, top: Math.floor(index / cols) * rowPitch}]}>
                <Card
                  item={items[index]}
                  index={index}
                  ref={index === 0 ? card0 : undefined}
                  onPress={onSelect}
                  // Column 0 has nothing to its left, so LEFT from it opens the rail.
                  edgeLeft={index % cols === 0}
                  edgeRight={!!edgeRight && index % cols === cols - 1}
                  hasTVPreferredFocus={claims ? claims(index) : false}
                />
              </View>
            ),
          )}
        </AuroraGrid>
        {footer}
      </ScrollView>
    </TVFocusGuideView>
  );
}

export default NativeGrid;

const styles = StyleSheet.create({
  // Absolute, like a shelf's slots: a rebound cell can never reflow its neighbours.
  cell: {position: 'absolute'},
});
