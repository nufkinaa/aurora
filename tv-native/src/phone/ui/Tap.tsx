// Every touchable in the phone app: an Android ripple inside the shape, and a
// small press-in so a tap reads even on a picture where the ripple is faint.
import React from 'react';
import {GestureResponderEvent, Pressable, PressableProps, StyleProp, ViewStyle} from 'react-native';
import {uiHit} from '../../telemetry';
import {trail} from '../../trail'; // [report trail]

type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** the ripple spreads past the box (round icon buttons) */
  borderless?: boolean;
  /** no press-in scale (rows, wide surfaces) */
  flat?: boolean;
  rippleColor?: string;
  /** [analytics] which control this is (src/lib/tel/vocab.js CONTROLS, the phone's "p"): a
   *  press is counted, never what it was pressed on */
  uiId?: string;
  children?: React.ReactNode;
};

export default function Tap({style, borderless, flat, rippleColor, uiId, children, ...rest}: Props) {
  const press = rest.onPress;
  // (an untagged control is named in a report's trail by its label — never by what it holds)
  const label = rest.accessibilityLabel;
  const onPress = press && (uiId || label) ? (e: GestureResponderEvent) => {
    if (uiId) uiHit(uiId, 'touch');
    else trail('tap', {r: 'button', l: String(label).slice(0, 40)}); // [report trail]
    press(e);
  } : press;
  return (
    <Pressable
      android_ripple={{color: rippleColor || 'rgba(255,255,255,0.16)', borderless: !!borderless, foreground: true}}
      hitSlop={6}
      {...rest}
      onPress={onPress}
      style={({pressed}) => [style, pressed && !flat ? {transform: [{scale: 0.97}]} : null]}>
      {children}
    </Pressable>
  );
}
