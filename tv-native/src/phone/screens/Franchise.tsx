// [franchise] FRANCHISE ORDER on the phone — one franchise's titles in order
// (the website's franchise page, the TV's screens/Franchise.tsx; the same
// server answer and the same rules, franchiseRules.ts):
//
//   the heading   the name, the summary under it (none for a kids profile)
//   the order     Release order / Story order when there are both — the other
//                 one is saved for this person on the server, the list comes
//                 back in it
//   the list      number, poster, title, year, Optional / Series, Watched /
//                 Started; a tap opens the title, the button on the right is the
//                 one thing to do: Play, Open, Save & watch, Choose episode
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, FlatList, Image, StyleSheet, Text, View} from 'react-native';
import {useIsFocused, useRoute, RouteProp} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {api, FranchiseEntry, FranchiseOrderId, FranchisePage} from '../../api';
import {useApp} from '../../AppContext';
import {canNavigate} from '../../navLock';
import {showToast} from '../../toast';
import {useRouteShown} from '../../useRouteShown';
import {entryAction, entryArt, entryItem, entryNumber, entryStateWord, entryTags, FR_WORDS, showOrderSwitch} from '../../franchiseRules';
import type {RootStackParamList} from '../../navigation';
import {usePNav} from '../nav';
import {ChipButton, GlassButton, PrimaryButton} from '../ui/Buttons';
import {artSrc} from '../ui/Cards';
import {BackBar, useColumn, useSolidBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import Tap from '../ui/Tap';
import {colors, GUTTER, radius} from '../theme';

const THUMB_W = 56;
const THUMB_H = 84;

const EntryRow = React.memo(function PhoneFranchiseRow({e, onOpen, onAct}: {e: FranchiseEntry; onOpen: (e: FranchiseEntry) => void; onAct: (e: FranchiseEntry) => void}) {
  const art = artSrc(entryArt(e), THUMB_W).src;
  const num = entryNumber(e);
  const tags = entryTags(e);
  const state = entryStateWord(e);
  const act = entryAction(e);
  return (
    <Tap uiId="franchise.entry" flat onPress={() => onOpen(e)} style={s.row} accessibilityRole="button" accessibilityLabel={[num, e.title, e.year, ...tags, state].filter(Boolean).join(', ')}>
      <Text style={[s.num, !num && s.numNone]}>{num || '·'}</Text>
      <View style={s.thumb}>{art ? <Image source={art} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}</View>
      <View style={s.text}>
        <Text style={s.title} numberOfLines={2}>
          {e.title}
          {e.year ? <Text style={s.year}>{`  ${e.year}`}</Text> : null}
        </Text>
        <View style={s.tags}>
          {tags.map(t => (
            <Text key={t} style={s.tag}>
              {t}
            </Text>
          ))}
          {state ? <Text style={[s.state, e.state === 'watched' ? s.watched : s.started]}>{e.state === 'watched' ? `✓ ${state}` : state}</Text> : null}
        </View>
        {e.note ? (
          <Text style={s.note} numberOfLines={2}>
            {e.note}
          </Text>
        ) : null}
      </View>
      {act.kind === 'play' ? (
        <PrimaryButton uiId="franchise.play" icon="play" label={act.label} onPress={() => onAct(e)} style={s.act} />
      ) : (
        <GlassButton uiId={act.kind === 'save' ? 'franchise.save' : 'franchise.entry'} small label={act.label} onPress={() => onAct(e)} style={s.actGlass} />
      )}
    </Tap>
  );
});

export default function Franchise() {
  const route = useRoute<RouteProp<RootStackParamList, 'Franchise'>>();
  const navigation = usePNav();
  const {id, name} = route.params;
  const {profileId} = useApp();
  const bar = useSolidBar();
  const insets = useSafeAreaInsets();
  const bottom = useTabBarSpace();
  const column = useColumn();
  const [page, setPage] = useState<FranchisePage | null>(null);
  const [error, setError] = useState('');
  const [want, setWant] = useState<FranchiseOrderId | null>(null);
  const [reload, setReload] = useState(0);
  const [switching, setSwitching] = useState(false);
  useRouteShown(page !== null || !!error);

  // Read on arrival and again on every return (a film played from here, or a
  // Save & watch on its title page, changes Watched / Started / On the server
  // — the website reads the page afresh each time it is shown). A failed
  // re-read keeps what is on screen; only a page never read shows the failure.
  const isFocused = useIsFocused();
  const have = useRef(false);
  useEffect(() => {
    if (!isFocused) return;
    let live = true;
    setError('');
    api
      .franchise(id, profileId, want)
      .then(p => {
        if (!live) return;
        have.current = true;
        setPage(p);
        setSwitching(false);
      })
      .catch(() => {
        if (!live) return;
        setSwitching(false);
        if (!have.current) setError(FR_WORDS.loadError);
      });
    return () => {
      live = false;
    };
  }, [id, profileId, want, reload, isFocused]);

  const pickOrder = (o: FranchiseOrderId) => {
    if (!page || o === page.order || switching) return;
    setSwitching(true);
    api.franchiseSetOrder(id, profileId, o).catch(() => showToast("Couldn't save that", '⚠'));
    setWant(o);
  };
  const open = useCallback(
    (e: FranchiseEntry) => {
      if (canNavigate(navigation as never)) navigation.push('Detail', {item: entryItem(e)});
    },
    [navigation],
  );
  const act = useCallback(
    (e: FranchiseEntry) => {
      if (!canNavigate(navigation as never)) return;
      const a = entryAction(e);
      if (a.kind === 'play' && e.onServer) navigation.push('Player', {id: e.onServer.id, title: e.title});
      else if (a.kind === 'save') navigation.push('Detail', {item: entryItem(e), save: true});
      else navigation.push('Detail', {item: entryItem(e)});
    },
    [navigation],
  );

  const title = page?.name || name || '';
  const head = (
    <View style={{paddingTop: insets.top + 70}}>
      <Text style={s.h1} accessibilityRole="header">
        {title}
      </Text>
      {page?.summary ? <Text style={s.summary}>{page.summary}</Text> : null}
      {page && showOrderSwitch(page.orders) ? (
        <View style={s.chips}>
          {page.orders.map(o => (
            <ChipButton key={o.id} uiId="franchise.order" label={o.label} active={o.id === page.order} onPress={() => pickOrder(o.id)} />
          ))}
          {switching ? <ActivityIndicator color={colors.textDim} size="small" /> : null}
        </View>
      ) : null}
      {error ? (
        <View style={s.error}>
          <Text style={s.errorText}>{error}</Text>
          <GlassButton small label="Retry" onPress={() => setReload(n => n + 1)} style={{alignSelf: 'flex-start'}} />
        </View>
      ) : null}
      {!page && !error ? <ActivityIndicator color={colors.text} style={{marginTop: 24}} /> : null}
    </View>
  );
  return (
    <View style={s.root}>
      <FlatList
        onScroll={bar.onScroll}
        scrollEventThrottle={32}
        data={page?.entries || []}
        keyExtractor={(e, i) => `${e.imdbId}-${i}`}
        ListHeaderComponent={head}
        style={column || undefined}
        contentContainerStyle={{paddingBottom: bottom + 16}}
        initialNumToRender={10}
        windowSize={7}
        renderItem={({item}) => <EntryRow e={item} onOpen={open} onAct={act} />}
      />
      <BackBar solid={bar.solid} title={bar.solid ? title : undefined} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  h1: {color: colors.text, fontSize: 30, fontWeight: '900', paddingHorizontal: GUTTER},
  summary: {color: colors.textDim, fontSize: 14, marginTop: 4, paddingHorizontal: GUTTER},
  chips: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: GUTTER, paddingVertical: 12, gap: 8},
  error: {paddingHorizontal: GUTTER, paddingVertical: 12, gap: 10},
  errorText: {color: '#ff7a7a', fontSize: 15, fontWeight: '700'},
  row: {flexDirection: 'row', gap: 10, alignItems: 'center', marginHorizontal: GUTTER, marginBottom: 8, padding: 10, borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge},
  num: {width: 26, textAlign: 'center', color: colors.text, fontSize: 17, fontWeight: '900'},
  numNone: {color: colors.textFaint},
  thumb: {width: THUMB_W, height: THUMB_H, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.06)'},
  text: {flex: 1, minWidth: 0, gap: 4},
  title: {color: colors.text, fontSize: 15, fontWeight: '800'},
  year: {color: colors.textDim, fontWeight: '600'},
  tags: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6},
  tag: {color: colors.textDim, fontSize: 11.5, fontWeight: '700', paddingHorizontal: 7, paddingVertical: 1, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.glassEdge},
  state: {fontSize: 12.5, fontWeight: '800'},
  watched: {color: colors.owned},
  started: {color: colors.accent},
  note: {color: colors.textFaint, fontSize: 12},
  act: {minHeight: 40, paddingHorizontal: 14},
  actGlass: {maxWidth: 140},
});
