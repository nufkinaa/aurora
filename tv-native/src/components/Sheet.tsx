// The app-wide sheet: a glass card over a darkened page, focus trapped
// inside, Back closes. Every overlay in Overlays.tsx is one of these, so they
// all behave the same from the sofa.
import React, {useEffect} from 'react';
import {BackHandler, StyleSheet, Text, TVFocusGuideView, View} from 'react-native';
import {useKeyTrap} from '../focus';
import theme from '../theme';

const {colors, fontSize, spacing} = theme;

export default function Sheet({
  title,
  kicker,
  width = 560,
  accent,
  onClose,
  children,
}: {
  title?: string;
  kicker?: string;
  width?: number | `${number}%`;
  // A louder card: the accent colour on its edge and a deeper backdrop — for
  // the one sheet that must not be missed (the update offer).
  accent?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useKeyTrap(true);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);
  return (
    <View style={[styles.backdrop, accent && styles.backdropDeep]}>
      <TVFocusGuideView
        autoFocus
        trapFocusUp
        trapFocusDown
        trapFocusLeft
        trapFocusRight
        style={[styles.card, {width}, accent && styles.cardAccent]}>
        {kicker ? <Text style={styles.kicker}>{kicker}</Text> : null}
        {title ? <Text style={styles.title}>{title}</Text> : null}
        {children}
      </TVFocusGuideView>
    </View>
  );
}

// The glass surface, shared with the player's panels and the toasts.
export const glass = {
  backgroundColor: 'rgba(19,21,34,0.97)',
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.10)',
  // The top edge catches the light: the one glass cue that costs nothing.
  borderTopColor: 'rgba(255,255,255,0.22)',
  boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
} as const;

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 500,
    elevation: 500,
    backgroundColor: 'rgba(5,6,12,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.pageX,
  },
  card: {
    ...glass,
    borderRadius: 22,
    padding: spacing.xl,
    maxWidth: '92%',
    maxHeight: '92%',
  },
  backdropDeep: {backgroundColor: 'rgba(5,6,12,0.86)'},
  cardAccent: {
    borderColor: 'rgba(139,123,255,0.55)',
    borderTopColor: 'rgba(199,191,255,0.8)',
    boxShadow: '0 0 0 1px rgba(139,123,255,0.25), 0 30px 90px rgba(0,0,0,0.7), 0 0 60px rgba(108,88,255,0.35)',
  },
  kicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 3, marginBottom: 4},
  title: {color: colors.text, fontSize: fontSize.title, fontWeight: '900', marginBottom: spacing.sm},
});
