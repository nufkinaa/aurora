// The website's phone buttons (glass.css): the white pill (the one thing to
// do), the glass pill beside it, the round glass actions with their word
// underneath (a title page's row), the round glass icon (the top bar).
import React from 'react';
import {ActivityIndicator, StyleSheet, Text, View, ViewStyle, StyleProp} from 'react-native';
import Tap from './Tap';
import Icon, {PhoneIconName} from './Icon';
import {colors, font, radius} from '../theme';

type Base = {
  label: string;
  icon?: PhoneIconName;
  onPress?: () => void;
  onLongPress?: () => void;
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** a picture on the button's left (Continue's episode still) */
  leading?: React.ReactNode;
  testID?: string;
};

export function PrimaryButton({label, icon, onPress, onLongPress, busy, disabled, style, leading, testID}: Base) {
  return (
    <Tap
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled || busy}
      rippleColor="rgba(0,0,0,0.12)"
      style={[s.primary, disabled && s.disabled, style]}>
      {leading}
      {busy ? <ActivityIndicator color={colors.bg} size="small" /> : icon ? <Icon name={icon} size={22} color="#0b0c14" /> : null}
      <Text style={s.primaryText} numberOfLines={1}>
        {label}
      </Text>
    </Tap>
  );
}

export function GlassButton({label, icon, onPress, onLongPress, busy, disabled, style, testID}: Base) {
  return (
    <Tap
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled || busy}
      style={[s.glass, disabled && s.disabled, style]}>
      {busy ? <ActivityIndicator color={colors.text} size="small" /> : icon ? <Icon name={icon} size={20} color={colors.text} /> : null}
      <Text style={s.glassText} numberOfLines={1}>
        {label}
      </Text>
    </Tap>
  );
}

/** A small glass chip-button ("Save season offline (3)", "Mark season watched"). */
export function ChipButton({label, icon, onPress, active, style, disabled}: Base & {active?: boolean}) {
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{selected: !!active}}
      onPress={onPress}
      disabled={disabled}
      style={[s.chip, active && s.chipOn, disabled && s.disabled, style]}>
      {icon ? <Icon name={icon} size={16} color={active ? colors.bg : colors.text} /> : null}
      <Text style={[s.chipText, active && s.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Tap>
  );
}

/** Round glass action with its word underneath (a title page's action row). */
export function ActionCircle({
  label,
  icon,
  onPress,
  onLongPress,
  on,
  busy,
  tint,
  testID,
}: Base & {on?: boolean; tint?: string}) {
  return (
    <Tap
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{selected: !!on}}
      onPress={onPress}
      onLongPress={onLongPress}
      flat
      style={s.action}>
      <View style={[s.actionDisc, on && s.actionDiscOn]}>
        {busy ? (
          <ActivityIndicator color={colors.text} size="small" />
        ) : icon ? (
          <Icon name={icon} size={24} color={tint || (on ? colors.bg : colors.text)} />
        ) : null}
      </View>
      <Text style={s.actionText} numberOfLines={2}>
        {label}
      </Text>
    </Tap>
  );
}

/** A round glass icon button (the top bar's settings / profile, the player's corners). */
export function IconCircle({
  icon,
  label,
  onPress,
  size = 46,
  style,
  badge,
  children,
}: {
  icon?: PhoneIconName;
  label: string;
  onPress?: () => void;
  size?: number;
  style?: StyleProp<ViewStyle>;
  badge?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      borderless
      style={[s.iconCircle, {width: size, height: size, borderRadius: size / 2}, style]}>
      {children || (icon ? <Icon name={icon} size={Math.round(size * 0.5)} color={colors.text} /> : null)}
      {badge ? <View style={s.badge} /> : null}
    </Tap>
  );
}

const s = StyleSheet.create({
  primary: {
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 26,
    gap: 10,
    overflow: 'hidden',
  },
  primaryText: {color: '#0b0c14', fontSize: 17, fontWeight: '800'},
  glass: {
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(12,14,30,0.55)',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.glassEdge,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 10,
    overflow: 'hidden',
  },
  glassText: {color: colors.text, fontSize: 17, fontWeight: '700'},
  chip: {
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.glass,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.glassEdge,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 6,
    overflow: 'hidden',
  },
  chipOn: {backgroundColor: '#ffffff', borderColor: '#ffffff'},
  chipText: {color: colors.text, fontSize: font.small, fontWeight: '700'},
  chipTextOn: {color: colors.bg},
  disabled: {opacity: 0.45},
  action: {width: 72, alignItems: 'center', gap: 8},
  actionDisc: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.glass,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.glassEdge,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionDiscOn: {backgroundColor: '#ffffff', borderColor: '#ffffff'},
  actionText: {color: colors.text, fontSize: 13, fontWeight: '600', textAlign: 'center', lineHeight: 16},
  iconCircle: {
    backgroundColor: 'rgba(12,14,30,0.5)',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.glassEdge,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#3ddc84',
    borderWidth: 1.5,
    borderColor: '#0b0c14',
  },
});
