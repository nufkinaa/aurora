// [household] "Recommended by your household" — the Show all page on the
// phone (the website's #/household, the TV's screens/Household.tsx):
//
//   For you   everything the household recommended to you, in the server's
//             order, each with who it is from; a filter by person
//   You sent  what you recommended, and what became of it for each person
//
// Opening the page counts everything as seen (the row's "2 new" goes).
import React, {useCallback, useEffect, useState} from 'react';
import {FlatList, Image, ScrollView, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useIsFocused, useRoute, RouteProp} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {api, artSrc, HeroItem, HouseholdSentCard} from '../../api';
import {useApp} from '../../AppContext';
import {openItem} from '../../openItem';
import {track} from '../../usage';
import {fromLine, filterOptions, sentLine, WORDS} from '../../householdRecs';
import {householdChanged, noteShown, onHouseholdChanged} from '../../householdLive';
import type {RootStackParamList} from '../../navigation';
import {usePNav} from '../nav';
import {PosterCard} from '../ui/Cards';
import {ChipButton} from '../ui/Buttons';
import {BackBar} from '../ui/PageHead';
import {gridColumns} from '../ui/Grid';
import {useTabBarSpace} from '../ui/TabBar';
import Tap from '../ui/Tap';
import {colors, GUTTER, radius} from '../theme';

type Tab = 'forYou' | 'sent';

export default function Household() {
  const route = useRoute<RouteProp<RootStackParamList, 'Household'>>();
  const navigation = usePNav();
  const {profileId} = useApp();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const bottom = useTabBarSpace();
  const {width} = useWindowDimensions();
  const cols = gridColumns(width);
  const cardW = Math.floor((width - GUTTER * 2 - 10 * (cols - 1)) / cols);
  const [tab, setTab] = useState<Tab>(route.params?.tab === 'sent' ? 'sent' : 'forYou');
  const [from, setFrom] = useState('');
  const [items, setItems] = useState<HeroItem[] | null>(null);
  const [people, setPeople] = useState<{id: string; name: string}[]>([]);
  const [sent, setSent] = useState<HouseholdSentCard[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    track('feat', {f: 'hhrec-all'});
    api
      .householdSeen(profileId)
      .then(r => r && r.n && householdChanged())
      .catch(() => {});
  }, [profileId]);
  useEffect(() => onHouseholdChanged(() => setReload(n => n + 1)), []);
  useEffect(() => {
    if (!isFocused) return;
    let live = true;
    setError('');
    if (tab === 'forYou') {
      api
        .household(profileId, from || null)
        .then(r => {
          if (!live) return;
          setItems(r.items || []);
          setPeople(r.people || []);
          noteShown(r.items as never);
        })
        .catch(() => live && setError('Could not load the recommendations.'));
    } else {
      api
        .householdSent(profileId)
        .then(r => live && setSent(r.items || []))
        .catch(() => live && setError('Could not load what you sent.'));
    }
    return () => {
      live = false;
    };
  }, [profileId, isFocused, tab, from, reload]);
  const open = useCallback((it: HeroItem) => openItem(navigation, it), [navigation]);
  const head = (
    <View style={{paddingTop: insets.top + 70}}>
      <Text style={s.h1}>{WORDS.pageTitle}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
        <ChipButton label={WORDS.tabForYou} active={tab === 'forYou'} onPress={() => setTab('forYou')} />
        <ChipButton label={WORDS.tabSent} active={tab === 'sent'} onPress={() => setTab('sent')} />
      </ScrollView>
      {tab === 'forYou' && people.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[s.chips, {paddingTop: 0}]}>
          {filterOptions(people).map(o => (
            <ChipButton key={o.id || 'all'} label={o.label} active={from === o.id} onPress={() => setFrom(o.id)} />
          ))}
        </ScrollView>
      ) : null}
      {error ? <Text style={s.empty}>{error}</Text> : null}
    </View>
  );
  if (tab === 'sent') {
    return (
      <View style={s.root}>
        <FlatList
          data={sent || []}
          keyExtractor={(x, i) => `${x.hh.key}-${i}`}
          ListHeaderComponent={head}
          contentContainerStyle={{paddingBottom: bottom + 16}}
          ListEmptyComponent={sent ? <Text style={s.empty}>{WORDS.emptySent}</Text> : null}
          renderItem={({item}) => {
            const art = artSrc(item.cover || item.poster, 56).src;
            return (
              <Tap flat onPress={() => open(item)} style={s.sent} accessibilityRole="button" accessibilityLabel={item.title}>
                <View style={s.thumb}>{art ? <Image source={art} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}</View>
                <View style={{flex: 1}}>
                  <Text style={s.sentTitle} numberOfLines={1}>
                    {item.title}
                    {item.year ? <Text style={s.year}>{`  ${item.year}`}</Text> : null}
                  </Text>
                  <Text style={s.sentWho} numberOfLines={3}>
                    {sentLine(item.hh.to || [])}
                  </Text>
                </View>
              </Tap>
            );
          }}
        />
        <BackBar />
      </View>
    );
  }
  return (
    <View style={s.root}>
      <FlatList
        key={`cols-${cols}`}
        data={items || []}
        numColumns={cols}
        keyExtractor={(x, i) => `${x.id || x.imdbId}-${i}`}
        ListHeaderComponent={head}
        columnWrapperStyle={{paddingHorizontal: GUTTER, gap: 10}}
        contentContainerStyle={{paddingBottom: bottom + 16}}
        ItemSeparatorComponent={() => <View style={{height: 14}} />}
        ListEmptyComponent={items ? <Text style={s.empty}>{WORDS.emptyForYou}</Text> : null}
        renderItem={({item}) => (
          <View style={{width: cardW}}>
            <PosterCard item={item} width={cardW} onPress={open} />
            <Text style={s.from} numberOfLines={2}>
              {fromLine((item.hh?.from || []).map(f => f.name))}
            </Text>
          </View>
        )}
      />
      <BackBar />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  h1: {color: colors.text, fontSize: 30, fontWeight: '900', paddingHorizontal: GUTTER},
  chips: {paddingHorizontal: GUTTER, paddingVertical: 12, gap: 8},
  empty: {color: colors.textDim, fontSize: 15, padding: GUTTER},
  from: {color: colors.textDim, fontSize: 12, marginTop: 6},
  sent: {flexDirection: 'row', gap: 12, alignItems: 'center', marginHorizontal: GUTTER, marginBottom: 8, padding: 10, borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge},
  thumb: {width: 52, height: 78, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.06)'},
  sentTitle: {color: colors.text, fontSize: 15, fontWeight: '800'},
  year: {color: colors.textDim, fontWeight: '600'},
  sentWho: {color: colors.textDim, fontSize: 13, marginTop: 4, lineHeight: 18},
});
