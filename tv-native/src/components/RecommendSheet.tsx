// [household] "Recommend" — the person picker (the website's recommend sheet,
// docs/qa/household-recs/DESIGN.md). Opened from the title page, the hold-OK
// sheet and wherever else a title offers Recommend (overlay.ts openRecommend).
//
//   Recommend “Dune”
//   Pick who should see it
//   [face] [face] [face]   OK picks / unpicks (several at once); a face the
//                          server greys (not taking them, a kid's age, has
//                          watched it, the hourly limit) says why and stays put
//   Add a note (optional)            12/140
//   [Send to 2]  [Cancel]
//
// Everything the sheet decides is householdRecs.ts (pure, tested); the people
// and their states are the server's (GET /recommend/people), and so is every
// refusal (a refusal is an answer: its line is the toast).
import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Image, StyleSheet, Text, TextInput, View} from 'react-native';
import Focusable from './Focusable';
import Sheet from './Sheet';
import {api, HouseholdPerson, imgSrc} from '../api';
import {closeOverlay} from '../overlay';
import {rootNav} from '../rootNav';
import {showToast} from '../toast';
import {track} from '../usage';
import {householdChanged} from '../householdLive';
import {
  NOTE_MAX,
  WORDS,
  noteCounter,
  pickable,
  pickerTitle,
  sendLabel,
  sendStatus,
  sendTitle,
  sendToast,
  keepPickable,
  offeredNote,
  titleKey,
  titleName,
  titleType,
  togglePick,
  toSend,
  typedNote,
  TitleLike,
} from '../householdRecs';
import theme from '../theme';

const {colors, fontSize, radius, spacing} = theme;

const Face = React.memo(function RecFace({
  p,
  on,
  first,
  onToggle,
}: {
  p: HouseholdPerson;
  on: boolean;
  first: boolean;
  onToggle: (p: HouseholdPerson) => void;
}) {
  const can = pickable(p);
  // the photo through imgSrc: the session / profile headers ride along (closed mode)
  const pic = p.avatarImage ? imgSrc(p.avatarImage) : null;
  return (
    <Focusable
      uiId="recommend.person"
      hasTVPreferredFocus={first}
      scaleTo={1.04}
      onPress={() => onToggle(p)}
      highlightColor={colors.surfaceHover}
      accessibilityLabel={p.name}
      style={[styles.face, !can && styles.faceOff]}>
      <View style={[styles.avatar, {backgroundColor: p.color || colors.surfaceHover}, on && styles.avatarOn]}>
        {pic ? (
          <Image source={pic} style={styles.avatarImg} resizeMode="cover" fadeDuration={0} />
        ) : (
          <Text style={styles.avatarGlyph}>{p.avatar || '🍿'}</Text>
        )}
        {on ? (
          <View style={styles.tick}>
            <Text style={styles.tickText}>✓</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.name} numberOfLines={1}>
        {p.name}
      </Text>
      {p.line ? (
        <Text style={styles.why} numberOfLines={2}>
          {p.line}
        </Text>
      ) : null}
    </Focusable>
  );
});

export default function RecommendSheet({title, imdbId}: {title: TitleLike; imdbId?: string | null}) {
  const profileId = rootNav().profileId;
  const key = titleKey(title, imdbId);
  const name = titleName(title);
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
        // the note a person already has from you, offered back to edit
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

  const firstPickable = useMemo(() => (people || []).findIndex(pickable), [people]);
  const onToggle = useMemo(() => (p: HouseholdPerson) => setPicked(s => togglePick(s, p)), []);
  const to = toSend(picked, people || []);

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
        closeOverlay();
        showToast(line, '💌');
        // what the sender's own pages show (You sent) moved
        householdChanged();
        return;
      }
      // nothing went: the sheet says why, and the faces say what changed (a limit, someone off)
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
    <Sheet title={pickerTitle(name)} onClose={closeOverlay} width={760}>
      <Text style={styles.line}>{WORDS.pickerLine}</Text>
      {people === null && !error ? <ActivityIndicator color={colors.text} style={styles.wait} /> : null}
      {people && people.length === 0 ? <Text style={styles.empty}>There's nobody else on this server yet.</Text> : null}
      {people && people.length ? (
        <View style={styles.faces}>
          {people.map((p, i) => (
            <Face key={p.id} p={p} on={picked.has(p.id)} first={i === firstPickable} onToggle={onToggle} />
          ))}
        </View>
      ) : null}
      {people && people.length ? (
        <View style={styles.noteRow}>
          <TextInput
            style={styles.input}
            value={note}
            onChangeText={v => setNote(typedNote(v))}
            maxLength={NOTE_MAX * 2 /* code units; typedNote cuts at 140 code points */}
            placeholder={WORDS.notePlaceholder}
            placeholderTextColor={colors.textFaint}
            blurOnSubmit
          />
          <Text style={styles.counter}>{noteCounter(note)}</Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Focusable
          uiId="recommend.send"
          round
          light={to.length > 0}
          ring="violet"
          hasTVPreferredFocus={!!people && firstPickable < 0}
          onPress={send}
          style={[styles.primary, !to.length && styles.primaryOff]}>
          {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={[styles.primaryText, !to.length && styles.primaryTextOff]}>{sendLabel(to.length)}</Text>}
        </Focusable>
        <Focusable uiId="recommend.close" round hasTVPreferredFocus={!!error && !people} onPress={closeOverlay} style={styles.ghost}>
          <Text style={styles.ghostText}>Cancel</Text>
        </Focusable>
      </View>
    </Sheet>
  );
}

const FACE_W = 120;
const AV = 64;
const styles = StyleSheet.create({
  line: {color: colors.textDim, fontSize: fontSize.body, marginBottom: spacing.md},
  wait: {marginVertical: spacing.xl},
  empty: {color: colors.textDim, fontSize: fontSize.body, marginVertical: spacing.md},
  faces: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  face: {width: FACE_W, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 6, borderRadius: radius.m},
  faceOff: {opacity: 0.42},
  avatar: {width: AV, height: AV, borderRadius: AV / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 2, borderColor: 'transparent'},
  avatarOn: {borderColor: colors.accent},
  avatarImg: {position: 'absolute', top: 0, left: 0, width: AV, height: AV},
  avatarGlyph: {fontSize: 30},
  tick: {position: 'absolute', right: 0, bottom: 0, width: 24, height: 24, borderRadius: 12, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center'},
  tickText: {color: colors.white, fontSize: 14, fontWeight: '900'},
  name: {color: colors.text, fontSize: fontSize.body, fontWeight: '700', marginTop: 6, maxWidth: FACE_W - 12},
  why: {color: colors.textDim, fontSize: fontSize.small, marginTop: 2, textAlign: 'center', maxWidth: FACE_W - 8},
  noteRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md},
  input: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.m,
    color: colors.text,
    fontSize: fontSize.body,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  counter: {color: colors.textFaint, fontSize: fontSize.small, fontWeight: '700', minWidth: 56, textAlign: 'right'},
  error: {color: '#ff8080', fontSize: fontSize.body, marginTop: spacing.sm},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg, justifyContent: 'space-between'},
  primary: {backgroundColor: colors.white, paddingVertical: 12, paddingHorizontal: 26, minWidth: 150, alignItems: 'center'},
  primaryOff: {backgroundColor: 'rgba(255,255,255,0.16)'},
  primaryText: {color: colors.bg, fontSize: fontSize.body, fontWeight: '800'},
  primaryTextOff: {color: colors.textDim},
  ghost: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  ghostText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
});
