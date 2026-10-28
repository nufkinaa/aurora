// Every touchable in the phone app: an Android ripple inside the shape, and a
// small press-in so a tap reads even on a picture where the ripple is faint.
import React from 'react';
import {Pressable, PressableProps, StyleProp, ViewStyle} from 'react-native';

type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** the ripple spreads past the box (round icon buttons) */
  borderless?: boolean;
  /** no press-in scale (rows, wide surfaces) */
  flat?: boolean;
  rippleColor?: string;
  children?: React.ReactNode;
};

export default function Tap({style, borderless, flat, rippleColor, children, ...rest}: Props) {
  return (
    <Pressable
      android_ripple={{color: rippleColor || 'rgba(255,255,255,0.16)', borderless: !!borderless, foreground: true}}
      hitSlop={6}
      {...rest}
      style={({pressed}) => [style, pressed && !flat ? {transform: [{scale: 0.97}]} : null]}>
      {children}
    </Pressable>
  );
}
