// "Edit profile & password" on the phone — the website's edit sheet
// (public/js/screens/profiles.js profileModal, edit mode) as a page: the name,
// the email (a sign-in identifier), the emoji, the colour and the password
// (current + new; "Remove password"). Save does what the site's Save does, in
// its order: PUT the profile, the email if it changed, the password if one
// was typed — and as a new password ends this profile's unlock tokens, the
// phone opens the profile again with it and keeps what comes back (the token,
// and a session when the profile signs in), as AppRoot's onResetDone does.
// A kids profile's page has no email and no password (the server refuses
// those from inside a kids profile; the admin's People tab has them).
//
// ProfileCard is the "Your profile" card's insides in Settings
// (preferences.js profileSection): the face, the edit row, the photo rows.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {api, ApiError, apiOwnHeaders, apiPost, apiRequest, getBaseUrl, Profile, setSession, setToken} from '../../api';
import {useApp} from '../../AppContext';
import {loadMe, patchMe, useMe} from '../../navSection';
import {saveAuthSession, saveProfile} from '../../storage';
import {showToast} from '../../toast';
import {AVATARS, COLORS, EDIT, editPlan, editRow, kidsLabel, MAX, newPasswordPlaceholder, passwordLabel, PHOTO, photoAnswer, photoRow, profileLine, refusal} from '../profiles';
import {phoneNative} from '../native';
import {pushPhone, usePNav} from '../nav';
import {BackBar, useColumn, usePageTop, useSolidBar} from '../ui/PageHead';
import Avatar from '../ui/Avatar';
import Field from '../ui/Field';
import Glass from '../ui/Glass';
import ListRow from '../ui/Row';
import Tap from '../ui/Tap';
import {GlassButton, PrimaryButton} from '../ui/Buttons';
import {useTabBarSpace} from '../ui/TabBar';
import {colors, GUTTER} from '../theme';

const msgOf = (e: unknown) => (e instanceof Error ? e.message : '');

