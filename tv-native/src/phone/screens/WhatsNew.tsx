// "What's new" on the phone — the website's Settings → What's new (preferences.js) and the
// TV's New screen: Aurora's changelog as the server has it (/api/changelog — the one
// CHANGELOG.md, every app's changes), newest first, a few releases at a time with "Show
// older", and the page with every app and its own changes (/install/changes, in the
// browser). The changelog is Markdown: **bold** is drawn bold, `code` plain.
import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Linking, ScrollView, StyleSheet, Text, View} from 'react-native';
import {api, getBaseUrl} from '../../api';
import {BackBar, useColumn, usePageTop, useSolidBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import Glass from '../ui/Glass';
import ListRow from '../ui/Row';
import {GlassButton} from '../ui/Buttons';
import {running} from '../update/store';
import {colors, GUTTER} from '../theme';
import {mdPieces} from '../words';

type Release = {version: string; date: string | null; items: string[]};
const STEP = 5;


export default function WhatsNew() {
  const bar = useSolidBar();
  const top = usePageTop();
  const column = useColumn();
  const bottom = useTabBarSpace();
  const [log, setLog] = useState<Release[] | null>(null);
  const [err, setErr] = useState(false);
  const [shown, setShown] = useState(STEP);
  const load = () => {
    setErr(false);
    api
      .changelog()
      .then(c => setLog(c.releases || []))
      .catch(() => setErr(true));
  };
  useEffect(load, []);
  return (
    <View style={s.root}>
      <ScrollView onScroll={bar.onScroll} scrollEventThrottle={32} contentContainerStyle={[{paddingTop: top, paddingBottom: bottom + 24, paddingHorizontal: GUTTER}, column]}>
        <Text style={s.h1} accessibilityRole="header">
          What's new
        </Text>
        <Text style={s.sub}>{`Aurora for Android ${running().versionName} · the changes to Aurora, newest first`}</Text>
        {err ? (
          <Glass style={s.card}>
            <Text style={s.item}>Couldn't load the changes — check the connection.</Text>
            <GlassButton uiId="phone.whatsnew.retry" label="Try again" icon="refresh" onPress={load} style={{marginTop: 12, alignSelf: 'flex-start'}} />
          </Glass>
        ) : !log ? (
          <ActivityIndicator color={colors.text} style={{marginTop: 30}} />
        ) : (
          <>
            {log.slice(0, shown).map(r => (
              <Glass key={r.version} style={s.card}>
                <Text style={s.rel}>{`${r.version}${r.date ? ` · ${r.date}` : ''}`}</Text>
                {r.items.map((it, i) => (
                  <Text key={i} style={s.item}>
                    {'•  '}
                    {mdPieces(it).map((p, j) => (
                      <Text key={j} style={p.bold ? s.bold : undefined}>
                        {p.text}
                      </Text>
                    ))}
                  </Text>
                ))}
              </Glass>
            ))}
            {log.length > shown ? <GlassButton uiId="phone.whatsnew.older" label="Show older" onPress={() => setShown(n => n + STEP)} style={{alignSelf: 'center', marginVertical: 8}} /> : null}
          </>
        )}
        <Glass style={s.card}>
          <ListRow
            uiId="phone.whatsnew.apps"
            icon="info"
            title="Every Aurora app and its changes"
            detail="The TV app, this phone app and the website, each with its own list — in the browser."
            chevron
            onPress={() => Linking.openURL(`${getBaseUrl() || 'https://nufurora.com'}/install/changes`).catch(() => {})}
          />
        </Glass>
      </ScrollView>
      <BackBar solid={bar.solid} title={bar.solid ? "What's new" : undefined} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  h1: {color: colors.text, fontSize: 24, fontWeight: '900'},
  sub: {color: colors.textDim, fontSize: 15, marginTop: 4, marginBottom: 14, lineHeight: 21},
  card: {padding: 16, marginBottom: 12},
  rel: {color: colors.text, fontSize: 17, fontWeight: '800', marginBottom: 8},
  item: {color: colors.textDim, fontSize: 15, lineHeight: 22, marginTop: 6},
  bold: {color: colors.text, fontWeight: '800'},
});
