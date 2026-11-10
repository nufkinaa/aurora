// "Problem with this copy? → Get another version" — the sheet (the website's
// words; the rules are the server's, src/media/replace.js).
//
//   step 1  What's wrong with this copy?   five reasons, focus on the first
//   other   What's wrong with it?          "Other": a few words first (the field, the
//                                          remote's microphone where the TV can hear),
//                                          Next — nothing downloads (Jesse's report,
//                                          2026-11-08: Other went straight on to the
//                                          versions and gave no way to say what)
//     …ask   Get another version?           a CHOICE: Yes → step 2 (the words go with
//                                          the request), No → the words are sent as a
//                                          report and the copy stays
//   step 2  Get another version            the title's other sources, ★ BEST first,
//                                          each marked as the title page marks it
//                                          (CAM / TS / BURNED-IN SUBS + its line)
//   asked   This is not the real release   a pre-release copy picked: the title
//                                          page's question, in the sheet (one
//                                          sheet at a time); Back / Cancel →
//                                          the list, focus on that row
//   on its way                             status, reason, Cancel (the one who asked)
//     …Cancel                                asked first; focus on Keep going. Focus
//                                            used to land ON Cancel, which ended the
//                                            replacement at one press with no question
//   ended                                  the last try was cancelled or failed: what
//                                          happened, Pick another version (the next
//                                          candidates), Something else is wrong, Keep this copy
//   refused                                the server's why (a kids profile…)
//
// It opens ON the reasons — the five are known before the server answers, so
// focus lands on the first at once; the answer then may turn the sheet into
// "on its way" or "refused". A reason press keeps the sheet on step 1 (that
// row spinning, focus where it is) until the sources are in, so focus never
// falls out of the sheet between the steps. BACK: step 2 → step 1 (Other: → its
// question), the question → the words, the words → step 1, else closes.
// The Sheet traps focus on all four sides while it is up.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, LayoutChangeEvent, ScrollView, StyleSheet, Text, TextInput, useTVEventHandler, View} from 'react-native';
import Focusable from './Focusable';
import Sheet from './Sheet';
import {ink} from '../glass';
import {api, ReplaceStream, ReplaceView} from '../api';
import {clientContext} from '../clientContext';
import {acceptTvEvent, noteFocus, noteFocusLost} from '../focus';
import {notePress} from '../householdRecs';
import {closeOverlay} from '../overlay';
import {currentRouteName, rootNav} from '../rootNav';
import {showToast} from '../toast';
import {track} from '../usage';
import {
  addHeard,
  asksForNote,
  copyNote,
  copyReport,
  COPY_NOTE_MAX,
  reasonsOf,
  replaceFace,
  replaceReasonText,
  replaceAsksFirst,
  replaceRowText,
  replaceStatusText,
  replaceWho,
  sourcesError,
  WORDS,
} from '../replaceLogic';
import {EARLY_CONFIRM} from '../releaseWords';
import {useVoiceNote} from '../useVoiceNote';
import theme from '../theme';

const {colors, fontSize, radius, spacing} = theme;

const QUALITY_COLOR: Record<string, string> = {
  '2160p': '#c084fc',
  '1080p': '#60a5fa',
  '720p': '#34d399',
  '480p': '#fbbf24',
  SD: '#9aa1b5',
};
// while a replacement is on its way and the sheet is up: its progress, asked again this often
const POLL_MS = 4000;

type BtnRef = React.MutableRefObject<{requestTVFocus?: () => void} | null>;
const Primary = ({label, onPress, focus, busy, uiId, btnRef, onFocusChange}: {label: string; onPress: () => void; focus?: boolean; busy?: boolean; uiId?: string; btnRef?: BtnRef; onFocusChange?: (f: boolean) => void}) => (
  <Focusable ref={btnRef as never} round light ring="violet" hasTVPreferredFocus={focus} uiId={uiId} onPress={onPress} onFocusChange={onFocusChange} style={styles.primary}>
    {busy ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryText}>{label}</Text>}
  </Focusable>
);
const Ghost = ({label, onPress, focus, uiId, onFocusChange}: {label: string; onPress: () => void; focus?: boolean; uiId?: string; onFocusChange?: (f: boolean) => void}) => (
  <Focusable round hasTVPreferredFocus={focus} uiId={uiId} onPress={onPress} onFocusChange={onFocusChange} style={styles.ghost}>
    <Text style={styles.ghostText}>{label}</Text>
  </Focusable>
);

