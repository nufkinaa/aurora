// Settings → the developer's rendering switches (hidden: hold OK on the "Aurora TV x.y.z"
// row). Each switch of renderRules.ts cycles Server → On → Off: "Server" follows what
// the server's `tvRender` says for this TV (GET /api/tv/tuning), On / Off override it
// on this box. Nothing changes until the app is opened again — the switches are read
// once at startup (AuroraRender.kt) — so every row also says what the NEXT launch runs
// with. docs/qa/native-port/DEVICE-PLAN.md has what each one is and how it was measured.
import React, {useState} from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Focusable from './Focusable';
import {activeRender, localRender, nextRender, renderSource, serverRender, setLocalRender} from '../render';
import {cycleTri, inertBecause, KEYS, RenderKey, RenderSay, resolveRender, triOf} from '../renderRules';
import theme from '../theme';

const {colors, fontSize, spacing, radius} = theme;

const WHAT: Record<RenderKey | 'recommended', string> = {
  recommended: 'The set measured best in the lab: all five components, cardlayer, cull, shadowcache, unstuff, pool.',
  focusable: 'Native focus ring and spring.',
  card: 'Native card pictures, shades and blur-up.',
  row: 'Native shelf slide.',
  hero: 'Native billboard art and Home column slide.',
  rail: 'Native nav-rail drawing and slide.',
  cardlayer: 'A resting card is one hardware layer.',
  cull: 'Off-screen shelves and cards are not drawn.',
  shadowcache: 'Box-shadows are blurred once.',
  unstuff: 'Holds one vsync back when the pipeline runs a frame behind.',
  unstuffq: 'The same for one queued buffer (latency over a repeated frame).',
  pool: 'Shelf cards are handed on instead of unmounted.',
  keyrate: 'A held arrow key moves focus at a steady 15 a second, once per frame at most, and stops the moment it is let go.',
  cardtext: 'A card draws its words, tags and progress bar in its own native view (needs card).',
  ringshare: 'One focus ring per screen moves to the focused element (needs focusable).',
  herotext: "Home's billboard words are drawn by one native view.",
};

const label = (say: RenderSay, k: RenderKey | 'recommended') => {
  const t = triOf(say, k);
  return t === 'server' ? 'Server' : t === 'on' ? 'On' : 'Off';
};

export default function RenderDevPanel() {
  const [local, setLocal] = useState<RenderSay>(() => localRender());
  const server = serverRender();
  const next = nextRender();
  const now = activeRender();
  const nextOn = next.qa ? next.on : resolveRender(server, local);
  const change = (k: RenderKey | 'recommended') => {
    const n = cycleTri(local, k);
    setLocal(n);
    setLocalRender(n);
  };
  const list = (s: Set<RenderKey>) => KEYS.filter(k => s.has(k)).join(', ') || 'none';
  const rows: (RenderKey | 'recommended')[] = ['recommended', ...KEYS];
  return (
    <View>
      <Text style={styles.h2}>Rendering (developer)</Text>
      <Text style={styles.intro}>
        {`Now: ${list(now)} (${renderSource}). Next launch: ${list(nextOn)}.` +
          (next.qa ? ' A QA override decides the next launch.' : ' Changes apply when Aurora is opened again.')}
      </Text>
      <View style={styles.list}>
        {rows.map(k => {
          const inert = k === 'recommended' ? null : inertBecause(nextOn, k);
          const sv = server[k];
          const note =
            WHAT[k] +
            (sv == null ? '' : ` Server: ${sv ? 'on' : 'off'}.`) +
            (k === 'recommended' ? '' : ` Next launch: ${nextOn.has(k) ? 'on' : 'off'}${inert ? ` (${inert})` : ''}.`);
          return (
            <Focusable key={k} scaleTo={1.01} edgeLeft onPress={() => change(k)} style={styles.row} highlightColor={colors.surfaceHover}>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>{k}</Text>
                <Text style={styles.rowNote}>{note}</Text>
              </View>
              <Text style={styles.rowValue}>{label(local, k)}</Text>
            </Focusable>
          );
        })}
      </View>
    </View>
  );
}

// Settings.tsx's own row and heading look.
const styles = StyleSheet.create({
  h2: {color: colors.text, fontSize: fontSize.row, fontWeight: '800', marginTop: spacing.xl, marginBottom: spacing.xs},
  intro: {color: colors.textDim, fontSize: fontSize.small, marginBottom: spacing.md, maxWidth: 720},
  list: {gap: spacing.sm},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
  },
  rowText: {flex: 1},
  rowLabel: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  rowNote: {color: colors.textFaint, fontSize: fontSize.small, marginTop: 2},
  rowValue: {color: colors.accent, fontSize: fontSize.body, fontWeight: '800'},
});
