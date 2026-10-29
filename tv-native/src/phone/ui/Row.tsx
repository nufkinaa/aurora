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
          <Icon name={icon} size={22} color={danger ? colors.danger : colors.text} />
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
      {chevron ? <Icon name="chevronRight" size={22} color={colors.textDim} /> : null}
    </Tap>
  );
}

const s = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: GUTTER + 4, paddingVertical: 10, gap: 14},
  iconBox: {width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center'},
  title: {color: colors.text, fontSize: 16, fontWeight: '700'},
  detail: {color: colors.textDim, fontSize: 14, marginTop: 2, lineHeight: 19},
});
