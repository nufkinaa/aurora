// Settings → "This TV's name": the names a TV is usually called, under the
// row that opened them. The phone remote lists the TV by this name ("Play on
// Living room TV"); the website's own row says "This device's name". The
// phone can rename the TV too (`rename`) — both land in remote/identity.ts.
//
// A focus trap while it is open (focus.ts useKeyTrap): the rail does not
// answer LEFT under it, and closing it hands focus back to the row.
import React, {useEffect, useState} from 'react';
import {BackHandler, StyleSheet, Text, View} from 'react-native';
import Focusable from '../components/Focusable';
import {useKeyTrap} from '../focus';
import theme from '../theme';
import {onTvName, setTvName, systemName, tvName, TV_NAMES, loadDevice} from './identity';

const {colors, fontSize, radius, spacing} = theme;

/** This TV's name, kept current (Settings shows it on the row). */
export const useTvName = () => {
  const [name, setName] = useState<string | null>(tvName());
  useEffect(() => {
    let live = true;
    loadDevice().then(d => live && setName(d.name));
    const off = onTvName(n => setName(n));
    return () => {
      live = false;
      off();
    };
  }, []);
  return name;
};

export default function TvNamePicker({current, onClose}: {current: string | null; onClose: () => void}) {
  useKeyTrap(true);
  const [sys, setSys] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    systemName().then(n => live && setSys(n));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const s = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => s.remove();
  }, [onClose]);
  // the system's own name first, then the usual ones; a name given from the
  // phone that is none of these stays on the list, ticked
  const names = [...new Set([...(sys ? [sys] : []), ...(current && !TV_NAMES.includes(current) && current !== sys ? [current] : []), ...TV_NAMES])];
  const focusAt = Math.max(0, names.indexOf(current || ''));
  return (
    <View style={styles.list}>
      {names.map((n, i) => (
        <Focusable uiId="settings.tvname.pick"
          key={n}
          scaleTo={1.01}
          edgeLeft
          hasTVPreferredFocus={i === focusAt}
          highlightColor={colors.surfaceHover}
          onPress={() => {
            setTvName(n);
            onClose();
          }}
          style={styles.row}>
          <Text style={[styles.tick, n === current && styles.tickOn]}>{n === current ? '✓' : ''}</Text>
          <Text style={styles.label}>{n}</Text>
          {n === sys ? <Text style={styles.tag}>The TV's own name</Text> : null}
        </Focusable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {gap: 4, marginLeft: spacing.lg},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
  },
  tick: {width: 18, color: colors.textDim, fontSize: fontSize.body, fontWeight: '800'},
  tickOn: {color: colors.accent},
  label: {flex: 1, color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  tag: {color: colors.textFaint, fontSize: fontSize.small},
});
