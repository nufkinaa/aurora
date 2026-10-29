// The website's phone buttons (glass.css): the white pill (the one thing to
// do), the glass pill beside it, the round glass actions with their word
// underneath (a title page's row), the round glass icon (the top bar).
import React from 'react';
import {ActivityIndicator, StyleSheet, Text, View, ViewStyle, StyleProp} from 'react-native';
import Tap from './Tap';
import Icon, {PhoneIconName} from './Icon';
import {colors, G_EDGE, G_FILL, radius} from '../theme';

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
  /** [analytics] the control's id (Tap.uiId) */
  uiId?: string;
  /** .btn.small: 40 tall, 14.4/700 */
  small?: boolean;
  /** a glyph before the words (the site's 🎲) */
  emoji?: string;
};

export function PrimaryButton({label, icon, onPress, onLongPress, busy, disabled, style, leading, testID, uiId}: Base) {
  return (
    <Tap
      uiId={uiId}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled || busy}
      rippleColor="rgba(0,0,0,0.12)"
      style={[s.primary, disabled && s.disabled, style]}>
      {leading}
      {busy ? <ActivityIndicator color={colors.bg} size="small" /> : icon ? <Icon name={icon} size={20} color="#0b0c14" /> : null}
      <Text style={s.primaryText} numberOfLines={1}>
        {label}
      </Text>
    </Tap>
  );
}

export function GlassButton({label, icon, onPress, onLongPress, busy, disabled, style, testID, uiId, small, emoji}: Base) {
  return (
    <Tap
      uiId={uiId}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled || busy}
      style={[s.glass, small && s.glassSmall, disabled && s.disabled, style]}>
      {busy ? <ActivityIndicator color={colors.text} size="small" /> : icon ? <Icon name={icon} size={small ? 17 : 20} color={colors.text} /> : null}
      {emoji ? <Text style={s.emoji}>{emoji}</Text> : null}
      <Text style={[s.glassText, small && s.glassTextSmall]} numberOfLines={1}>
        {label}
      </Text>
    </Tap>
  );
}

/** A glass chip (.chip, .season-pill, .cat-pill with `big`): "Unwatched", "Season 1", "All". */
export function ChipButton({label, icon, onPress, active, style, disabled, uiId, big, small}: Base & {active?: boolean; big?: boolean; small?: boolean}) {
  return (
    <Tap
      uiId={uiId}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{selected: !!active}}
      onPress={onPress}
      disabled={disabled}
      style={[s.chip, big && s.chipBig, active && s.chipOn, disabled && s.disabled, style]}>
      {icon ? <Icon name={icon} size={16} color={colors.text} /> : null}
      <Text style={[s.chipText, big && s.chipTextBig, small && s.chipTextSmall, active && s.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Tap>
  );
}

/** The site's .picker-btn: "Genre  All ▾" — what it picks in the faint grey, the choice, a caret. */
export function PickerChip({label, value, onPress, uiId}: {label: string; value: string; onPress?: () => void; uiId?: string}) {
  return (
    <Tap uiId={uiId} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`} onPress={onPress} style={[s.chip, {gap: 8}]}>
      <Text style={s.pickerLabel}>{label}</Text>
      <Text style={s.chipText} numberOfLines={1}>
        {value}
      </Text>
      <Text style={s.pickerCaret}>▾</Text>
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
  uiId,
}: Base & {on?: boolean; tint?: string}) {
  return (
    <Tap
      uiId={uiId}
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
          <Icon name={icon} size={22} color={tint || colors.text} />
        ) : null}
      </View>
      {/* (the largest font sizes: the word grows a little, never broken in two inside a 76 dp column) */}
      <Text style={s.actionText} numberOfLines={2} maxFontSizeMultiplier={1.15} textBreakStrategy="simple" android_hyphenationFrequency="none">
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
  size = 42,
  style,
  badge,
  children,
  uiId,
}: {
  uiId?: string;
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
      uiId={uiId}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      borderless
      style={[s.iconCircle, {width: size, height: size, borderRadius: size / 2}, style]}>
      {children || (icon ? <Icon name={icon} size={Math.round(size * 0.45)} color={colors.text} /> : null)}
      {badge ? <View style={s.badge} /> : null}
    </Tap>
  );
}

const s = StyleSheet.create({
  // .btn.btn-primary (glass.css): 50 tall, a white pill, 26 at the sides, 16/700 words
  primary: {
    height: 50,
    borderRadius: radius.pill,
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 26,
    gap: 10,
    overflow: 'hidden',
  },
  primaryText: {color: '#0b0c14', fontSize: 16, fontWeight: '700', letterSpacing: 0.16},
  // .btn: the glass pill beside it (--g-fill and --g-edge)
  glass: {
    height: 50,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(12,14,30,0.42)',
    experimental_backgroundImage: G_FILL,
    ...G_EDGE,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 26,
    gap: 10,
    overflow: 'hidden',
  },
  glassText: {color: colors.text, fontSize: 16, fontWeight: '700', letterSpacing: 0.16},
  glassSmall: {height: 39.6, paddingHorizontal: 20},
  glassTextSmall: {fontSize: 14.4, letterSpacing: 0.14},
  emoji: {fontSize: 14.4},
  // .chip / .season-pill: 40 tall, a faint fill and a hairline ring; lit: a brighter fill
  chip: {
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.chip,
    borderWidth: 1,
    borderColor: colors.chipEdge,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 6,
    overflow: 'hidden',
  },
  chipOn: {backgroundColor: colors.chipOn, borderColor: 'rgba(255,255,255,0.08)', borderTopColor: 'rgba(255,255,255,0.35)'},
  chipText: {color: 'rgba(243,244,248,0.82)', fontSize: 13.6, fontWeight: '700'},
  chipTextOn: {color: '#ffffff'},
  chipBig: {height: 40.8},
  chipTextBig: {fontSize: 15.2, fontWeight: '800'},
  chipTextSmall: {fontSize: 12.16},
  pickerLabel: {color: colors.textFaint, fontSize: 13.6, fontWeight: '600'},
  pickerCaret: {color: colors.textFaint, fontSize: 11.2, fontWeight: '700'},
  disabled: {opacity: 0.45},
  // .detail-actions-more .btn: 76 wide, the icon in a 52 disc, its word 8 under it
  action: {width: 76, alignItems: 'center', gap: 8},
  actionDisc: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionDiscOn: {backgroundColor: colors.accentStrong, borderColor: colors.accentStrong},
  actionText: {color: 'rgba(243,244,248,0.8)', fontSize: 11.2, fontWeight: '600', textAlign: 'center', lineHeight: 13.44, letterSpacing: 0.11},
  // .nav-gear / .nav-profile / .nav-logo: round glass over the page
  iconCircle: {
    backgroundColor: 'rgba(96,84,230,0.22)',
    experimental_backgroundImage: G_FILL,
    ...G_EDGE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#3ddc84',
    borderWidth: 1.5,
    borderColor: '#0b0c14',
  },
});
