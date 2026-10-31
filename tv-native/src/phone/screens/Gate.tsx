// "Who's watching?" — the profile wall on the phone (the website's picker:
// the faces in a grid, a lit tile for the one this phone used last). Every
// rule — a password, the household PIN, the kids lock, a locked profile — is
// the TV's wall's, shared (profileWall.ts); this file only draws it. The last
// tile, "Add profile", opens the sign-in panel on "Request access" (phone/auth
// AuthDoor: a request the admin approves; "Sign in" beside it signs in with a
// password or Google). A protected profile's password asks "Forgot password?".
// Google's answer (aurora-phone://auth/google?…) that arrives while the wall is up —
// the app was closed while Google's page was open — opens the panel to finish it.
import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, BackHandler, Image, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {imgSrc, Profile} from '../../api';
import {OnChosen, useProfileWall} from '../../profileWall';
import Tap from '../ui/Tap';
import Field from '../ui/Field';
import {GlassButton, PrimaryButton} from '../ui/Buttons';
import Sky from '../ui/Sky';
import {REQUEST} from '../profiles';
import AuthDoor from '../auth/AuthDoor';
import {onAuthLink} from '../links';
import {AuthField, AuthShell, Foot, MainButton, TextLink} from '../auth/ui';
import {readable, W} from '../auth/rules';
import {colors, G_EDGE, GUTTER} from '../theme';

