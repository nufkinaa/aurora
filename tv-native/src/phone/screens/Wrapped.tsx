// "Your Aurora Wrapped" on the phone — the website's #/wrapped (public/js/screens/wrapped.js):
// your viewing, aggregated and lovingly roasted, honest about its window ("since <date>":
// the server's session store is a ring buffer). The same cards and the same lines, one
// under the other (two side by side on a wide screen). Nothing watched yet: the cards with
// sample numbers, dimmed, and the note that says why — the site's preview, not a dead end.
// Words and rules: ../wrappedWords.ts. Server: GET /api/profiles/:id/wrapped.
import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {StackActions} from '@react-navigation/native';
import {apiRequest} from '../../api';
import {useApp} from '../../AppContext';
import {useMe} from '../../navSection';
import {navRef} from '../../rootNav';
import {BackBar, useColumn, usePageTop, useSolidBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import Glass from '../ui/Glass';
import {GlassButton, PrimaryButton} from '../ui/Buttons';
import {setTab} from '../tabs';
import {BigCard, PREVIEW_CARDS, roastsFor, sinceLine, WrappedReply, wrappedCards} from '../wrappedWords';
import {colors, GUTTER} from '../theme';

// "Back to browsing" / "Find something to watch": the site goes to #/ — Home
const toHome = () => {
  if (navRef.isReady() && navRef.canGoBack()) navRef.dispatch(StackActions.popToTop());
  setTab('home');
};

export default function Wrapped() {
  const bar = useSolidBar();
  const top = usePageTop();
  const column = useColumn();
  const bottom = useTabBarSpace();
  const {width} = useWindowDimensions();
  const {profileId} = useApp();
  const me = useMe(profileId);
  const name = me?.name || '';
  const [w, setW] = useState<WrappedReply | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(() => {
    setErr(false);
    setW(null);
    apiRequest<WrappedReply>(`/api/profiles/${encodeURIComponent(profileId)}/wrapped`)
      .then(setW)
      .catch(() => setErr(true));
  }, [profileId]);
  useEffect(load, [load]);

  // the site's grid: columns of at least 240 — one on a phone held upright, two wider
  const two = Math.min(width, 820) - GUTTER * 2 >= 240 * 2 + 12;
  const cards = (list: BigCard[], dim?: boolean) => (
    <View style={[s.grid, dim && s.preview]} importantForAccessibility={dim ? 'no-hide-descendants' : 'auto'}>
      {list.map((c, i) => (
        <Glass key={`${c.label}-${i}`} style={[s.card, two && s.half]}>
          <Text style={s.num} numberOfLines={1} adjustsFontSizeToFit>
            {c.value}
          </Text>
          <Text style={s.label}>{c.label.toUpperCase()}</Text>
          {c.sub ? <Text style={s.cardSub}>{c.sub}</Text> : null}
        </Glass>
      ))}
    </View>
  );

  let body: React.ReactNode;
  if (err) {
    body = (
      <View style={s.empty}>
        <Text style={s.emptyText}>Couldn't load your stats.</Text>
        <GlassButton uiId="phone.wrapped.retry" label="Try again" icon="refresh" onPress={load} style={{marginTop: 14}} />
      </View>
    );
  } else if (!w) {
    body = <ActivityIndicator color={colors.text} style={{marginTop: 30}} />;
  } else if (w.empty) {
    body = (
      <>
        <Text style={s.since}>{sinceLine(name, null)}</Text>
        {cards(PREVIEW_CARDS, true)}
        <View style={s.empty}>
          <Text style={s.glyph}>🌌</Text>
          <Text style={s.emptyText}>Watch something and come back — the numbers fill in by themselves.</Text>
        </View>
        <PrimaryButton uiId="phone.wrapped.browse" label="Find something to watch" onPress={toHome} style={s.cta} />
      </>
    );
  } else {
    body = (
      <>
        <Text style={s.since}>{sinceLine(name, w.since)}</Text>
        {cards(wrappedCards(w))}
        <Text style={s.h2} accessibilityRole="header">
          The intervention section
        </Text>
        <View style={s.roasts}>
          {roastsFor(w, name).map((r, i) => (
            <View key={i} style={s.roast}>
              <Text style={s.roastText}>{r}</Text>
            </View>
          ))}
        </View>
        <PrimaryButton uiId="phone.wrapped.browse" label="Back to browsing" onPress={toHome} style={[s.cta, {alignSelf: 'flex-start'}]} />
      </>
    );
  }

  return (
    <View style={s.root}>
      <ScrollView
        onScroll={bar.onScroll}
        scrollEventThrottle={32}
        contentContainerStyle={[{paddingTop: top, paddingBottom: bottom + 24, paddingHorizontal: GUTTER}, column]}>
        <Text style={s.h1} accessibilityRole="header">
          Aurora Wrapped
        </Text>
        {body}
      </ScrollView>
      <BackBar solid={bar.solid} title={bar.solid ? 'Aurora Wrapped' : undefined} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  // .wrapped-title / .wrapped-since
  h1: {color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: -0.72, lineHeight: 36},
  since: {color: colors.textFaint, fontSize: 16, fontWeight: '600', lineHeight: 23, marginTop: 4, marginBottom: 22},
  // .wrapped-grid: 14 apart
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 14},
  preview: {opacity: 0.45},
  // .wrapped-card: 22 inside
  card: {width: '100%', padding: 22},
  half: {width: '48%', flexGrow: 1},
  // .wrapped-num: 2.2rem/900 (the site draws it in the violet-to-blue of the accent)
  num: {color: colors.accent, fontSize: 35, fontWeight: '900', lineHeight: 42},
  // .wrapped-label: upper case, 0.78rem/800, spaced
  label: {color: colors.textDim, fontSize: 12.5, fontWeight: '800', letterSpacing: 1, marginTop: 4},
  cardSub: {color: colors.textFaint, fontSize: 13.6, marginTop: 8, lineHeight: 19},
  h2: {color: colors.text, fontSize: 17.6, fontWeight: '800', marginTop: 26},
  // .wrapped-roast: an accent edge on the left, 14 x 16 inside, 0.95rem on 1.5
  roasts: {gap: 10, marginTop: 12},
  roast: {
    backgroundColor: 'rgba(139,123,255,0.10)',
    borderWidth: 1,
    borderColor: colors.line,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  roastText: {color: colors.text, fontSize: 15.2, lineHeight: 22.8},
  empty: {alignItems: 'center', paddingTop: 18, paddingHorizontal: 12},
  glyph: {fontSize: 40, marginBottom: 8},
  emptyText: {color: colors.textDim, fontSize: 15.68, lineHeight: 22, textAlign: 'center'},
  cta: {alignSelf: 'center', marginTop: 26},
});
