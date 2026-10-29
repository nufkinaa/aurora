// "Who's watching?" — the profile wall on the phone (the website's picker:
// the faces in a grid, a lit tile for the one this phone used last). Every
// rule — a password, the household PIN, the kids lock, a locked profile — is
// the TV's wall's, shared (profileWall.ts); this file only draws it.
import React from 'react';
import {ActivityIndicator, Image, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {imgSrc, Profile} from '../../api';
import {OnChosen, useProfileWall} from '../../profileWall';
import Tap from '../ui/Tap';
import Field from '../ui/Field';
import {GlassButton, PrimaryButton} from '../ui/Buttons';
import Sky from '../ui/Sky';
import {colors, GUTTER, radius} from '../theme';

const LOGO = require('../../assets/logo-mark.png');

function Tile({p, first, onPress, size}: {p: Profile; first: boolean; onPress: () => void; size: number}) {
  return (
    <Tap
      uiId="profile.pick"
      accessibilityRole="button"
      accessibilityLabel={`${p.name}${p.kids ? ', kids profile' : ''}${p.hasPassword ? ', has a password' : ''}${p.locked ? ', locked' : ''}`}
      onPress={onPress}
      style={[s.tile, first && s.tileFirst, p.locked && s.dim, {width: size + 28}]}>
      <View style={[s.avatar, {width: size, height: size, borderRadius: size * 0.22, backgroundColor: p.color || colors.surfaceHover}]}>
        {p.avatarImage ? (
          <Image source={imgSrc(p.avatarImage) || undefined} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <Text style={{fontSize: size * 0.48}} allowFontScaling={false}>
            {p.avatar || '🍿'}
          </Text>
        )}
        {p.kids ? (
          <View style={s.kids}>
            <Text style={s.kidsText}>KIDS</Text>
          </View>
        ) : null}
      </View>
      <Text style={[s.name, first && s.nameFirst]} numberOfLines={1}>
        {p.name}
        {p.locked ? '  🚫' : p.hasPassword ? '  🔒' : ''}
      </Text>
    </Tap>
  );
}

function Door({insets, children}: {insets: {top: number; bottom: number}; children: React.ReactNode}) {
  return (
    <View style={s.root}>
      <Sky dim />
      <KeyboardAvoidingView behavior="height" style={s.root}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[s.door, {paddingTop: insets.top + 60, paddingBottom: insets.bottom + 24}]}>
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

export default function Gate({onChosen, notice}: {onChosen: OnChosen; notice: string}) {
  const w = useProfileWall(onChosen);
  const insets = useSafeAreaInsets();
  const {width} = useWindowDimensions();
  const size = width < 380 ? 84 : 96;

  // the household PIN (leaving a kids profile, or a profile with no password)
  if (w.pinFor) {
    const from = w.lock && w.pinFor.mode === 'exit' ? (w.profiles || []).find(x => x.id === w.lock!.id) : null;
    return (
      <Door insets={insets}>
        <Text style={s.heading}>Grown-ups only</Text>
        <Text style={s.sub}>
          {w.pinFor.mode === 'exit'
            ? `Enter the household PIN to leave ${from ? `“${from.name}”` : 'the kids profile'}.`
            : `“${w.pinFor.profile.name}” has no password, so the household PIN opens it.`}
        </Text>
        <Field
          value={w.pin}
          onChangeText={t => w.setPin(t.replace(/\D/g, '').slice(0, 6))}
          secureTextEntry
          autoFocus
          keyboardType="number-pad"
          maxLength={6}
          placeholder="PIN"
          onSubmitEditing={w.submitPin}
          style={s.field}
        />
        {w.pinError ? <Text style={s.error}>{w.pinError}</Text> : null}
        <View style={s.row}>
          <PrimaryButton uiId="profile.pin.submit" label={w.pinFor.mode === 'exit' ? 'Unlock' : 'Open'} onPress={w.submitPin} busy={w.busy} style={s.grow} />
          <GlassButton
            label="Back"
            onPress={() => {
              w.setPinFor(null);
              w.setPin('');
              w.setPinError('');
            }}
          />
        </View>
      </Door>
    );
  }

  // a protected profile's password
  if (w.pwFor) {
    const p = w.pwFor;
    return (
      <Door insets={insets}>
        <View style={[s.avatar, s.doorFace, {backgroundColor: p.color || colors.surfaceHover}]}>
          {p.avatarImage ? (
            <Image source={imgSrc(p.avatarImage) || undefined} style={StyleSheet.absoluteFill} />
          ) : (
            <Text style={{fontSize: 42}}>{p.avatar || '🍿'}</Text>
          )}
        </View>
        <Text style={[s.heading, {marginTop: 16}]}>{p.name}</Text>
        <Text style={s.sub}>Enter password</Text>
        <Field
          value={w.password}
          onChangeText={w.setPassword}
          secureTextEntry
          autoFocus
          placeholder="Password"
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          autoComplete="current-password"
          onSubmitEditing={() => w.choose(p, w.password)}
          style={s.field}
        />
        {w.pwError ? <Text style={s.error}>{w.pwError}</Text> : null}
        <View style={s.row}>
          <PrimaryButton uiId="profile.unlock" label="Unlock" onPress={() => w.choose(p, w.password)} busy={w.busy} style={s.grow} />
          <GlassButton label="Back" onPress={() => w.setPwFor(null)} />
        </View>
      </Door>
    );
  }

  return (
    <View style={s.root}>
      <Sky dim />
      <ScrollView contentContainerStyle={[s.wall, {paddingTop: insets.top + 40, paddingBottom: insets.bottom + 40}]}>
        <Image source={LOGO} style={s.logo} resizeMode="contain" />
        <Text style={s.heading}>Who's watching?</Text>
        {notice ? <Text style={s.notice}>{notice}</Text> : null}
        {w.profiles === null && !w.loadError ? <ActivityIndicator color={colors.text} style={{marginTop: 24}} /> : null}
        {w.loadError ? <Text style={s.error}>{w.loadError}</Text> : null}
        {w.loadError && w.profiles === null ? (
          <GlassButton label="Try again" icon="refresh" onPress={w.retry} style={s.retry} />
        ) : null}
        <View style={s.grid}>
          {w.ordered.map((p, i) => (
            <Tile key={p.id} p={p} first={i === 0} size={size} onPress={() => w.onTile(p)} />
          ))}
        </View>
        {w.busy ? <ActivityIndicator color={colors.text} style={{marginTop: 20}} /> : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  grow: {flex: 1},
  dim: {opacity: 0.45},
  wall: {flexGrow: 1, justifyContent: 'center', paddingHorizontal: GUTTER},
  logo: {width: 56, height: 56, alignSelf: 'center', marginBottom: 18},
  heading: {color: colors.text, fontSize: 30, fontWeight: '800', textAlign: 'center'},
  sub: {color: colors.textDim, fontSize: 16, textAlign: 'center', marginTop: 8, lineHeight: 22},
  notice: {color: '#ffd28a', fontSize: 15, textAlign: 'center', marginTop: 12},
  error: {color: '#ffb3b3', fontSize: 15, textAlign: 'center', marginTop: 12},
  retry: {marginTop: 16, alignSelf: 'center'},
  grid: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 28, gap: 6},
  tile: {alignItems: 'center', paddingVertical: 12, paddingHorizontal: 8, borderRadius: radius.xl, borderWidth: 1, borderColor: 'transparent'},
  tileFirst: {backgroundColor: 'rgba(255,255,255,0.08)', borderColor: colors.glassEdge},
  avatar: {alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  doorFace: {width: 88, height: 88, borderRadius: 20, alignSelf: 'center'},
  kids: {position: 'absolute', bottom: 6, alignSelf: 'center', backgroundColor: '#ffcf4a', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1},
  kidsText: {color: '#2a1d00', fontSize: 11, fontWeight: '900', letterSpacing: 0.5},
  name: {color: colors.textDim, fontSize: 16, fontWeight: '700', marginTop: 10},
  nameFirst: {color: colors.text},
  door: {flexGrow: 1, paddingHorizontal: GUTTER + 8, maxWidth: 520, width: '100%', alignSelf: 'center'},
  field: {marginTop: 24},
  row: {flexDirection: 'row', gap: 10, marginTop: 20},
});
