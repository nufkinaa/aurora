// "New" — what Aurora can do now on this TV, and how, one card per feature;
// the raw changelog from the server underneath. The nav dot goes out once
// this version's page has been opened (storage: newSeen).
import React, {useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Focusable from '../components/Focusable';
import NavRail from '../components/NavRail';
import {openJoinParty, openReport} from '../overlay';
import {api} from '../api';
import {useApp} from '../AppContext';
import {useMe, goSection, markNewSeen} from '../navSection';
import {RootStackParamList} from '../navigation';
import {APP_VERSION} from '../update';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, radius} = theme;

type Feature = {glyph: string; title: string; what: string; how: string; go?: {label: string; act: string}};
const FEATURES: Feature[] = [
  {
    glyph: '🎬',
    title: 'Trailers on the billboard',
    what: 'Let a title sit on the home hero for six seconds and its trailer plays, quietly, then the billboard moves on.',
    how: 'Press Unmute beside Details for sound. Moving down to the shelves ends it. Off under Settings → Home.',
    go: {label: 'Go home', act: 'home'},
  },
  {
    glyph: '👥',
    title: 'Watch together',
    what: 'A few devices, one title, in step. Play, pause and jumps happen for everyone.',
    how: 'In the player press the 👥 button → Start a party and share the four-letter code. Others join from their profile menu; here, Settings → Join a watch party. Up next carries the whole room along.',
    go: {label: 'Join a party', act: 'join'},
  },
  {
    glyph: '⏭',
    title: 'Skip intro, Up next — detected',
    what: 'Aurora listens to every episode and finds the theme and the credits by itself, so the buttons appear at the right moment.',
    how: 'Wrong on a show? Player gear → Ignore the detected intro, or mark it by hand: Mark intro start, then Intro ends here.',
    go: {label: 'Open Shows', act: 'shows'},
  },
  {
    glyph: '💬',
    title: 'Subtitles that find themselves',
    what: 'Pick a language once. A title you own that lacks it gets one fetched and switched on while it starts.',
    how: 'Settings → Subtitles → Preferred subtitle language.',
    go: {label: 'Set a language', act: 'settings'},
  },
  {
    glyph: '👆',
    title: 'Hold a card to peek',
    what: 'Hold OK on any poster and the title opens as a sheet: what it is, how much is left, the synopsis.',
    how: 'Play, Details and My List are right there. Back puts you exactly where you were.',
    go: {label: 'Try it on Movies', act: 'movies'},
  },
  {
    glyph: '▶️',
    title: 'Resume, with the frame',
    what: 'Coming back to a title shows the frame you stopped on, with Start over one press away for six seconds.',
    how: 'Nothing to set up — it appears whenever there is a place to resume.',
  },
  {
    glyph: '⬇',
    title: 'My downloads',
    what: 'Everything you asked the server to fetch, in one place: ready to play, on its way, waiting on an admin.',
    how: 'Settings → My downloads. A finished one plays from there.',
    go: {label: 'My downloads', act: 'downloads'},
  },
  {
    glyph: '🔄',
    title: 'Updates on the TV',
    what: 'When a new version of this app is published, Home offers it and it installs right here — no computer needed.',
    how: 'Settings → This TV shows the version and checks again.',
    go: {label: 'Check now', act: 'settings'},
  },
  {
    glyph: '🛠️',
    title: 'Report a problem',
    what: 'A few words is enough. Where you were, what was playing and the last errors this TV saw come along by themselves.',
    how: 'Settings → Report a problem.',
    go: {label: 'Report something', act: 'report'},
  },
];

