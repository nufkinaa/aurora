// `.picker-btn` and the `.dropdown` it opens (screens.css:440-465, :486-523;
// browse.js:215-253). One component, because the site's two are never apart.
//
// The site parents the panel to <body> and positions it against the button's
// rect. Here it is a child of the button's own wrapper, anchored above or below
// it — see `show()`. The one cost of not parenting to the root is that the band
// the picker sits in has to out-stack whatever follows it (`zIndex`).
import React, {useEffect, useRef, useState} from 'react';
import {View, Text, ScrollView, StyleSheet, TVFocusGuideView, BackHandler} from 'react-native';
import Focusable from './Focusable';
import {useKeyTrap} from '../focus';
import theme, {useTvMetrics} from '../theme';

const {colors, radius} = theme;

export type Option = {label: string; value: string};

export default function Picker({
  label,
  value,
  options,
  edgeLeft,
  onPick,
  onOpenChange,
  onFocusChange,
  ref,
}: {
  label: string;
  value: string;
  options: Option[];
  edgeLeft?: boolean;
  onPick: (value: string) => void;
  // The nav rail has to stop answering LEFT while the panel is up (§5.8(a)).
  onOpenChange?: (open: boolean) => void;
  // The BUTTON gaining/losing focus (not the panel) — Browse reads it to know
  // focus is back in the filter bands and re-expands its collapsed header.
  onFocusChange?: (focused: boolean) => void;
  ref?: React.Ref<unknown>;
}) {
  const {height} = useTvMetrics();
  const [open, setOpen] = useState(false);
  const current = options.find(o => o.value === value);

  // WHERE THE PANEL GOES. `top: 100%` alone put it off the bottom of the screen
  // whenever the picker sat low — measured on the Streamer: Browse's Genre button
  // is at 275dp, so a 324dp panel ran to 599 on a 540dp panel and its lower half
  // was unreachable. The site solves this by measuring the anchor and opening
  // upwards when there is no room below (`browse.js:243-248`), clamped either
  // way; this is that, with the space also capping maxHeight.
  const wrap = useRef<View>(null);
  const [place, setPlace] = useState({up: false, max: 0});
  const cap = Math.round(height * 0.6);
  const show = () => {
    const node = wrap.current;
    if (!node?.measureInWindow) {
      setPlace({up: false, max: cap});
      setOpen(true);
      return;
    }
    node.measureInWindow((_x, y, _w, h) => {
      const below = height - (y + h) - 14;
      const above = y - 14;
      const up = above > below;
      setPlace({up, max: Math.min(cap, Math.max(96, up ? above : below))});
      setOpen(true);
    });
  };

  // Deafens every key handler outside the panel AND hands focus back to this
  // button on close — measured, Android otherwise picked "Surprise me" in the
  // opposite corner.
  useKeyTrap(open);
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [open]);

  return (
    <View ref={wrap} collapsable={false}>
      <Focusable
        round
        ref={ref as never}
        edgeLeft={edgeLeft}
        onFocusChange={onFocusChange}
        onPress={show}
        style={styles.btn}>
        {/* The 1dp edge as an absolute child, not a border on the Focusable: a
            border there eats the 3dp the ring is drawn inside. */}
        <View style={[styles.edge, !!value && styles.edgeSet]} pointerEvents="none" />
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>{current ? current.label : 'All'}</Text>
        <Text style={styles.caret}>▾</Text>
      </Focusable>

      {open ? (
        <TVFocusGuideView
          trapFocusUp
          trapFocusDown
          trapFocusLeft
          trapFocusRight
          // 0.6 x H is the ceiling (RULE C — the `340px` term is an
          // authoring-width constant that does not port); the room actually
          // available above or below the anchor is what decides.
          style={[
            styles.panel,
            place.up ? styles.panelUp : styles.panelDown,
            {maxHeight: place.max},
          ]}>
          <ScrollView>
            {options.map((o, i) => (
              <Focusable
                key={o.value || ' '}
                noScale
                ringWidth={2}
                ringColor={colors.white}
                highlightColor={colors.surfaceHover}
                // The current value, or — if the picked value is no longer in
                // the option list (a server-side genre list change) — the first
                // row. Without a claim the panel opened with the key trap up
                // and nothing focused inside it: a fully dead remote.
                hasTVPreferredFocus={
                  o.value === value || (i === 0 && !options.some(x => x.value === value))
                }
                onPress={() => {
                  setOpen(false);
                  // Re-picking what is already set must not reset the grid
                  // (browse.js:228).
                  if (o.value !== value) onPick(o.value);
                }}
                style={styles.item}>
                <Text style={[styles.itemText, o.value === value && styles.itemTextOn]}>
                  {o.label}
                </Text>
              </Focusable>
            ))}
          </ScrollView>
        </TVFocusGuideView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // 8/16 at radius 999 over --surface, natural height 40 -> the 48dp floor.
  // `align-items: baseline` (screens.css:443) sits the label, the value and the
  // caret on one baseline rather than centring three different type sizes.
  btn: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    minHeight: 48,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  edge: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.pill,
  },
  // `.picker-btn.set` — a brighter edge once the filter is actually set, so an
  // active filter reads without having to read its value.
  edgeSet: {borderColor: 'rgba(255,255,255,0.35)'},
  // All three at 16: --text-faint is 3.53:1 on --bg and P14 forbids it smaller.
  label: {color: colors.textFaint, fontSize: 16, fontWeight: '600'},
  value: {color: colors.text, fontSize: 16, fontWeight: '700'},
  caret: {color: colors.textFaint, fontSize: 16, fontWeight: '700'},
  panel: {
    position: 'absolute',
    left: 0,
    minWidth: 200,
    padding: 6,
    borderRadius: 14,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.line,
    boxShadow: '0 22px 60px rgba(0,0,0,0.6)',
    zIndex: 291,
  },
  panelDown: {top: '100%', marginTop: 6},
  panelUp: {bottom: '100%', marginBottom: 6},
  // 9/12 natural is 39.6; the site has no explicit height and the floor decides.
  item: {height: 48, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 9},
  itemText: {color: colors.textDim, fontSize: 16, fontWeight: '600'},
  itemTextOn: {color: colors.text, fontWeight: '800'},
});