/** Settings → Your profile: who you are, then what you can do about it (the site's rows). */
export function ProfileCard({profileId, me: seed}: {profileId: string; me: Profile | null}) {
  const [me, setMe] = useState<Profile | null>(seed);
  const [busy, setBusy] = useState<'photo' | 'remove' | null>(null);
  useEffect(() => {
    if (seed) setMe(seed);
  }, [seed]);
  // back from the editor (or a photo): the record as the server has it now
  useFocusEffect(
    useCallback(() => {
      let live = true;
      loadMe(profileId, 0).then(p => live && p && setMe(p));
      return () => {
        live = false;
      };
    }, [profileId]),
  );
  const kid = !!me?.kids;
  const row = editRow(kid);

  const pickPhoto = async () => {
    if (busy) return;
    setBusy('photo');
    try {
      const url = `${getBaseUrl()}/api/profiles/${encodeURIComponent(profileId)}/avatar-image`;
      const text = await phoneNative.pickAndUploadPhoto(url, apiOwnHeaders());
      if (text === null) return; // the picker was closed
      const got = photoAnswer(text);
      if (got) {
        patchMe(profileId, got);
        setMe(m => (m ? {...m, ...got} : m));
      }
      const fresh = await loadMe(profileId, 0);
      if (fresh) setMe(fresh);
      showToast(PHOTO.uploaded, '📷');
    } catch (e) {
      showToast(refusal(msgOf(e), PHOTO.failed), '⚠️');
    } finally {
      setBusy(null);
    }
  };
  const removePhoto = async () => {
    if (busy) return;
    setBusy('remove');
    try {
      await apiRequest<{ok?: boolean}>(`/api/profiles/${encodeURIComponent(profileId)}/avatar-image`, {method: 'DELETE'});
      patchMe(profileId, {avatarImage: null});
      setMe(m => (m ? {...m, avatarImage: null} : m));
      showToast(PHOTO.backToEmoji);
    } catch {
      showToast(PHOTO.removeFailed, '⚠️');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {/* .pref-profile: a 56 dp face, the name 16.8/800, the line under it 13.44 */}
      <View style={s.me}>
        <Avatar p={me} size={56} />
        <View style={{flex: 1}}>
          <Text style={s.meName}>{me?.name || ''}</Text>
          <Text style={s.meSub}>{profileLine(me)}</Text>
        </View>
      </View>
      <ListRow uiId="phone.settings.editprofile" icon="edit" title={row.title} detail={row.detail} chevron onPress={() => pushPhone('EditProfile', undefined)} />
      <ListRow
        uiId="phone.settings.photo"
        icon="person"
        title={photoRow(!!me?.avatarImage)}
        detail={busy === 'photo' ? 'Uploading…' : PHOTO.note}
        right={busy === 'photo' ? <ActivityIndicator color={colors.text} size="small" /> : undefined}
        chevron={busy !== 'photo'}
        onPress={phoneNative.available ? pickPhoto : () => showToast(PHOTO.noPicker, 'ℹ️')}
      />
      {me?.avatarImage ? (
        <ListRow uiId="phone.settings.photoremove" icon="trash" title={PHOTO.remove} detail={PHOTO.removeNote} chevron={busy !== 'remove'} right={busy === 'remove' ? <ActivityIndicator color={colors.text} size="small" /> : undefined} onPress={removePhoto} />
      ) : null}
    </>
  );
}

export default function EditProfile() {
  const bar = useSolidBar();
  const pageTop = usePageTop();
  const column = useColumn();
  const bottom = useTabBarSpace();
  const nav = usePNav();
  const {profileId: id} = useApp();
  const cached = useMe(id);
  const [me, setMe] = useState<Profile | null>(cached);
  const [name, setName] = useState(cached?.name || '');
  const [avatar, setAvatar] = useState(cached?.avatar || AVATARS[0]);
  const [color, setColor] = useState(cached?.color || COLORS[0]);
  const [email, setEmail] = useState('');
  const [emailWas, setEmailWas] = useState('');
  const [cur, setCur] = useState('');
  const [fresh, setFresh] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<TextInput>(null);
  const filled = useRef(!!cached);

  // the record as the server has it, and (signed in as this profile) its email —
  // emails never ride the public wall data, so only the profile's own is filled in
  useEffect(() => {
    let live = true;
    loadMe(id, 0).then(p => {
      if (!live || !p) return;
      setMe(p);
      if (!filled.current) {
        filled.current = true;
        setName(p.name || '');
        setAvatar(p.avatar || AVATARS[0]);
        setColor(p.color || COLORS[0]);
      }
    });
    api
      .me()
      .then(r => {
        if (!live || !r.user || r.user.profileId !== id) return;
        setEmail(r.user.email || '');
        setEmailWas(r.user.email || '');
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);

  const kid = !!me?.kids;
  const hasPw = !!me?.hasPassword;

  // A new password ends every unlock token of the profile (this phone's too): open it
  // again with the new one and keep what comes back, so this phone stays in.
  const keepSignedIn = async (answer: {token?: string; session?: string}, typed: string) => {
    let token = answer.token || null;
    let sid = answer.session || null;
    if (!token) {
      try {
        const u = await api.unlock(id, typed);
        token = u.token || null;
        sid = sid || u.session || null;
      } catch {}
    }
    if (token) {
      setToken(token);
      await saveProfile(id, token);
    } else {
      showToast(EDIT.reenter, '⚠️');
    }
    if (sid) {
      setSession(sid);
      await saveAuthSession(sid);
    }
  };

  const save = async () => {
    if (busy) return;
    setError('');
    const plan = editPlan({name, avatar, color, email: kid ? null : email, emailWas, newPassword: fresh, kids: kid});
    if (plan.problem === 'name') return nameRef.current?.focus();
    if (plan.problem) return setError(plan.problem);
    setBusy(true);
    try {
      const p = await apiRequest<Profile>(`/api/profiles/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(plan.fields),
      });
      patchMe(id, {name: p?.name || plan.fields.name, avatar: p?.avatar || plan.fields.avatar, color: p?.color || plan.fields.color});
      if (plan.email !== null) {
        try {
          await apiPost<{ok?: boolean}>(`/api/profiles/${encodeURIComponent(id)}/email`, {email: plan.email});
          setEmailWas(plan.email);
        } catch (e) {
          return setError(refusal(msgOf(e), EDIT.emailFailed));
        }
      }
      if (plan.newPassword) {
        const r = await api.setPassword(id, plan.newPassword, hasPw ? cur : '');
        patchMe(id, {hasPassword: true});
        await keepSignedIn(r, plan.newPassword);
        showToast(EDIT.saved, '🔒');
      }
      nav.goBack();
    } catch (e) {
      setError(refusal(msgOf(e), EDIT.failed));
    } finally {
      setBusy(false);
    }
  };

  const removePassword = async () => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await api.setPassword(id, '', cur);
      patchMe(id, {hasPassword: false});
      showToast(EDIT.removed, '🔓');
      nav.goBack();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? EDIT.wrongPw : refusal(msgOf(e), EDIT.wrongPw));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.root}>
      <ScrollView
        onScroll={bar.onScroll}
        scrollEventThrottle={32}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[{paddingTop: pageTop, paddingBottom: bottom + 24, paddingHorizontal: GUTTER}, column]}>
        <Text style={s.h1} accessibilityRole="header">
          {EDIT.heading}
        </Text>
        <Text style={s.sub}>{me?.name || ''}</Text>
        <Glass style={s.card}>
          <Text style={s.label}>{EDIT.name}</Text>
          <Field ref={nameRef} value={name} onChangeText={setName} placeholder={EDIT.name} maxLength={MAX.name} autoCorrect={false} returnKeyType="done" />

          {kid ? null : (
            <View style={s.field}>
              <Text style={s.label}>{EDIT.email}</Text>
              <Field value={email} onChangeText={setEmail} placeholder={EDIT.emailPlaceholder} maxLength={MAX.email} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="emailAddress" />
              <Text style={s.hint}>{EDIT.emailHint}</Text>
            </View>
          )}

          <View style={s.field}>
            <Text style={s.label}>{EDIT.avatar}</Text>
            <View style={s.pick}>
              {AVATARS.map(a => (
                <Tap key={a} uiId="phone.edit.avatar" accessibilityRole="button" accessibilityLabel={a} accessibilityState={{selected: a === avatar}} onPress={() => setAvatar(a)} style={[s.face, a === avatar && s.faceOn]}>
                  <Text style={s.faceText} allowFontScaling={false}>
                    {a}
                  </Text>
                </Tap>
              ))}
            </View>
          </View>

          <View style={s.field}>
            <Text style={s.label}>{EDIT.color}</Text>
            <View style={s.pick}>
              {COLORS.map(c => (
                <Tap key={c} uiId="phone.edit.color" borderless accessibilityRole="button" accessibilityLabel={c} accessibilityState={{selected: c === color}} onPress={() => setColor(c)} style={[s.dot, {backgroundColor: c}, c === color && s.dotOn]} />
              ))}
            </View>
          </View>

          {kid && me?.kids ? (
            <View style={[s.field, s.kidsRow]}>
              <View style={s.kidsBadge}>
                <Text style={s.kidsBadgeText}>{EDIT.kids}</Text>
              </View>
              <Text style={s.kidsText}>{kidsLabel(me.kids)}</Text>
            </View>
          ) : (
            <View style={s.field}>
              <Text style={s.label}>{passwordLabel(hasPw)}</Text>
              {hasPw ? (
                <Field value={cur} onChangeText={setCur} placeholder={EDIT.current} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password" style={s.gap} />
              ) : null}
              <Field value={fresh} onChangeText={setFresh} placeholder={newPasswordPlaceholder(hasPw)} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="new-password" textContentType="newPassword" style={s.gap} />
              {hasPw ? (
                <Tap uiId="phone.edit.removepw" accessibilityRole="button" onPress={removePassword} style={s.removePw}>
                  <Text style={s.removePwText}>{EDIT.removePw}</Text>
                </Tap>
              ) : null}
            </View>
          )}

          {error ? (
            <Text style={s.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
          <View style={s.buttons}>
            <PrimaryButton uiId="profile.save" label={EDIT.save} onPress={save} busy={busy} style={s.grow} />
            <GlassButton label={EDIT.cancel} onPress={() => nav.goBack()} />
          </View>
        </Glass>
      </ScrollView>
      <BackBar solid={bar.solid} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  // the page's head: the site's .browse-head (24/900, the name 16/600 faint under it)
  h1: {color: colors.text, fontSize: 24, fontWeight: '900', letterSpacing: -0.72, lineHeight: 36},
  sub: {color: colors.textFaint, fontSize: 16, fontWeight: '600', lineHeight: 24, marginTop: 2, marginBottom: 14},
  // the site's .modal at phone width: 28 inside
  card: {padding: 20, marginBottom: 16},
  field: {marginTop: 16},
  // .field label: 13.6/700 in the dim grey, 7 over its input
  label: {color: colors.textDim, fontSize: 13.6, fontWeight: '700', marginBottom: 7},
  hint: {color: colors.textFaint, fontSize: 13, lineHeight: 19, marginTop: 6},
  gap: {marginBottom: 8},
  // .avatar-pick: 46 squares, 12 round, 8 apart, the emoji 22; the one picked ringed in white
  pick: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  face: {width: 46, height: 46, borderRadius: 12, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent'},
  faceOn: {borderColor: '#fff'},
  faceText: {fontSize: 22},
  // .color-pick: 34 dots, the one picked ringed 3 in white and a step larger
  dot: {width: 34, height: 34, borderRadius: 17, margin: 3},
  dotOn: {borderWidth: 3, borderColor: '#fff', transform: [{scale: 1.1}]},
  kidsRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  kidsBadge: {backgroundColor: '#ffcf4a', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2},
  kidsBadgeText: {color: '#2a1d00', fontSize: 12, fontWeight: '900'},
  kidsText: {color: colors.textDim, fontSize: 14.4},
  removePw: {alignSelf: 'flex-start', minHeight: 40, justifyContent: 'center', paddingHorizontal: 4},
  removePwText: {color: '#ff7a7a', fontSize: 14.4, fontWeight: '700'},
  error: {color: '#ff7a7a', fontSize: 14, lineHeight: 20, marginTop: 14},
  buttons: {flexDirection: 'row', gap: 10, marginTop: 22},
  grow: {flex: 1},
  // ProfileCard: .pref-profile (as Settings drew it)
  me: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingVertical: 10},
  meName: {color: colors.text, fontSize: 16.8, fontWeight: '800', lineHeight: 25.2},
  meSub: {color: colors.textDim, fontSize: 13.44, lineHeight: 20.2, marginTop: 2},
});
