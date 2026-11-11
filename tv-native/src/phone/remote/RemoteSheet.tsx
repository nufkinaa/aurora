// The remote's sheets — the website's .rm-sheet (screens/remote.js `sheet`): a small capital title,
// rows 56 tall with an icon tile, a second line and a tick on the one in use, an optional foot
// (the subtitle timing), and Close. Over the app's own bottom sheet (ui/Sheet.tsx: Back and a tap
// outside close it, it rides above the keyboard).
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Sheet from '../ui/Sheet';
import Tap from '../ui/Tap';
import {phoneNative} from '../native';
import RemoteIcon, {RemoteIconName} from './RemoteIcon';
import {RM} from './rmLook';
import {colors} from '../theme';

export type RmRow = {key: string; label: string; sub?: string | null; on?: boolean; icon?: RemoteIconName; uiId?: string; onPress: () => void};

export default function RemoteSheet({visible, title, rows, foot, closeLabel = 'Close', onClose, children}: {
  visible: boolean;
  title: string;
  rows?: RmRow[];
  foot?: React.ReactNode;
  closeLabel?: string;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Sheet visible={visible} onClose={onClose}>
      <Text style={s.title} accessibilityRole="header">
        {title.toUpperCase()}
      </Text>
      {children}
      {(rows || []).map(r => (
        <Tap
          key={r.key}
          flat
          uiId={r.uiId || 'remote.sheet.pick'}
          accessibilityRole="menuitem"
          accessibilityState={{checked: !!r.on}}
          accessibilityLabel={r.sub ? `${r.label}, ${r.sub}` : r.label}
          onPress={() => {
            phoneNative.haptic('tick');
            r.onPress();
          }}
          style={[s.row, r.on && s.rowOn]}>
          {r.icon ? (
            <View style={s.ico}>
              <RemoteIcon name={r.icon} size={20} color="#b3a9ff" />
            </View>
          ) : null}
          <View style={s.text}>
            <Text style={s.name} numberOfLines={1}>
              {r.label}
            </Text>
            {r.sub ? (
              <Text style={s.sub} numberOfLines={1}>
                {r.sub}
              </Text>
            ) : null}
          </View>
          {r.on ? <RemoteIcon name="check" size={18} color={RM.accent} /> : null}
        </Tap>
      ))}
      {foot}
      <Tap flat accessibilityRole="button" accessibilityLabel={closeLabel} onPress={onClose} style={[s.row, s.cancel]}>
        <Text style={s.cancelText}>{closeLabel}</Text>
      </Tap>
    </Sheet>
  );
}

const s = StyleSheet.create({
  title: {color: colors.textDim, fontSize: 12.5, fontWeight: '800', letterSpacing: 1.5, paddingHorizontal: 22, paddingTop: 2, paddingBottom: 8},
  row: {minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 12, marginHorizontal: 12, borderRadius: 16},
  rowOn: {backgroundColor: 'rgba(139,123,255,0.18)'},
  ico: {width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)'},
  text: {flex: 1, minWidth: 0},
  name: {color: colors.text, fontSize: 16, fontWeight: '600'},
  sub: {color: colors.textDim, fontSize: 12.8, fontWeight: '600', marginTop: 1},
  cancel: {justifyContent: 'center', marginTop: 6},
  cancelText: {color: colors.textDim, fontSize: 16, fontWeight: '600'},
});
