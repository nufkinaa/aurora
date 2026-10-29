// "Problem with this copy? → Get another version" on the phone — the TV's ReplaceSheet
// (components/ReplaceSheet.tsx) and the website's replaceCopy.js, as a bottom sheet: the
// same steps, the same words (replaceLogic.ts), the same server rules (src/media/replace.js).
//
//   step 1  What's wrong with this copy?   five reasons
//   step 2  Get another version            the title's other sources, BEST first, each
//                                          marked as the title page marks it
//   asked   This is not the real release   a pre-release copy picked: asked first
//   on its way                             status, reason, Cancel (the one who asked)
//   refused                                the server's why (a kids profile…)
//
// Opened from anywhere through overlay.ts openReplace (the player's "Audio and settings",
// a film's page) — on the phone it used to open nothing.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import Sheet from '../ui/Sheet';
import ListRow from '../ui/Row';
import {GlassButton, PrimaryButton} from '../ui/Buttons';
import {Bar} from '../ui/Cards';
import {api, ReplaceStream, ReplaceView} from '../../api';
import {currentRouteName, rootNav} from '../../rootNav';
import {showToast} from '../../toast';
import {track} from '../../usage';
import {reasonsOf, replaceAsksFirst, replaceFace, replaceReasonText, replaceRowText, replaceStatusText, replaceWho, sourcesError, WORDS} from '../../replaceLogic';
import {EARLY_CONFIRM} from '../../releaseWords';
import {colors, GUTTER} from '../theme';

const POLL_MS = 4000;
type Step2 = {reason: string; streams: ReplaceStream[] | null; error: string | null};