function Tile({p, first, onPress, size}: {p: Profile; first: boolean; onPress: () => void; size: number}) {
  return (
    <Tap
      uiId="profile.pick"
      accessibilityRole="button"
      accessibilityLabel={`${p.name}${p.kids ? ', kids profile' : ''}${p.hasPassword ? ', has a password' : ''}${p.locked ? ', locked' : ''}`}
      onPress={onPress}
      style={[s.tile, first && s.tileFirst, p.locked && s.dim, {width: size + 20}]}>
      <View style={[s.avatar, {width: size, height: size, borderRadius: 20, backgroundColor: p.color || colors.surfaceHover}, first && s.avatarFirst]}>
        {p.avatarImage ? (
          <Image source={imgSrc(p.avatarImage) || undefined} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <Text style={{fontSize: 40}} allowFontScaling={false}>
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

/** The wall's last tile (.profile-tile.add): a "＋" in an outlined square, "Add profile". */
function AddTile({onPress, size}: {onPress: () => void; size: number}) {
  return (
    <Tap uiId="profile.add" accessibilityRole="button" accessibilityLabel={REQUEST.addProfile} onPress={onPress} style={[s.tile, {width: size + 20}]}>
      <View style={[s.addFace, {width: size, height: size}]}>
        <Text style={s.addPlus} allowFontScaling={false}>
          ＋
        </Text>
      </View>
      <Text style={s.name} numberOfLines={1}>
        {REQUEST.addProfile}
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

function PasswordDoor({p, password, setPassword, error, busy, onUnlock, onBack, onForgot}: {
  p: Profile;
  password: string;
  setPassword: (s: string) => void;
  error: string;
  busy: boolean;
  onUnlock: () => void;
  onBack: () => void;
  onForgot: () => void;
}) {
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);
  return (
    <AuthShell>
      <View style={s.who}>
        <View style={[s.avatar, s.whoFace, {backgroundColor: p.color || colors.surfaceHover}]}>
          {p.avatarImage ? (
            <Image source={imgSrc(p.avatarImage) || undefined} style={StyleSheet.absoluteFill} />
          ) : (
            <Text style={{fontSize: 30}} allowFontScaling={false}>
              {p.avatar || '🍿'}
            </Text>
          )}
        </View>
        <Text style={s.whoName} accessibilityRole="header" numberOfLines={2}>
          {p.name}
        </Text>
      </View>
      <AuthField
        label={W.password}
        aside={<TextLink uiId="phone.auth.forgot" compact label={W.forgot} onPress={onForgot} />}
        secret
        value={password}
        onChangeText={setPassword}
        error={readable(error) || null}
        autoFocus
        autoComplete="current-password"
        textContentType="password"
        importantForAutofill="yes"
        returnKeyType="go"
        onSubmitEditing={onUnlock}
      />
      <MainButton uiId="profile.unlock" label="Unlock" busy={busy} onPress={onUnlock} />
      <Foot>
        <TextLink uiId="phone.auth.wall" label={W.backToProfiles} onPress={onBack} />
      </Foot>
    </AuthShell>
  );
}

export default function Gate({onChosen, notice}: {onChosen: OnChosen; notice: string}) {
  const w = useProfileWall(onChosen);
  const insets = useSafeAreaInsets();
  const {width} = useWindowDimensions();
  // .big-avatar: 84 (the lit one a step larger)
  const size = width < 360 ? 76 : 84;
  // the sign-in panel over the wall: from "Add profile", "Forgot password?" or Google's answer
  const [door, setDoor] = useState<{start: 'request' | 'forgot' | 'signin'; link?: string} | null>(null);
  const leaveDoor = useCallback(() => setDoor(null), []);
  useEffect(() => {
    if (door) return;
    return onAuthLink(url => setDoor({start: 'signin', link: url}));
  }, [door]);

  if (door) {
    return (
      <AuthDoor
        start={door.start}
        initialLink={door.link}
        onLeave={leaveDoor}
        onSignedIn={(id, token, sid, extra) => onChosen(id, token, sid, extra)}
      />
    );
  }

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

  // a protected profile's password — the sign-in panel's look (phone/auth/ui.tsx):
  // the face and name, a labelled field with "Forgot password?" by its label
  if (w.pwFor) {
    const p = w.pwFor;
    return (
      <PasswordDoor
        p={p}
        password={w.password}
        setPassword={w.setPassword}
        error={w.pwError}
        busy={w.busy}
        onUnlock={() => w.choose(p, w.password)}
        onBack={() => w.setPwFor(null)}
        onForgot={() => setDoor({start: 'forgot'})}
      />
    );
  }

  return (
    <View style={s.root}>
      <Sky dim />
      <ScrollView contentContainerStyle={[s.wall, {paddingTop: insets.top + 40, paddingBottom: insets.bottom + 40}]}>
        <Text style={s.heading} accessibilityRole="header">Who's watching?</Text>
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
          {w.profiles !== null ? <AddTile size={size} onPress={() => setDoor({start: 'request'})} /> : null}
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
  // .profiles-head h1: 28.8/900 on a 43.2 line
  heading: {color: colors.text, fontSize: 28.8, fontWeight: '900', letterSpacing: -0.58, lineHeight: 43.2, textAlign: 'center'},
  sub: {color: colors.textDim, fontSize: 16, textAlign: 'center', marginTop: 8, lineHeight: 22},
  notice: {color: '#ffd28a', fontSize: 15, textAlign: 'center', marginTop: 12},
  error: {color: '#ffb3b3', fontSize: 15, textAlign: 'center', marginTop: 12},
  retry: {marginTop: 16, alignSelf: 'center'},
  // .profiles-row: tiles 14 apart, 34 under the heading; .profile-tile 10 inside, 24 round
  grid: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 34, gap: 14},
  tile: {alignItems: 'center', padding: 10, gap: 10, borderRadius: 24, borderWidth: 1, borderColor: 'transparent'},
  tileFirst: {backgroundColor: 'rgba(255,255,255,0.07)', ...G_EDGE},
  avatar: {alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)'},
  avatarFirst: {transform: [{scale: 1.07}], marginVertical: 3},
  doorFace: {width: 88, height: 88, borderRadius: 20, alignSelf: 'center'},
  kids: {position: 'absolute', bottom: 6, alignSelf: 'center', backgroundColor: '#ffcf4a', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1},
  kidsText: {color: '#2a1d00', fontSize: 11, fontWeight: '900', letterSpacing: 0.5},
  name: {color: colors.textDim, fontSize: 14.4, fontWeight: '700', lineHeight: 21.6},
  nameFirst: {color: colors.text},
  // .profile-tile.add .big-avatar: no fill, a 2 dp inset line, the plus 40 in the dim grey
  addFace: {alignItems: 'center', justifyContent: 'center', borderRadius: 20, borderWidth: 2, borderColor: 'rgba(255,255,255,0.14)'},
  addPlus: {color: colors.textDim, fontSize: 40, lineHeight: 48},
  door: {flexGrow: 1, paddingHorizontal: GUTTER + 8, maxWidth: 520, width: '100%', alignSelf: 'center'},
  field: {marginTop: 24},
  row: {flexDirection: 'row', gap: 10, marginTop: 20},
  who: {flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 18},
  whoFace: {width: 56, height: 56, borderRadius: 16},
  whoName: {flex: 1, color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.3},
});