export default function WhatsNew({navigation}: NativeStackScreenProps<RootStackParamList, 'WhatsNew'>) {
  const {profileId} = useApp();
  const me = useMe(profileId);
  const {safeBottom} = useTvMetrics();
  const [log, setLog] = useState<{version: string; date: string | null; items: string[]}[] | null>(null);
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .changelog()
      .then(c => {
        if (!live) return;
        setLog(c.releases || []);
        markNewSeen(c.version || APP_VERSION);
      })
      .catch(() => live && markNewSeen(APP_VERSION));
    return () => {
      live = false;
    };
  }, []);

  const act = (a: string) => {
    if (a === 'join') return openJoinParty();
    if (a === 'report') return openReport();
    if (a === 'downloads') return navigation.push('Downloads');
    if (a === 'home' || a === 'movies' || a === 'shows' || a === 'settings') goSection(navigation, 'new', a);
  };

  return (
    <View style={styles.root}>
      <NavRail active="new" />
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, {paddingBottom: safeBottom + spacing.xl}]}>
        <Text style={styles.kicker}>{`AURORA TV ${APP_VERSION}`}</Text>
        <Text style={styles.h1}>New in Aurora</Text>
        <Text style={styles.sub}>{`Hi ${me?.name || 'there'} — here's what this TV can do now, and how.`}</Text>
        <View style={styles.grid}>
          {FEATURES.map((f, i) => (
            <Focusable
              key={f.title}
              scaleTo={1.02}
              lift={2}
              edgeLeft={i % 2 === 0}
              hasTVPreferredFocus={i === 0}
              highlightColor={colors.surfaceHover}
              onPress={() => f.go && act(f.go.act)}
              style={styles.card}>
              <View style={styles.cue}>
                <Text style={styles.glyph}>{f.glyph}</Text>
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.cardTitle}>{f.title}</Text>
                <Text style={styles.what}>{f.what}</Text>
                <Text style={styles.how}>
                  <Text style={styles.howLabel}>How </Text>
                  {f.how}
                </Text>
                {f.go ? <Text style={styles.go}>{`${f.go.label} ›`}</Text> : null}
              </View>
            </Focusable>
          ))}
        </View>

        <Focusable
          round
          edgeLeft
          onPress={() => setShowLog(s => !s)}
          highlightColor={colors.surfaceHover}
          style={styles.logBtn}>
          <Text style={styles.logBtnText}>{showLog ? 'Hide the full changelog' : 'Full changelog'}</Text>
        </Focusable>
        {showLog && log
          ? log.slice(0, 8).map(r => (
              <View key={r.version} style={styles.release}>
                <Text style={styles.relHead}>{`${r.version}${r.date ? ` — ${r.date}` : ''}`}</Text>
                {r.items.map((it, i) => (
                  <Text key={i} style={styles.relItem}>{`•  ${it}`}</Text>
                ))}
              </View>
            ))
          : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  scroll: {flex: 1},
  content: {paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX, paddingTop: 27},
  kicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 3},
  h1: {color: colors.text, fontSize: fontSize.title, fontWeight: '900', marginTop: 4},
  sub: {color: colors.textDim, fontSize: fontSize.body, marginTop: 2, marginBottom: spacing.md},
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 14},
  card: {
    width: '48.5%',
    flexDirection: 'row',
    gap: 14,
    padding: 16,
    borderRadius: radius.l,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderTopColor: 'rgba(255,255,255,0.16)',
  },
  cue: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: 'rgba(139,123,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {fontSize: 26},
  cardBody: {flex: 1, minWidth: 0},
  cardTitle: {color: colors.text, fontSize: fontSize.body, fontWeight: '800'},
  what: {color: colors.textDim, fontSize: 14, lineHeight: 20, marginTop: 4},
  how: {color: colors.textFaint, fontSize: 14, lineHeight: 20, marginTop: 6},
  howLabel: {color: colors.textDim, fontWeight: '800'},
  go: {color: colors.accent, fontSize: 14, fontWeight: '800', marginTop: 8},
  logBtn: {alignSelf: 'flex-start', backgroundColor: colors.surface, paddingVertical: 10, paddingHorizontal: 20, marginTop: spacing.xl},
  logBtnText: {color: colors.text, fontSize: fontSize.small, fontWeight: '700'},
  release: {marginTop: spacing.lg, maxWidth: 820},
  relHead: {color: colors.text, fontSize: fontSize.body, fontWeight: '800', marginBottom: 6},
  relItem: {color: colors.textDim, fontSize: 14, lineHeight: 21, marginBottom: 6},
});
