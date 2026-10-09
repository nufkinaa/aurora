// The native shelf track (P3 of docs/native-rewrite/00-plan.md, the "P3-lite" shape of
// 01-architecture.md §2.3). Fabric codegen reads this file; the Kotlin side is
// android/app/src/main/java/com/auroratv/ui/view/AuroraRowView.kt + AuroraRowManager.kt.
//
// It stands exactly where Row.tsx's `Animated.View` track stands: inside the row's
// TVFocusGuideView (which keeps the traps and autoFocus), holding the card slots as
// ordinary React children — JS cards or native ones, it never looks inside them. What it
// owns is the slide: when Android moves focus onto a descendant, the view works out which
// card that is from the slot's laid-out left edge and springs its own translationX to
// `-max(0, (index - lead) * step)` on the UI thread, in the same call that moved focus.
// JS is told afterwards, once, with `onItemFocus {index}` — for the mounted window and
// for Home; nothing on the slide's path waits for it.
//
// Geometry arrives as props (Row.tsx computes it, src/rowMath.ts states it); the view
// derives nothing but the focused index.
import {codegenNativeComponent} from 'react-native';
import type {CodegenTypes as CT, HostComponent, ViewProps} from 'react-native';

export type ItemFocusEvent = Readonly<{index: CT.Int32}>;

export interface NativeProps extends ViewProps {
  // One card plus the gap after it, dp (CARD_W | FRAME_W + spacing.md).
  step?: CT.WithDefault<CT.Double, 0>;
  // Cards left of the focused one once sliding (Row.tsx LEAD).
  lead?: CT.WithDefault<CT.Int32, 1>;
  // Where card 0's slot starts inside the track, dp (spacing.contentLeft).
  contentLeft?: CT.WithDefault<CT.Double, 84>;
  // items.length — the focused index is clamped to it. 0 = unknown, no upper clamp.
  count?: CT.WithDefault<CT.Int32, 0>;
  // The card the shelf rests on when it is first mounted, placed without animation.
  // Row.tsx always starts at 0 (a fresh Animated.Value); here for a restore later.
  initialIndex?: CT.WithDefault<CT.Int32, 0>;
  // A descendant gained focus: which card. Fired on every gain, like Card's onFocus.
  onItemFocus?: CT.DirectEventHandler<ItemFocusEvent>;
}

export default codegenNativeComponent<NativeProps>('AuroraRow') as HostComponent<NativeProps>;
