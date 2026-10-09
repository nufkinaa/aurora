// Home's sliding column (P4 of docs/native-rewrite/00-plan.md; 01-architecture.md §2.4).
// Fabric codegen reads this file; the Kotlin side is android/app/src/main/java/com/auroratv/
// ui/view/AuroraSlideColumnView.kt + AuroraSlideColumnManager.kt.
//
// It stands exactly where Home.tsx's `Animated.View style={styles.column}` stands, holding
// the hero block, the shelves and the bottom spacer as ordinary React children. What it
// owns is the vertical slide: when Android moves focus onto a descendant, the view finds
// the marked child that descendant lives in — the hero block (nativeID `aurora-col-top`) or
// shelf i's wrapper (`aurora-col-row-<i>`), src/homeMath.ts — and springs its own
// translationY to 0 or to `targets[i]` on the UI thread, in the same call that moved focus.
// JS is told afterwards, once, with `onRowFocus {index}` (-1 = the hero), for its own
// bookkeeping (`isTop`, the trailer, which shelves are mounted).
//
// Geometry arrives as a prop: Home.tsx measures its rows (onLayout) and computes every
// target (homeMath.ts columnTargets); the view derives nothing.
import {codegenNativeComponent} from 'react-native';
import type {CodegenTypes as CT, HostComponent, ViewProps} from 'react-native';

/** `index` is the shelf, or -1 when focus landed in the hero block. */
export type RowFocusEvent = Readonly<{index: CT.Int32}>;

export interface NativeProps extends ViewProps {
  // The column's resting translateY (dp, <= 0) with shelf i focused. A value > 0 means
  // "not measured yet": focus landing there does not slide (toRow's `if (y == null) return`).
  targets?: ReadonlyArray<CT.Double>;
  // Shared with the AuroraHeroArt of the same screen: the art follows this column's offset
  // and top/shelves state natively (ColumnLink.kt). Unique per mounted Home.
  link?: string;
  // Focus landed in a marked child. Fired on every gain, like Card's onFocus → toRow.
  onRowFocus?: CT.DirectEventHandler<RowFocusEvent>;
}

export default codegenNativeComponent<NativeProps>('AuroraSlideColumn') as HostComponent<NativeProps>;