type Step2 = {reason: string; streams: ReplaceStream[] | null; error: string | null; note?: string | null};

export default function ReplaceSheet({
  libraryId,
  title,
  context,
  onClose,
}: {
  libraryId: string;
  title: string;
  context?: Record<string, unknown>;
  onClose?: () => void;
}) {
  const profileId = rootNav().profileId || '';
  const [view, setView] = useState<ReplaceView | null>(null);
  const [viewErr, setViewErr] = useState<string | null>(null);
  // which reason is fetching its sources (step 1 stays up meanwhile)
  const [asking, setAsking] = useState<string | null>(null);
  const [step2, setStep2] = useState<Step2 | null>(null);
  // the source being asked for (its row spins), and a refusal of it
  const [picking, setPicking] = useState<string | null>(null);
  const [pickErr, setPickErr] = useState<string | null>(null);
  // a pre-release copy picked: asked first (the title page's words)
  const [asked, setAsked] = useState<ReplaceStream | null>(null);
  // the row focus goes back to when that question is answered "Cancel"
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // Back from "This is not the real release" remounts the list at the top,
  // and the row focus goes back to (hasTVPreferredFocus at mount) is not
  // scrolled into view by Android — on the Mi TV the CAM row sat below the
  // sheet's edge with only its ring showing. Its layout brings it into view.
  const listScroll = useRef<ScrollView>(null);
  const listY = useRef(0);
  const onListLayout = useCallback((e: LayoutChangeEvent) => {
    listY.current = e.nativeEvent.layout.y;
  }, []);
  const onFocusRowLayout = useCallback((e: LayoutChangeEvent) => {
    const y = e.nativeEvent.layout.y;
    setTimeout(() => listScroll.current?.scrollTo({y: Math.max(0, listY.current + y - spacing.md), animated: false}), 0);
  }, []);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  // Cancel pressed: the question is up (Keep going / Cancel)
  const [askCancel, setAskCancel] = useState(false);
  // the "that version didn't come through" face was answered
  const [skipEnded, setSkipEnded] = useState(false);
  // "Other": the person's own words first, then the question (see the top)
  const [other, setOther] = useState<'write' | 'ask' | null>(null);
  const [note, setNote] = useState('');
  const [noteErr, setNoteErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const voice = useVoiceNote(heard => setNote(n => addHeard(n, heard)));
  // The field and its keys — the household-recommendation note's rules (RecommendSheet.tsx):
  // DOWN from the field goes to Next wherever the cursor is, the keyboard's ✓ too; focus.ts
  // is told the field holds focus, so its rescue never sends focus behind the sheet.
  const nextRef = useRef<{requestTVFocus?: () => void} | null>(null);
  const fieldRef = useRef<TextInput>(null);
  const fieldNode = useRef({requestTVFocus: () => fieldRef.current?.focus()});
  useEffect(() => () => noteFocusLost(fieldNode.current), []);
  const inField = useRef(false);
  const fieldGotAt = useRef(0);
  const fieldLeftAt = useRef(0);
  const prevKeyAt = useRef(Date.now());
  const leftField = useCallback(() => {
    if (!inField.current) return;
    inField.current = false;
    fieldLeftAt.current = Date.now();
    noteFocusLost(fieldNode.current);
  }, []);
  const notOnField = useCallback((f: boolean) => f && leftField(), [leftField]);
  useTVEventHandler(evt => {
    if (!evt || !acceptTvEvent(evt) || other !== 'write') return;
    const prev = prevKeyAt.current;
    prevKeyAt.current = Date.now();
    if (notePress({inField: inField.current, gotAt: fieldGotAt.current, leftAt: fieldLeftAt.current, prevKeyAt: prev}) !== 'field') return;
    if (evt.eventType === 'down') setTimeout(() => nextRef.current?.requestTVFocus?.(), 0);
  });
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const close = useCallback(() => {
    closeOverlay();
    onClose?.();
  }, [onClose]);
  // BACK: from the list of versions back to the reasons; anywhere else, closes.
  const step2Ref = useRef(step2);
  step2Ref.current = step2;
  const askedRef = useRef(asked);
  askedRef.current = asked;
  const askCancelRef = useRef(askCancel);
  askCancelRef.current = askCancel;
  const otherRef = useRef(other);
  otherRef.current = other;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const back = useCallback(() => {
    if (askCancelRef.current) {
      setAskCancel(false);
      return;
    }
    if (askedRef.current) {
      setAsked(null);
      return;
    }
    if (step2Ref.current) {
      setStep2(null);
      setFocusKey(null);
      setPickErr(null);
      setSkipEnded(true);
      return;
    }
    if (otherRef.current === 'ask') {
      setOther('write');
      return;
    }
    if (otherRef.current === 'write') {
      if (voiceRef.current.listening) return voiceRef.current.cancel();
      setOther(null);
      setNoteErr(null);
      setSkipEnded(true);
      return;
    }
    close();
  }, [close]);

  const load = useCallback(() => {
    api
      .replaceView(libraryId, profileId)
      .then(v => {
        if (!live.current) return;
        setView(v);
        setViewErr(null);
      })
      .catch(e => live.current && setViewErr((e as Error)?.message || "Couldn't reach the server."));
  }, [libraryId, profileId]);
  useEffect(() => {
    track('feat', {f: 'replace_open'});
    load();
  }, [load]);

  const face = viewErr ? 'error' : replaceFace(view, skipEnded || !!step2 || !!other);
  const active = view?.active || null;
  // a replacement on its way: its progress moves while the sheet is up
  useEffect(() => {
    if (face !== 'active') return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [face, load]);

  const loadSources = useCallback(
    (reason: string) => {
      if (asking) return;
      setAsking(reason);
      setPickErr(null);
      api
        .replaceSources(libraryId, profileId, reason)
        .then(r => live.current && setStep2({reason, streams: r.streams || [], error: null, note: r.note || null}))
        .catch(e => live.current && setStep2({reason, streams: null, error: sourcesError(e)}))
        .finally(() => live.current && setAsking(null));
    },
    [asking, libraryId, profileId],
  );
  // A reason: its versions — "Other" first asks what is wrong (nothing downloads yet)
  const pickReason = useCallback(
    (reason: string) => {
      if (asksForNote(reason)) {
        setNoteErr(null);
        setOther('write');
        return;
      }
      loadSources(reason);
    },
    [loadSources],
  );
  const toAsk = useCallback(() => {
    if (!note.trim()) {
      setNoteErr(WORDS.otherEmpty);
      setTimeout(() => fieldRef.current?.focus(), 0);
      return;
    }
    voice.cancel();
    setNoteErr(null);
    setOther('ask');
  }, [note, voice]);
  const reportCtx = useCallback(
    () => ({...clientContext(), route: `tv:${currentRouteName()}`, ...(context || {}), note: note.trim() || null}),
    [context, note],
  );
  // No — just send it: the words go to the admin as a report; nothing downloads
  const sendOnly = useCallback(() => {
    if (sending) return;
    setSending(true);
    setNoteErr(null);
    const label = reasonsOf(view).find(r => r.id === 'other')?.label || 'Other';
    api
      .report(copyReport({reasonLabel: label, note}), reportCtx(), rootNav().profileName || null)
      .then(() => {
        track('feat', {f: 'replace_note_only'});
        close();
        showToast(WORDS.sent, '🛠️');
      })
      .catch(e => {
        if (!live.current) return;
        setNoteErr((e as Error)?.message || "Couldn't send it — try again in a moment");
        setSending(false);
      });
  }, [sending, view, note, reportCtx, close]);

  const pickSource = useCallback(
    (s: ReplaceStream, sure = false) => {
      if (!step2 || picking) return;
      const key = `${s.infoHash}:${s.fileIdx || 0}`;
      if (!sure && replaceAsksFirst(s)) {
        setFocusKey(key);
        setAsked(s);
        return;
      }
      setAsked(null);
      setFocusKey(key);
      setPicking(key);
      setPickErr(null);
      api
        .replaceRequest(libraryId, {
          profile: profileId,
          reason: step2.reason,
          ...(note.trim() ? {note: note.trim()} : {}),
          source: {infoHash: s.infoHash, fileIdx: s.fileIdx || 0},
          context: reportCtx(),
        })
        .then(() => {
          track('feat', {f: 'replace_pick', reason: step2.reason});
          close();
          showToast(WORDS.started, '⬇');
        })
        .catch(e => {
          if (!live.current) return;
          setPickErr((e as Error)?.message || "Couldn't start the download.");
          setPicking(null);
        });
    },
    [step2, picking, libraryId, profileId, note, reportCtx, close],
  );

  const cancel = useCallback(() => {
    if (cancelBusy) return;
    setCancelBusy(true);
    setCancelErr(null);
    api
      .replaceCancel(libraryId, profileId)
      .then(() => {
        track('feat', {f: 'replace_cancel'});
        close();
        showToast(WORDS.cancelled, '✓');
      })
      .catch(e => {
        if (!live.current) return;
        setCancelErr((e as Error)?.message || "Couldn't cancel it — try again in a moment.");
        setCancelBusy(false);
      });
  }, [cancelBusy, libraryId, profileId, close]);

  const kicker = (view?.item?.display || title || '').toUpperCase();

  // ---------------------------------------------------------------- faces
  if (face === 'error' || face === 'refused') {
    return (
      <Sheet kicker={kicker} title={WORDS.entry} width={600} onClose={close}>
        <Text style={styles.body}>{face === 'error' ? viewErr : view?.why || "This copy can't be replaced."}</Text>
        <View style={styles.actions}>
          <Ghost label="Close" onPress={close} focus />
        </View>
      </Sheet>
    );
  }

  if (face === 'active' && active && askCancel) {
    return (
      <Sheet kicker={kicker} title={WORDS.cancelAsk} width={600} onClose={back}>
        <Text style={styles.body}>{WORDS.cancelAskBody}</Text>
        {cancelErr ? <Text style={styles.error}>{cancelErr}</Text> : null}
        <View style={[styles.actions, styles.actionsSpread]}>
          <Ghost label={WORDS.keepGoing} onPress={back} focus />
          <Primary uiId="replace.cancel" label={WORDS.cancel} onPress={cancel} busy={cancelBusy} />
        </View>
      </Sheet>
    );
  }

  if (face === 'active' && active) {
    const who = replaceWho(active);
    return (
      <Sheet kicker={kicker} title={WORDS.activeHeading} width={600} onClose={close}>
        <Text style={styles.status}>{replaceStatusText(active)}</Text>
        {active.status === 'downloading' && !active.waiting && active.phase !== 'copying' && (active.progress || 0) > 0 ? (
          <View style={styles.progress}>
            <View style={[styles.progressFill, {width: `${Math.round(Math.max(0, Math.min(1, active.progress || 0)) * 100)}%`}]} />
          </View>
        ) : null}
        {replaceReasonText(active) ? <Text style={styles.faint}>{replaceReasonText(active)}</Text> : null}
        {who.line ? <Text style={styles.faint}>{who.line}</Text> : null}
        <View style={[styles.actions, styles.actionsSpread]}>
          <Ghost label="Close" onPress={close} focus />
          {who.cancel ? <Ghost uiId="replace.cancel.ask" label={WORDS.cancel} onPress={() => setAskCancel(true)} /> : null}
        </View>
      </Sheet>
    );
  }

  // The last try ended without replacing anything: say what happened and offer the
  // next candidates (the same reason again, its list with that try's source last).
  if (face === 'ended' && view?.last) {
    const last = view.last;
    return (
      <Sheet kicker={kicker} title={WORDS.endedHeading} width={640} onClose={close}>
        <Text style={styles.status}>{last.line}</Text>
        {last.release ? <Text style={styles.faint}>{`That was: ${last.release}${last.quality ? ` (${last.quality})` : ''}`}</Text> : null}
        <Text style={styles.faint}>{`Reason: ${last.reasonLabel}`}</Text>
        <Text style={styles.body}>{WORDS.endedNext}</Text>
        <View style={styles.actions}>
          <Primary uiId="replace.next" label={WORDS.pickNext} onPress={() => loadSources(last.reason)} busy={asking === last.reason} focus />
          <Ghost uiId="replace.other" label={WORDS.otherReason} onPress={() => setSkipEnded(true)} />
          <Ghost label={WORDS.keepCopy} onPress={close} />
        </View>
      </Sheet>
    );
  }

  if (step2 && asked) {
    return (
      <Sheet kicker={kicker} title={EARLY_CONFIRM.title} width={640} onClose={back}>
        <Text style={styles.body}>{EARLY_CONFIRM.text(asked)}</Text>
        <View style={styles.actions}>
          <Ghost label={EARLY_CONFIRM.cancel} onPress={back} focus />
          <Primary uiId="replace.early" label={EARLY_CONFIRM.download} onPress={() => pickSource(asked, true)} />
        </View>
      </Sheet>
    );
  }

  if (step2) {
    const streams = step2.streams;
    return (
      <Sheet kicker={kicker} title={WORDS.step2} width={720} onClose={back} scrollRef={listScroll}>
        <Text style={styles.body}>{WORDS.step2Body}</Text>
        {step2.note ? <Text style={styles.faint}>{step2.note}</Text> : null}
        {pickErr ? <Text style={styles.error}>{pickErr}</Text> : null}
        {step2.error || !streams || !streams.length ? (
          <>
            <Text style={styles.faintBig}>{step2.error || WORDS.none}</Text>
            <View style={styles.actions}>
              <Ghost label="‹  Back" onPress={back} focus />
            </View>
          </>
        ) : (
          <View style={styles.list} onLayout={onListLayout}>
            {streams.map((s, i) => {
              const t = replaceRowText(s, step2.reason);
              const key = `${s.infoHash}:${s.fileIdx || 0}`;
              const q = QUALITY_COLOR[t.quality] || QUALITY_COLOR.SD;
              return (
                <View key={key} onLayout={focusKey === key ? onFocusRowLayout : undefined}>
                <Focusable
                  uiId="replace.pick"
                  scaleTo={1.01}
                  hasTVPreferredFocus={focusKey && streams.some(x => `${x.infoHash}:${x.fileIdx || 0}` === focusKey) ? key === focusKey : i === 0}
                  onPress={() => pickSource(s)}
                  highlightColor={colors.surfaceHover}
                  style={styles.row}>
                  <View style={[styles.qBadge, {borderColor: q}]}>
                    <Text style={[styles.qText, {color: q}]}>{t.quality}</Text>
                  </View>
                  <View style={styles.info}>
                    <View style={styles.titleLine}>
                      <Text style={styles.release} numberOfLines={1}>
                        {t.name || t.meta}
                      </Text>
                      {t.best ? <Text style={styles.best}>{t.best}</Text> : null}
                      {t.tags.map(tag => (
                        <Text key={tag} style={styles.tag}>
                          {tag}
                        </Text>
                      ))}
                    </View>
                    <Text style={styles.meta} numberOfLines={1}>
                      {t.meta}
                    </Text>
                    {t.early ? (
                      <Text style={styles.early} numberOfLines={1}>
                        {t.early}
                      </Text>
                    ) : null}
                    {t.warn ? (
                      <Text style={styles.warn} numberOfLines={1}>
                        {t.warn}
                      </Text>
                    ) : null}
                  </View>
                  {picking === key ? <ActivityIndicator color={colors.text} /> : null}
                </Focusable>
                </View>
              );
            })}
          </View>
        )}
      </Sheet>
    );
  }

  // Other — the question: another version, or just the words
  if (other === 'ask') {
    return (
      <Sheet kicker={kicker} title={WORDS.askHeading} width={640} onClose={back}>
        <Text style={styles.body}>{WORDS.askBody}</Text>
        <Text style={styles.quote} numberOfLines={3}>{`“${note.trim()}”`}</Text>
        {noteErr ? <Text style={styles.error}>{noteErr}</Text> : null}
        <View style={styles.actions}>
          <Primary uiId="replace.other.another" label={WORDS.askYes} onPress={() => loadSources('other')} busy={asking === 'other'} focus />
          <Ghost uiId="replace.other.send" label={sending ? 'Sending…' : WORDS.askNo} onPress={sendOnly} />
          <Ghost label="‹  Back" onPress={back} />
        </View>
      </Sheet>
    );
  }

  // Other — a few words first
  if (other === 'write') {
    return (
      <Sheet kicker={kicker} title={WORDS.otherHeading} width={640} onClose={back}>
        <Text style={styles.body}>{WORDS.otherBody}</Text>
        <TextInput
          ref={fieldRef}
          style={styles.input}
          value={note}
          onChangeText={v => {
            setNote(copyNote(v));
            if (noteErr) setNoteErr(null);
          }}
          autoFocus
          multiline
          numberOfLines={3}
          maxLength={COPY_NOTE_MAX * 2 /* code units; copyNote cuts at 300 code points */}
          placeholder={WORDS.otherPlaceholder}
          placeholderTextColor={ink.third}
          blurOnSubmit
          // the keyboard's ✓ ends the typing: focus goes on to Next (left to Android, a
          // field's blur put focus on the page under the sheet — RecommendSheet.tsx)
          onSubmitEditing={() => setTimeout(() => nextRef.current?.requestTVFocus?.(), 0)}
          onFocus={() => {
            inField.current = true;
            fieldGotAt.current = Date.now();
            noteFocus(fieldNode.current, false);
          }}
          onBlur={leftField}
        />
        {voice.line ? <Text style={styles.faint}>{voice.line}</Text> : null}
        {noteErr ? <Text style={styles.error}>{noteErr}</Text> : null}
        <View style={styles.actions}>
          <Primary uiId="replace.other.next" btnRef={nextRef} label={WORDS.otherNext} onPress={toAsk} onFocusChange={notOnField} />
          {voice.available ? <Ghost uiId="replace.other.voice" label={voice.listening ? WORDS.stopListening : `🎤  ${WORDS.sayIt}`} onPress={voice.press} onFocusChange={notOnField} /> : null}
          <Ghost label="‹  Back" onPress={back} onFocusChange={notOnField} />
        </View>
      </Sheet>
    );
  }

  // step 1 — the reasons (also while the server's answer is on its way)
  const reasons = reasonsOf(view);
  return (
    <Sheet kicker={kicker} title={WORDS.step1} width={600} onClose={close}>
      <Text style={styles.body}>{WORDS.step1Body}</Text>
      <View style={styles.list}>
        {reasons.map((r, i) => (
          <Focusable
            key={r.id}
            uiId="replace.reason"
            hasTVPreferredFocus={i === 0}
            onPress={() => pickReason(r.id)}
            highlightColor={colors.surfaceHover}
            style={styles.reason}>
            <Text style={styles.reasonText}>{r.label}</Text>
            {asking === r.id ? <ActivityIndicator color={colors.text} /> : null}
          </Focusable>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {color: colors.text, fontSize: fontSize.body, lineHeight: 24},
  faint: {color: ink.second, fontSize: fontSize.small, marginTop: spacing.sm},
  faintBig: {color: ink.second, fontSize: fontSize.body, marginTop: spacing.md},
  quote: {color: colors.text, fontSize: fontSize.body, fontStyle: 'italic', marginTop: spacing.md},
  input: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderRadius: radius.m,
    color: colors.text,
    fontSize: fontSize.body,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginTop: spacing.md,
    minHeight: 84,
    textAlignVertical: 'top',
  },
  error: {color: '#ff8080', fontSize: fontSize.body, marginTop: spacing.sm},
  status: {color: colors.text, fontSize: fontSize.row, fontWeight: '800'},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg},
  actionsSpread: {justifyContent: 'space-between'},
  primary: {backgroundColor: colors.white, paddingVertical: 12, paddingHorizontal: 26, minWidth: 130, alignItems: 'center'},
  primaryText: {color: colors.bg, fontSize: fontSize.body, fontWeight: '800'},
  ghost: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  ghostText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  progress: {height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.14)', overflow: 'hidden', marginTop: spacing.md},
  progressFill: {height: '100%', borderRadius: 4, backgroundColor: colors.accent},
  list: {gap: spacing.sm, marginTop: spacing.md},
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: radius.m,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  reasonText: {color: colors.text, fontSize: fontSize.body, fontWeight: '700'},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.m,
    padding: spacing.md,
  },
  qBadge: {borderWidth: 1, borderRadius: radius.s, paddingVertical: 4, paddingHorizontal: 10, minWidth: 66, alignItems: 'center'},
  qText: {fontSize: fontSize.small, fontWeight: '800'},
  info: {flex: 1, minWidth: 0},
  titleLine: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  release: {color: colors.text, fontSize: fontSize.body, fontWeight: '700', flexShrink: 1},
  best: {color: '#f5c542', fontSize: 12, fontWeight: '900', borderWidth: 1, borderColor: 'rgba(245,197,66,0.45)', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden', flexShrink: 0},
  tag: {color: '#fbbf24', fontSize: 12, fontWeight: '900', borderWidth: 1, borderColor: 'rgba(251,191,36,0.45)', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden', flexShrink: 0},
  meta: {color: ink.second, fontSize: fontSize.small, fontWeight: '600', marginTop: 4},
  early: {color: '#fcd34d', fontSize: fontSize.small, fontWeight: '700', marginTop: 2},
  warn: {color: '#ff8080', fontSize: fontSize.small, fontWeight: '700', marginTop: 2},
});