export default function ReplaceSheet({libraryId, title, context, onClose}: {libraryId: string; title: string; context?: Record<string, unknown>; onClose: () => void}) {
  const profileId = rootNav().profileId || '';
  const [view, setView] = useState<ReplaceView | null>(null);
  const [viewErr, setViewErr] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [step2, setStep2] = useState<Step2 | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [pickErr, setPickErr] = useState<string | null>(null);
  const [asked, setAsked] = useState<ReplaceStream | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

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

  const face = viewErr ? 'error' : replaceFace(view);
  const active = view?.active || null;
  useEffect(() => {
    if (face !== 'active') return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [face, load]);

  // Back / a tap outside: the list back to the reasons, the question back to the list, else close
  const back = () => {
    if (asked) return setAsked(null);
    if (step2) {
      setStep2(null);
      setPickErr(null);
      return;
    }
    onClose();
  };

  const pickReason = (reason: string) => {
    if (asking) return;
    setAsking(reason);
    setPickErr(null);
    api
      .replaceSources(libraryId, profileId)
      .then(r => live.current && setStep2({reason, streams: r.streams || [], error: null}))
      .catch(e => live.current && setStep2({reason, streams: null, error: sourcesError(e)}))
      .finally(() => live.current && setAsking(null));
  };

  const pickSource = (s: ReplaceStream, sure = false) => {
    if (!step2 || picking) return;
    const key = `${s.infoHash}:${s.fileIdx || 0}`;
    if (!sure && replaceAsksFirst(s)) return setAsked(s);
    setAsked(null);
    setPicking(key);
    setPickErr(null);
    api
      .replaceRequest(libraryId, {
        profile: profileId,
        reason: step2.reason,
        source: {infoHash: s.infoHash, fileIdx: s.fileIdx || 0},
        context: {route: `phone:${currentRouteName()}`, look: 'phone', ...(context || {})},
      })
      .then(() => {
        track('feat', {f: 'replace_pick', reason: step2.reason});
        onClose();
        showToast(WORDS.started, '⬇');
      })
      .catch(e => {
        if (!live.current) return;
        setPickErr((e as Error)?.message || "Couldn't start the download.");
        setPicking(null);
      });
  };

  const cancel = () => {
    if (cancelBusy) return;
    setCancelBusy(true);
    setCancelErr(null);
    api
      .replaceCancel(libraryId, profileId)
      .then(() => {
        track('feat', {f: 'replace_cancel'});
        onClose();
        showToast(WORDS.cancelled, '✓');
      })
      .catch(e => {
        if (!live.current) return;
        setCancelErr((e as Error)?.message || "Couldn't cancel it — try again in a moment.");
        setCancelBusy(false);
      });
  };

  const kicker = view?.item?.display || title || '';
  let heading: string = WORDS.step1;
  let body: React.ReactNode;
  if (face === 'error' || face === 'refused') {
    heading = WORDS.entry;
    body = (
      <>
        <Text style={s.body}>{face === 'error' ? viewErr : view?.why || "This copy can't be replaced."}</Text>
        <GlassButton label="Close" onPress={onClose} style={s.btn} />
      </>
    );
  } else if (face === 'active' && active) {
    heading = WORDS.activeHeading;
    const who = replaceWho(active);
    body = (
      <>
        <Text style={s.status}>{replaceStatusText(active)}</Text>
        {active.status === 'downloading' && !active.waiting && active.phase !== 'copying' && (active.progress || 0) > 0 ? (
          <Bar f={Math.max(0, Math.min(1, active.progress || 0))} bead={false} style={{marginTop: 10}} />
        ) : null}
        {replaceReasonText(active) ? <Text style={s.faint}>{replaceReasonText(active)}</Text> : null}
        {who.line ? <Text style={s.faint}>{who.line}</Text> : null}
        {cancelErr ? <Text style={s.error}>{cancelErr}</Text> : null}
        {who.cancel ? <PrimaryButton uiId="replace.cancel" label={WORDS.cancel} onPress={cancel} busy={cancelBusy} style={s.btn} /> : null}
        <GlassButton label="Close" onPress={onClose} style={s.btn} />
      </>
    );
  } else if (step2 && asked) {
    heading = EARLY_CONFIRM.title;
    body = (
      <>
        <Text style={s.body}>{EARLY_CONFIRM.text(asked)}</Text>
        <PrimaryButton uiId="replace.early" label={EARLY_CONFIRM.download} onPress={() => pickSource(asked, true)} style={s.btn} />
        <GlassButton label={EARLY_CONFIRM.cancel} onPress={() => setAsked(null)} style={s.btn} />
      </>
    );
  } else if (step2) {
    heading = WORDS.step2;
    const streams = step2.streams;
    body = (
      <>
        <Text style={s.body}>{WORDS.step2Body}</Text>
        {pickErr ? <Text style={s.error}>{pickErr}</Text> : null}
        {step2.error || !streams || !streams.length ? (
          <Text style={s.faint}>{step2.error || WORDS.none}</Text>
        ) : (
          <View style={s.list}>
            {streams.map(st => {
              const t = replaceRowText(st, step2.reason);
              const key = `${st.infoHash}:${st.fileIdx || 0}`;
              const tags = [t.best, ...t.tags].filter(Boolean).join(' · ');
              return (
                <ListRow
                  key={key}
                  uiId="replace.pick"
                  title={`${t.quality} · ${t.name || t.meta}`}
                  detail={[tags, t.meta, t.early, t.warn].filter(Boolean).join('\n')}
                  right={picking === key ? <ActivityIndicator color={colors.text} /> : undefined}
                  onPress={() => pickSource(st)}
                />
              );
            })}
          </View>
        )}
        <GlassButton label="‹  Back" onPress={back} style={s.btn} />
      </>
    );
  } else {
    body = (
      <>
        <Text style={s.body}>{WORDS.step1Body}</Text>
        <View style={s.list}>
          {reasonsOf(view).map(r => (
            <ListRow key={r.id} uiId="replace.reason" title={r.label} chevron right={asking === r.id ? <ActivityIndicator color={colors.text} /> : undefined} onPress={() => pickReason(r.id)} />
          ))}
        </View>
      </>
    );
  }
  return (
    <Sheet visible onClose={back} title={heading} sub={kicker}>
      <View style={s.pad}>{body}</View>
    </Sheet>
  );
}

const s = StyleSheet.create({
  pad: {paddingHorizontal: GUTTER + 4, paddingBottom: 8},
  body: {color: colors.textDim, fontSize: 15, lineHeight: 22, marginTop: 4},
  status: {color: colors.text, fontSize: 18, fontWeight: '800', marginTop: 6},
  faint: {color: colors.textDim, fontSize: 14, lineHeight: 20, marginTop: 8},
  error: {color: colors.danger, fontSize: 15, lineHeight: 21, marginTop: 8},
  list: {marginTop: 8, marginHorizontal: -(GUTTER + 4)},
  btn: {alignSelf: 'stretch', marginTop: 12},
});
