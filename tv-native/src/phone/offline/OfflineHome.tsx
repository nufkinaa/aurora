// No server at all when Aurora opens (airplane mode, no signal, the server down): the website
// lands on "On this device" — so does the phone. The last profile's saved copies, calm, with the
// amber line and Try again; Play opens the copy right here (no profile has to be "in": the copy
// knows whose it is, and where they stopped is sent when the server answers again). With
// nothing saved for that profile, the plain "Can't reach Aurora." notice is all there is.
// A kids profile sees only its own copies — the last profile's, never anyone else's.
import React, {useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {loadSession} from '../../storage';
import {phoneNative} from '../native';
import Icon from '../ui/Icon';
import Sky from '../ui/Sky';
import {colors, GUTTER} from '../theme';
import {NoServerLine, s as place, SavedTitles} from './Place';
import {useOfflineOf} from './store';
import {PLACE} from './rules';

export default function OfflineHome({onRetry, fallback}: {onRetry: () => void; fallback: React.ReactNode}) {
  const insets = useSafeAreaInsets();
  const [who, setWho] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    loadSession()
      .then(s => setWho(s.profileId || null))
      .catch(() => setWho(null));
  }, []);
  const copies = useOfflineOf(who ?? null).filter(c => c.state === 'done' && !!c.file);
  const [playing, setPlaying] = useState<string | null>(null);
  if (who === undefined) return null;
  if (!copies.length) return <>{fallback}</>;
  if (playing && who) {
    // (the player is loaded only when a copy is played: this screen comes up at start)
    const {OfflinePlayerView} = require('../screens/OfflinePlayer') as typeof import('../screens/OfflinePlayer');
    return (
      <View style={StyleSheet.absoluteFill}>
        <OfflinePlayerView
          id={playing}
          profileId={who}
          onBack={() => {
            phoneNative.setOrientation('auto');
            setPlaying(null);
          }}
          onNext={id => setPlaying(id)}
          orient={o => phoneNative.setOrientation(o)}
        />
      </View>
    );
  }
  return (
    <View style={{flex: 1}}>
    <Sky />
    <ScrollView style={{flex: 1}} contentContainerStyle={{paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24}}>
      <View style={s.head}>
        <Icon name="downloadDevice" size={24} color={colors.text} />
        <Text style={s.h1}>{PLACE}</Text>
      </View>
      <Text style={[place.sub, {marginBottom: 14}]}>Plays right here — even with no connection</Text>
      <NoServerLine onRetry={onRetry} />
      <Text style={place.h3}>{`Saved for offline · ${copies.length}`}</Text>
      <SavedTitles copies={copies} canRemove={false} onPlay={c => setPlaying(c.id)} />
    </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  head: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: GUTTER},
  h1: {color: colors.text, fontSize: 28, fontWeight: '900'},
});
