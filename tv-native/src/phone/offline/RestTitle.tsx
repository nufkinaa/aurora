// A title page with no connection RESTS instead of failing (the website's offlineRest.js
// restTitle, docs/offline-look.md §7): its cover at 45 %, the kicker "NO CONNECTION" in amber,
// the title, one line, and the one button that helps. When the film — or some of the show's
// episodes — are on this device, the page is mint instead: "It is on this device, so it plays
// with no connection." with Play (the next episode here that is not finished).
import React from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Svg, {Path} from 'react-native-svg';
import {artSrc} from '../ui/Cards';
import {colors, GUTTER} from '../theme';
import {pushPhone} from '../nav';
import {Btn} from './Place';
import {AMBER, MINT} from './Mark';
import {copyName, PLACE} from './rules';
import {isWatched} from './storage';
import type {Saved} from './store';

const REST = 'M9.3 7.2A5.6 5.6 0 0 1 17.6 11a3.8 3.8 0 0 1 2.3 6.5M16.5 18.5H7.2a4.2 4.2 0 0 1-1-8.28M4 4l16 16';

/** What this person holds on this device of a title: the film itself, or the show's episodes in order. */
export function copiesOfTitle(all: Saved[], ids: {id?: string | null; showId?: string | null}) {
  const done = all.filter(c => c.state === 'done');
  const film = done.find(c => c.id === ids.id && c.season == null) || null;
  const eps = film ? [] : done.filter(c => (c.showId === ids.id || (ids.showId && c.showId === ids.showId)) && c.season != null && c.episode != null).sort((a, b) => a.season! - b.season! || a.episode! - b.episode!);
  return {film, eps, next: film || eps.find(e => !isWatched(e)) || eps[0] || null};
}

export default function RestTitle({title, cover, copies, onRetry}: {title: string; cover?: string | null; copies: ReturnType<typeof copiesOfTitle>; onRetry: () => void}) {
  const insets = useSafeAreaInsets();
  const here = copies.next;
  const line = copies.film
    ? 'It is on this device, so it plays with no connection.'
    : copies.eps.length
    ? `${copies.eps.length === 1 ? 'One episode is' : `${copies.eps.length} episodes are`} on this device — ${copies.eps.length === 1 ? 'it plays' : 'they play'} with no connection.`
    : "This one isn't on this device, so it waits for the connection.";
  const tone = here ? MINT : AMBER;
  const src = cover ? artSrc(cover, 600).src : null;
  return (
    <View style={[s.root, {paddingTop: insets.top + 80}]}>
      {src ? <Image source={src} style={[StyleSheet.absoluteFill, {opacity: 0.45}]} resizeMode="cover" blurRadius={2} /> : null}
      <View style={s.shade} />
      <View style={s.body}>
        <View style={s.kicker}>
          <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={tone} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            <Path d={REST} />
          </Svg>
          <Text style={[s.kickerText, {color: tone}]}>NO CONNECTION</Text>
        </View>
        <Text style={s.title} numberOfLines={3}>
          {title}
        </Text>
        <Text style={s.line}>{line}</Text>
        <View style={s.actions}>
          {here ? (
            <Btn uiId="saved.rest.play" primary label={copies.film ? 'Play' : `Play S${here.season} E${here.episode}`} onPress={() => pushPhone('OfflinePlayer', {id: here.id})} />
          ) : (
            <Btn uiId="saved.rest.open" primary label={PLACE} onPress={() => pushPhone('Downloads')} />
          )}
          <Btn uiId="saved.rest.retry" label="Try again" onPress={onRetry} />
        </View>
        {here && !copies.film ? <Text style={s.small}>{`Next here: ${copyName(here)}`}</Text> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  shade: {...StyleSheet.absoluteFill, backgroundColor: 'rgba(7,8,17,0.55)'},
  body: {paddingHorizontal: GUTTER + 4, paddingTop: 120},
  kicker: {flexDirection: 'row', alignItems: 'center', gap: 8},
  kickerText: {fontSize: 13, fontWeight: '900', letterSpacing: 1.6},
  title: {color: colors.text, fontSize: 30, fontWeight: '900', marginTop: 10, lineHeight: 36},
  line: {color: colors.textDim, fontSize: 15.5, lineHeight: 22, marginTop: 10},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 20},
  small: {color: colors.textFaint, fontSize: 13, marginTop: 12},
});
