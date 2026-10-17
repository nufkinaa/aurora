// The native Focusable (P1 of docs/native-rewrite/00-plan.md). Fabric codegen
// reads this file (it must end in NativeComponent.ts) and generates the C++
// ShadowNode / ComponentDescriptor plus the static view config the JS uses.
// The Kotlin side is android/app/src/main/java/com/auroratv/ui/view/
// AuroraFocusableView.kt + AuroraFocusableManager.kt.
//
// Colours are ColorValue so React Native's own processColor turns them into
// the same ARGB ints the JS Focusable's views get — no second colour parser.
// The ring's box-shadow arrives pre-parsed by RN's processBoxShadow (five
// scalars) for the same reason.
import {codegenNativeCommands, codegenNativeComponent} from 'react-native';
import type {CodegenTypes as CT, ColorValue, HostComponent, ViewProps} from 'react-native';
import type * as React from 'react';

export type FocusChangeEvent = Readonly<{focused: boolean; edgeLeft: boolean; edgeRight: boolean}>;
export type PressEvent = Readonly<{}>;

export interface NativeProps extends ViewProps {
  // 'white' | 'violet' | 'none' — the ring token (Focusable.tsx RING_COLOR).
  ringKind?: CT.WithDefault<string, 'white'>;
  // focus.borderWidth (3) unless the caller overrides (a Card passes 2).
  ringWidth?: CT.WithDefault<CT.Double, 3>;
  ringColor?: ColorValue;
  // The flattened borderRadius of the element (Focusable.tsx:279-284).
  ringRadius?: CT.WithDefault<CT.Double, 12>;
  // The ring's drop shadow, parsed by processBoxShadow in the JS wrapper.
  shadowOffsetX?: CT.WithDefault<CT.Double, 0>;
  shadowOffsetY?: CT.WithDefault<CT.Double, 10>;
  shadowBlur?: CT.WithDefault<CT.Double, 24>;
  shadowSpread?: CT.WithDefault<CT.Double, 0>;
  shadowColor?: ColorValue;
  // --focus-ring-light: 3dp bg gap + 4dp ring outside the box. The gap is
  // colors.bg, the ring RING_COLOR[ring] (white when ring='none').
  light?: CT.WithDefault<boolean, false>;
  lightRingColor?: ColorValue;
  lightGapColor?: ColorValue;
  // Whether the JS passed onPress / onLongPress (event props do not reach
  // native): a long press only arms its 500 ms timer when there is a handler,
  // and a plain press only clicks (and plays the key sound) when there is one.
  hasPress?: CT.WithDefault<boolean, true>;
  hasLongPress?: CT.WithDefault<boolean, false>;
  // Wash whose opacity rides the ring value, drawn under the children.
  highlightColor?: ColorValue;
  scaleTo?: CT.WithDefault<CT.Double, 1.055>;
  noScale?: CT.WithDefault<boolean, false>;
  lift?: CT.WithDefault<CT.Double, 0>;
  edgeLeft?: CT.WithDefault<boolean, false>;
  edgeRight?: CT.WithDefault<boolean, false>;
  // nextFocusLeft = self.
  holdLeft?: CT.WithDefault<boolean, false>;
  // focusable=false + descendants blocked.
  focusDisabled?: CT.WithDefault<boolean, false>;
  // hasTVPreferredFocus, with the 600 ms / first-focus disarm done natively.
  preferredFocus?: CT.WithDefault<boolean, false>;
  onFocusChange?: CT.DirectEventHandler<FocusChangeEvent>;
  onPress?: CT.DirectEventHandler<PressEvent>;
  onLongPress?: CT.DirectEventHandler<PressEvent>;
}

type ComponentType = HostComponent<NativeProps>;

interface NativeCommands {
  requestTVFocus: (viewRef: React.ElementRef<ComponentType>) => void;
  clearRing: (viewRef: React.ElementRef<ComponentType>) => void;
}

export const Commands: NativeCommands = codegenNativeCommands<NativeCommands>({
  supportedCommands: ['requestTVFocus', 'clearRing'],
});

export default codegenNativeComponent<NativeProps>('AuroraFocusable') as ComponentType;
