// A row in a sheet or a settings list: icon, title, detail, and what is on its
// right (a chevron, a value, a switch). The whole row is the touch target.
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Tap from './Tap';
import Icon, {PhoneIconName} from './Icon';
import {colors, GUTTER} from '../theme';

export default function ListRow({
  icon,
  title,
  detail,
  right,
  onPress,
  danger,
  chevron,
  disabled,
  testID,
  uiId,
}: {
  uiId?: string;
  icon?: PhoneIconName;
  title: string;
  detail?: string | null;
  right?: React.ReactNode;
  onPress?: () => void;
  danger?: boolean;
  chevron?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Tap
      uiId={uiId}
      testID={testID}
      flat
      disabled={disabled || !onPress}
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={detail ? `${title}, ${detail}` : title}
      style={[s.row, disabled && {opacity: 0.45}]}>
      {icon ? (
        <View style={s.iconBox}>
          <Icon name={icon} size={18} color={danger ? colors.danger : colors.text} />
        </View>
      ) : null}
      <View style={{flex: 1}}>
        <Text style={[s.title, danger && {color: colors.danger}]} numberOfLines={2}>
          {title}
        </Text>
        {detail ? (
          <Text style={s.detail} numberOfLines={3}>
            {detail}
          </Text>
        ) : null}
      </View>
      {right}
      {chevron ? <Text style={s.chev}>›</Text> : null}
    </Tap>
  );
}

const s = StyleSheet.create({
  // .pref-item: 14 above and below, a 34 dp icon tile, 12 apart; the label 16/700, the note 13.6
  row: {flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: GUTTER + 4, paddingVertical: 14, gap: 12},
  iconBox: {width: 34, height: 34, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center'},
  title: {color: colors.text, fontSize: 16, fontWeight: '700', lineHeight: 24},
  detail: {color: colors.textDim, fontSize: 13.6, marginTop: 3, lineHeight: 19.7},
  chev: {color: colors.textFaint, fontSize: 24, lineHeight: 24, paddingRight: 4},
});
