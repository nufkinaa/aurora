// The nav rail's drawing and slide (P5 of docs/native-rewrite/00-plan.md). Fabric codegen
// reads this file; the Kotlin side is android/app/src/main/java/com/auroratv/ui/view/
// AuroraRailPanelView.kt + AuroraRailPanelManager.kt.
//
// One component, mounted twice by NavRail.tsx — exactly where its two Animated.Views stand:
//
//   part="strip"  the collapsed strip (always mounted). Draws the scrim under its React
//                 children (the mark and the dots) and OWNS the slide: `open` / `closing`
//                 are NavRail's own state, and the 280 ms timing that used to run on an
//                 Animated.Value runs in the view. Its opacity is 1 - slide. When a close
//                 has slid all the way out it says so once: `onSlideEnd {open: false}`.
//   part="panel"  the open panel (mounted only while the rail is open). Follows the same
//                 slide (translateX -288 → 0 dp) and draws the body (twice, as the JS
//                 does), the two moving glows, the edge ramp and the feather under its
//                 React children (the focus guide with the items).
//
// The two meet through `link` (RailLink.kt), on the UI thread. The rail's KEY LOGIC is not
// here: opening, closing, wrap, traps, focus restore and arm-to-switch stay in NavRail.tsx.
import {codegenNativeComponent} from 'react-native';
import type {CodegenTypes as CT, HostComponent, ViewProps} from 'react-native';

export type SlideEndEvent = Readonly<{open: boolean}>;

export interface NativeProps extends ViewProps {
  // 'strip' | 'panel'. Fixed for the life of the view.
  part?: CT.WithDefault<string, 'strip'>;
  // The same string on the strip and the panel of one NavRail; unique per mounted rail.
  link?: string;
  // strip: NavRail's `open` state. false → the slide is 0 at once (instantClose).
  open?: CT.WithDefault<boolean, false>;
  // strip: NavRail's `closing` state. true → the slide runs to 0, then onSlideEnd.
  closing?: CT.WithDefault<boolean, false>;
  // panel: the perf tier judged the box slow — the hue loops are not started (RailHues).
  lite?: CT.WithDefault<boolean, false>;
  // strip: the close slide finished (what close()'s timing callback did).
  onSlideEnd?: CT.DirectEventHandler<SlideEndEvent>;
}

export default codegenNativeComponent<NativeProps>('AuroraRailPanel') as HostComponent<NativeProps>;
