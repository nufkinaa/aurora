// The app-wide sheet: a glass card over a darkened page, focus trapped
// inside, Back closes. Every overlay in Overlays.tsx is one of these, so they
// all behave the same from the sofa.
import React, {useEffect} from 'react';
import {BackHandler, ScrollView, StyleSheet, Text, TVFocusGuideView, View} from 'react-native';
import {useKeyTrap} from '../focus';
import {sheetMaxHeight} from '../popupFit';
import {GLASS_NEW, glassMenu, sheetInk} from '../glass';
import GlassEdge from './GlassEdge';
import {FlatFocus} from './Focusable';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing} = theme;
// the widest focus ring past its button (the violet offset ring of a primary button)
const RING_ROOM = 8;

export default function Sheet({
  title,
  kicker,
  width = 560,
  accent,
  onClose,
  scrollRef,
  footer,
  children,
}: {
  title?: string;
  kicker?: string;
  width?: number | `${number}%`;
  // A louder card: the accent colour on its edge and a deeper backdrop — for
  // the one sheet that must not be missed (the update offer).
  accent?: boolean;
  onClose: () => void;
  // The body's ScrollView, for a sheet that has to bring a row into view
  // itself (ReplaceSheet: the row focus returns to when its list remounts).
  scrollRef?: React.Ref<ScrollView>;
  // Kept in view under the scrolling body (the picker's note and Send / Cancel: with a big
  // household the faces filled the sheet and Send was three presses below its edge).
  footer?: React.ReactNode;
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
  // A ceiling in dp (popupFit.ts) instead of '92%', and the body scrolls
  // under the heading: a long changelog, a long list of actions or a sheet on
  // a 540dp panel keeps its buttons reachable — the focused one is scrolled
  // into view by Android itself.
  const {height} = useTvMetrics();
  return (
    <View style={[styles.backdrop, accent && styles.backdropDeep]}>
      <TVFocusGuideView
        autoFocus
        trapFocusUp
        trapFocusDown
        trapFocusLeft
        trapFocusRight
        style={[styles.card, {width, maxHeight: sheetMaxHeight(height, spacing.pageX)}, accent && styles.cardAccent]}>
        {/* the new look (glass.ts GLASS_NEW.sheets): the glass's edge - its soft shadow and the light
            inside its rim - as pictures; the accent card keeps its own glow */}
        {GLASS_NEW.sheets && !accent ? <GlassEdge radius={22} /> : null}
        {kicker ? <Text style={styles.kicker}>{kicker}</Text> : null}
        {title ? <Text style={styles.title}>{title}</Text> : null}
        {/* FlatFocus, the new look only: on that opaque card a focused button keeps its ring and
            loses the ring's drop shadow, which the body's scroll box cut to a square (Focusable.tsx) */}
        <FlatFocus.Provider value={GLASS_NEW.sheets}>
          <ScrollView ref={scrollRef} style={styles.body} contentContainerStyle={styles.bodyIn} showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </FlatFocus.Provider>
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
// A sheet's surface: that - Aurora's own, as released - or the second look (glass.ts GLASS_NEW.sheets; docs/glass-tv.md) -
// the neutral body, a rim of light, a quiet sheen, and <GlassEdge> for its glow and its shadow.
const surface = GLASS_NEW.sheets ? glassMenu : glass;

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
    ...surface,
    borderRadius: 22,
    padding: spacing.xl,
    maxWidth: '92%',
  },
  // grows with its content up to the card's ceiling, then scrolls
  body: {flexGrow: 0, flexShrink: 1, margin: -RING_ROOM},
  // A ScrollView clips to its own box, and the button at the body's left edge (Play on the
  // hold-OK sheet, Send on the picker) had the left and bottom of its focus ring cut off.
  // The body reaches RING_ROOM past the card's padding on every side and gives it back as
  // padding: the content sits exactly where it did, the rings have room to draw.
  bodyIn: {padding: RING_ROOM},
  // the same ring room as the body, and a hairline where the scrolling part ends
  footer: {marginHorizontal: -RING_ROOM, paddingHorizontal: RING_ROOM, paddingBottom: RING_ROOM - 4, marginBottom: -(RING_ROOM - 4), paddingTop: spacing.md, marginTop: 4, borderTopWidth: 1, borderTopColor: colors.line},
  backdropDeep: {backgroundColor: 'rgba(5,6,12,0.86)'},
  cardAccent: {
    borderColor: 'rgba(139,123,255,0.55)',
    borderTopColor: 'rgba(199,191,255,0.8)',
    boxShadow: '0 0 0 1px rgba(139,123,255,0.25), 0 30px 90px rgba(0,0,0,0.7), 0 0 60px rgba(108,88,255,0.35)',
  },
  // (sheetInk: the page's accent and text, or on the glass body the accent mixed with white and white)
  kicker: {color: sheetInk.on, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 3, marginBottom: 4},
  title: {color: sheetInk.text, fontSize: fontSize.title, fontWeight: '900', marginBottom: spacing.sm},
});
