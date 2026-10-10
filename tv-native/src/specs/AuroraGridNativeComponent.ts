// The native grid body (P6 of docs/native-rewrite/00-plan.md, the recycling shape of
// docs/qa/native-bench/POOL-PLAN.md). Fabric codegen reads this file; the Kotlin side is
// android/app/src/main/java/com/auroratv/ui/view/AuroraGridView.kt + AuroraGridManager.kt.
//
// It stands inside the scroll view's content, where the FlatList's rows stood, and holds
// the card slots of components/NativeGrid.tsx as ordinary React children, absolutely placed
// at `col * colPitch`, `row * rowPitch`. It never looks inside them. What it owns:
//   - naming the focused card: when Android moves focus onto a descendant, the view reads
//     that child's laid-out edges and fires `onItemFocus {index}` — the grid's one focus
//     event, from which JS pages, warms the Detail data and moves the mounted rows;
//   - the paint order: the slots are mounted in SLOT order and rebound, so the view paints
//     them by position, i.e. in item order (PoolHost.kt);
//   - leaving the rows that are outside the window out of its display list (Cull.kt) — the
//     FlatList's `removeClippedSubviews`, without detaching anything.
// The scrolling is NOT here: it stays React Native's ScrollView, so "bring the focused card
// into view" is the very code the FlatList ran.
import {codegenNativeComponent} from 'react-native';
import type {CodegenTypes as CT, HostComponent, ViewProps} from 'react-native';

export type GridItemFocusEvent = Readonly<{index: CT.Int32}>;

export interface NativeProps extends ViewProps {
  // Cards per row.
  cols?: CT.WithDefault<CT.Int32, 1>;
  // One card plus the gap after it, dp, across and down (CARD_W | CARD_H + the grid gap).
  colPitch?: CT.WithDefault<CT.Double, 0>;
  rowPitch?: CT.WithDefault<CT.Double, 0>;
  // items.length — the focused index is clamped to it. 0 = unknown, no upper clamp.
  count?: CT.WithDefault<CT.Int32, 0>;
  // A descendant gained focus: which card. Fired on every gain, like Card's onFocus.
  onItemFocus?: CT.DirectEventHandler<GridItemFocusEvent>;
}

export default codegenNativeComponent<NativeProps>('AuroraGrid') as HostComponent<NativeProps>;
