// [household] "Recommend" on the phone — the website's recommend sheet: pick
// who should see it (several at once; a greyed face says why), an optional
// note, Send. Every rule is householdRecs.ts (shared with the TV, tested); the
// people and every refusal are the server's.
import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Image, StyleSheet, Text, TextInput, View} from 'react-native';
import {api, HouseholdPerson, imgSrc} from '../../api';
import {rootNav} from '../../rootNav';
import {showToast} from '../../toast';
import {track} from '../../usage';
import {householdChanged} from '../../householdLive';
import {
  NOTE_MAX,
  WORDS,
  keepPickable,
  noteCounter,
  offeredNote,
  pickable,
  pickerTitle,
  sendLabel,
  sendStatus,
  sendTitle,
  sendToast,
  titleKey,
  titleName,
  titleType,
  togglePick,
  toSend,
  typedNote,
  TitleLike,
} from '../../householdRecs';
import Sheet from '../ui/Sheet';
import Tap from '../ui/Tap';
import {GlassButton, PrimaryButton} from '../ui/Buttons';
import {colors, GUTTER, radius} from '../theme';

export default function RecommendSheet({title, imdbId, onClose}: {title: TitleLike; imdbId: string | null; onClose: () => void}) {
  const profileId = rootNav().profileId;
  const key = titleKey(title, imdbId);
  const [people, setPeople] = useState<HouseholdPerson[] | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const loadPeople = () => api.recommendPeople(profileId!, key!, titleType(title)).then(r => r.people || []);
  useEffect(() => {
    track('feat', {f: 'hhrec-open'});
    if (!profileId || !key) {
      setError("This title can't be recommended.");
      return;
    }
    let live = true;
    loadPeople()
      .then(list => {
        if (!live) return;
        setPeople(list);
        setNote(n => n || offeredNote(list));
      })
      .catch(e => {
        if (!live) return;
        setPeople([]);
        setError(String((e && e.message) || "Couldn't load the household — try again"));
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, key]);
  const to = useMemo(() => toSend(picked, people || []), [picked, people]);
  const send = async () => {
    if (busy || !to.length || !profileId) return;
    const t = sendTitle(title, imdbId);
    if (!t) return;
    setBusy(true);
    setError('');
    try {
      const a = await api.recommend(profileId, {to, title: t as Record<string, unknown>, note});
      track('feat', {f: 'hhrec-send'});
      const line = sendToast(a);
      if (line) {
        onClose();
        showToast(line, '💌');
        householdChanged();
        return;
      }
      setError(sendStatus(a));
      const list = await loadPeople().catch(() => people || []);
      setPeople(list);
      setPicked(s => keepPickable(s, list));
    } catch (e) {
      setError(String((e as Error)?.message || "Couldn't send that — try again"));
    }
    setBusy(false);
  };
  return (
    <Sheet visible onClose={onClose} title={pickerTitle(titleName(title))} sub={WORDS.pickerLine}>
      {people === null && !error ? <ActivityIndicator color={colors.text} style={{margin: 24}} /> : null}
      {people && people.length === 0 && !error ? <Text style={s.empty}>There's nobody else on this server yet.</Text> : null}
      {people && people.length ? (
        <View style={s.faces}>
          {people.map(p => {
            const can = pickable(p);
            const on = picked.has(p.id);
            const pic = p.avatarImage ? imgSrc(p.avatarImage) : null;
            return (
              <Tap
                key={p.id}
                flat
                accessibilityRole="checkbox"
                accessibilityState={{checked: on, disabled: !can}}
                accessibilityLabel={p.line ? `${p.name}, ${p.line}` : p.name}
                onPress={() => setPicked(x => togglePick(x, p))}
                style={[s.face, !can && {opacity: 0.45}]}>
                <View style={[s.avatar, {backgroundColor: p.color || colors.surfaceHover}, on && s.avatarOn]}>
                  {pic ? <Image source={pic} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <Text style={{fontSize: 30}}>{p.avatar || '🍿'}</Text>}
                  {on ? (
                    <View style={s.tick}>
                      <Text style={{color: '#fff', fontWeight: '900'}}>✓</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={s.name} numberOfLines={1}>
                  {p.name}
                </Text>
                {p.line ? (
                  <Text style={s.why} numberOfLines={2}>
                    {p.line}
                  </Text>
                ) : null}
              </Tap>
            );
          })}
        </View>
      ) : null}
      <View style={s.noteWrap}>
        <TextInput
          value={note}
          onChangeText={v => setNote(typedNote(v))}
          placeholder={WORDS.notePlaceholder || 'Add a note (optional)'}
          placeholderTextColor={colors.textFaint}
          maxLength={NOTE_MAX}
          multiline
          style={s.note}
        />
        <Text style={s.counter}>{noteCounter(note)}</Text>
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <View style={s.buttons}>
        <PrimaryButton uiId="recommend.send" label={sendLabel(to.length)} icon="send" onPress={send} busy={busy} disabled={!to.length} style={{flex: 1}} />
        <GlassButton uiId="recommend.close" label="Cancel" onPress={onClose} />
      </View>
    </Sheet>
  );
}

const s = StyleSheet.create({
  empty: {color: colors.textDim, fontSize: 15, paddingHorizontal: GUTTER + 4, paddingVertical: 12},
  faces: {flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: GUTTER, gap: 8},
  face: {width: 92, alignItems: 'center', paddingVertical: 8},
  avatar: {width: 64, height: 64, borderRadius: 16, alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  avatarOn: {borderWidth: 3, borderColor: '#fff'},
  tick: {position: 'absolute', right: 4, bottom: 4, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.accentStrong, alignItems: 'center', justifyContent: 'center'},
  name: {color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 6},
  why: {color: colors.textDim, fontSize: 12, textAlign: 'center', marginTop: 2},
  noteWrap: {marginHorizontal: GUTTER, marginTop: 12, borderRadius: radius.l, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: colors.glassEdge},
  note: {color: colors.text, fontSize: 16, minHeight: 56, paddingHorizontal: 14, paddingTop: 12, textAlignVertical: 'top'},
  counter: {color: colors.textFaint, fontSize: 12, alignSelf: 'flex-end', paddingHorizontal: 12, paddingBottom: 8},
  error: {color: '#ffb3b3', fontSize: 14, paddingHorizontal: GUTTER + 4, marginTop: 10},
  buttons: {flexDirection: 'row', gap: 10, paddingHorizontal: GUTTER, marginTop: 14},
});
