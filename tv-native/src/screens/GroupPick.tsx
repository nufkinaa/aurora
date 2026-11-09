// "What do we watch tonight?" — the TV as the room's main screen.
//
// The TV starts a session (or joins one with a code), shows the code and a QR
// code big enough to scan from the sofa, and the people in the room join on
// their phones. While they swipe it shows how far everyone is and the time
// left; then the pick, with the server's why ("3 of 3 said yes"), and one
// press plays it. "Swipe on this screen too" makes the TV a voter as well:
// one card at a time with Yes / Maybe / No.
//
// What is drawn follows the session (groupPick.ts stepOf, groupPickTv.ts
// viewOf); followGroup (groupPickApi.ts) keeps it live — socket + slow poll —
// and every action's own answer is handed to it (follow.take), so the screen
// never waits for the next poll to show what was just pressed.
//
// THE REMOTE. Each view's main action holds the focus as it appears (Start,
// Start swiping, Yes, Play…); the few header buttons sit above it. BACK in a
// session that is still going asks first (Stay / Leave / End for everyone) —
// a stray Back never drops the room's screen. Back in the explanation opened
// from "How it works" closes it. Anywhere else Back leaves the screen; the
// live follow stops on unmount (the server marks this box away by itself).
//
// PLAY. The room's screen is where the film plays (groupPick.ts playsHere):
// on this TV as the screen, Play — or anyone's Play on their phone — starts
// the title here once per chosen session (groupPickTv.ts autoStart). A library
// film goes straight to the player; a series or a catalogue title opens its
// title page (routeFor), replacing this screen: the evening is decided.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, BackHandler, Image, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import QRCode from 'react-native-qrcode-svg';
import Svg, {Circle, Line, Path, Rect, Text as SvgText} from 'react-native-svg';
import Btn from '../components/Btn';
import Chip from '../components/Chip';
import Focusable from '../components/Focusable';
import Icon from '../components/Icon';
import Sheet from '../components/Sheet';
import {ErrorState} from '../components/States';
import {artPath, artPx, getBaseUrl, imgSrc} from '../api';
import {useRouteShown} from '../useRouteShown';
import {useFocusFallback} from '../focus';
import {
  GroupCard,
  GroupMember,
  GroupOptions,
  GroupSearchHit,
  GroupSession,
  GroupSettings,
  GroupVerdict,
  TUTORIAL,
  WORDS,
  addedLine,
  cardMeta,
  codeOk,
  currentPick,
  hostOf,
  joinUrl,
  joinedLine,
  limitLabel,
  peopleOf,
  playLabel,
  playsHere,
  progressLine,
  screenOf,
  seenLine,
  tidyCode,
  unanswered,
} from '../groupPick';
import {GroupFollow, followGroup, groupApi, playTarget} from '../groupPickApi';
import {
  LocalVotes,
  autoStart,
  badgesOf,
  chosenKey,
  countdown,
  firstSettings,
  nextPick,
  personProgress,
  pickCount,
  routeFor,
  sessionLive,
  settingsLine,
  settleLocal,
  undoTarget,
  viewOf,
  votersOf,
  withMine,
} from '../groupPickTv';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, radius} = theme;
const YES = '#6ee7a8';
const MAYBE = '#f5c542';
const NO = '#ff7b8a';
const ERR = '#ff9b9b';

type Props = NativeStackScreenProps<RootStackParamList, 'GroupPick'>;
type SheetKind = null | 'join' | 'add' | 'settings' | 'leave';
type FocusRef = React.RefObject<{requestTVFocus?: () => void} | null>;

const messageOf = (e: unknown): string => {
  const m = (e as {message?: string})?.message;
  return m && !/^\d{3} \//.test(m) && m !== 'Cannot reach server' ? m : WORDS.noReach;
};
const picture = (path: string | null | undefined, w: number) => (path ? imgSrc(artPath(path, artPx(w)) || path) : null);

export default function GroupPick({navigation, route}: Props) {
  const {height, safeBottom} = useTvMetrics();
  const [options, setOptions] = useState<GroupOptions | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [tutorial, setTutorial] = useState<null | 'first' | 'howto'>(null);
  const [form, setForm] = useState<GroupSettings>(() => firstSettings(null));
  const [code, setCode] = useState<string | null>(null);
  const [raw, setRaw] = useState<GroupSession | null>(null);
  const [lost, setLost] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalVotes>({});
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [, setTick] = useState(0);

  const follow = useRef<GroupFollow | null>(null);
  const pending = useRef<GroupSession | null>(null);
  const history = useRef<string[]>([]);
  const pressed = useRef<string | null>(null);
  const started = useRef<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const mainRef = useRef<{requestTVFocus?: () => void} | null>(null);
  useFocusFallback(mainRef as never);

  // ---------- the choices (and whether the explanation was seen) ----------
  const loadOptions = useCallback(() => {
    setOptionsFailed(false);
    groupApi
      .options()
      .then(o => {
        setOptions(o);
        setForm(f => ({...firstSettings(o), ...f, limitSec: o.limits.includes(f.limitSec) ? f.limitSec : firstSettings(o).limitSec}));
        // first time here, and not on the way into someone's session
        if (!o.tutorialSeen && !route.params?.code) setTutorial(t => t || 'first');
      })
      .catch(() => setOptionsFailed(true));
  }, [route.params?.code]);
  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  // ---------- the session ----------
  const enter = useCallback(
    (s: GroupSession) => {
      setLost(null);
      setLocal({});
      setErr('');
      history.current = [];
      if (follow.current && code === s.code) follow.current.take(s);
      else pending.current = s;
      setRaw(s);
      setCode(s.code);
    },
    [code],
  );
  useEffect(() => {
    if (!code) return;
    const f = followGroup(
      code,
      s => setRaw(s),
      why => setLost(why.message || WORDS.ended),
    );
    follow.current = f;
    if (pending.current && pending.current.code === code) f.take(pending.current);
    pending.current = null;
    return () => {
      f.stop();
      if (follow.current === f) follow.current = null;
    };
  }, [code]);
  // this box's answers drop out once the server says them back
  useEffect(() => {
    if (raw) setLocal(l => (Object.keys(l).length ? settleLocal(raw, l) : l));
  }, [raw]);

  // opened with a code (a link): join it as the room's screen
  const joinWith = useCallback(
    async (c: string): Promise<string | null> => {
      try {
        const r = await groupApi.join(c, 'screen');
        enter(r.session);
        return null;
      } catch (e) {
        return messageOf(e);
      }
    },
    [enter],
  );
  const linked = route.params?.code;
  useEffect(() => {
    if (!linked) return;
    joinWith(tidyCode(linked)).then(m => m && setErr(m));
  }, [linked, joinWith]);

  const session = useMemo(() => (raw ? withMine(raw, local) : null), [raw, local]);
  const view = viewOf({options, optionsFailed, session, lost, tutorial: !!tutorial});
  useRouteShown(view !== 'loading');

  // a calm one-second tick while the clock runs
  const ticking = view === 'swipe' || view === 'waiting';
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  // ---------- doing things ----------
  const run = useCallback(async (id: string, fn: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = id;
    setBusy(id);
    setErr('');
    try {
      const r = (await fn()) as {session?: GroupSession} | null;
      if (r && r.session) {
        if (follow.current) follow.current.take(r.session);
        else setRaw(r.session);
      } else follow.current?.refresh();
    } catch (e) {
      setErr(messageOf(e));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, []);

  const create = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = 'start';
    setBusy('start');
    setErr('');
    groupApi
      .create(form, 'screen')
      .then(r => enter(r.session))
      .catch(e => setErr(messageOf(e)))
      .finally(() => {
        busyRef.current = null;
        setBusy(null);
      });
  }, [form, enter]);

  const vote = useCallback(
    (card: GroupCard, verdict: GroupVerdict) => {
      if (!code) return;
      history.current.push(card.key);
      setLocal(l => ({...l, [card.key]: verdict}));
      setErr('');
      groupApi
        .vote(code, card.key, verdict)
        .then(() => follow.current?.refresh())
        .catch(e => {
          setLocal(l => {
            const n = {...l};
            delete n[card.key];
            return n;
          });
          history.current = history.current.filter(k => k !== card.key);
          setErr(messageOf(e));
        });
    },
    [code],
  );
  const undo = useCallback(() => {
    if (!code || !session) return;
    const {key, history: rest} = undoTarget(history.current, session.mine);
    history.current = rest;
    if (!key) return;
    setLocal(l => ({...l, [key]: null}));
    groupApi
      .vote(code, key, null)
      .then(() => follow.current?.refresh())
      .catch(e => setErr(messageOf(e)));
  }, [code, session]);

  // Play: this box starts the title once per chosen session — whoever pressed it
  const startCard = useCallback(
    (card: GroupCard) => {
      const to = routeFor(playTarget(card), card);
      if (!to) return;
      if (!navigation.isFocused()) return;
      if (to.screen === 'Player') navigation.replace('Player', to.params);
      else navigation.replace('Detail', {item: to.params.item as never});
    },
    [navigation],
  );
  useEffect(() => {
    if (!raw) return;
    const card = autoStart(raw, pressed.current, started.current);
    if (!card) return;
    started.current = chosenKey(raw);
    startCard(card);
  }, [raw, startCard]);
  const play = useCallback(
    (key: string) => {
      if (!code) return;
      pressed.current = key;
      run('play', () => groupApi.choose(code, key));
    },
    [code, run],
  );

  const leave = useCallback(
    (all: boolean) => {
      setSheet(null);
      const c = code;
      follow.current?.stop();
      if (c) (all ? groupApi.end(c) : groupApi.leave(c)).catch(() => {});
      if (navigation.isFocused()) navigation.goBack();
    },
    [code, navigation],
  );

  const finishTutorial = useCallback(() => {
    if (tutorial === 'first') {
      groupApi.tutorialSeen(true).catch(() => {});
      setOptions(o => (o ? {...o, tutorialSeen: true} : o));
    }
    setTutorial(null);
  }, [tutorial]);

  // ---------- BACK ----------
  const backState = useRef({sheet, tutorial, live: false});
  backState.current = {sheet, tutorial, live: sessionLive(raw, lost)};
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!navigation.isFocused()) return false;
      const b = backState.current;
      if (b.sheet) return false; // the sheet's own Back closes it
      if (b.tutorial === 'howto') {
        setTutorial(null);
        return true;
      }
      if (b.live) {
        setSheet('leave');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [navigation]);

  // ---------- drawing ----------
  const isHost = !!session?.you?.host;
  const header = (
    <Header
      showHowto={view === 'start' || view === 'lobby' || view === 'waiting'}
      showLeave={sessionLive(raw, lost)}
      claimLeave={view === 'waiting' && !isHost && session?.you?.role !== 'voter'}
      onHowto={() => setTutorial('howto')}
      onLeave={() => setSheet('leave')}
    />
  );

  let body: React.ReactNode = null;
  if (view === 'loading') {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  } else if (view === 'failed') {
    body = <ErrorState message={WORDS.noReach} onAction={loadOptions} edgeLeft={false} />;
  } else if (view === 'tutorial') {
    body = <Tutorial mainRef={mainRef} onDone={finishTutorial} />;
  } else if (view === 'start') {
    body = (
      <StartView
        mainRef={mainRef}
        options={options}
        form={form}
        busy={busy === 'start'}
        onChange={p => setForm(f => ({...f, ...p}))}
        onStart={create}
        onJoin={() => setSheet('join')}
      />
    );
  } else if (session && view === 'lobby') {
    body = (
      <LobbyView
        mainRef={mainRef}
        session={session}
        options={options}
        busy={busy}
        onDeal={() => {
          if (!session.voters) return setErr(WORDS.needSomeone);
          run('deal', () => groupApi.start(session.code));
        }}
        onAdd={() => setSheet('add')}
        onSettings={() => setSheet('settings')}
        onRole={() => run('screen', () => groupApi.role(session.code, session.you?.role === 'voter' ? 'screen' : 'voter'))}
      />
    );
  } else if (session && view === 'swipe') {
    const left = unanswered(session);
    body = (
      <SwipeView
        mainRef={mainRef}
        session={session}
        card={left[0]}
        since={Date.now() - (follow.current?.receivedAt() ?? Date.now())}
        canUndo={history.current.length > 0}
        posterH={Math.round(height * 0.56)}
        onVote={vote}
        onUndo={undo}
      />
    );
  } else if (session && view === 'waiting') {
    body = (
      <WaitingView
        mainRef={mainRef}
        session={session}
        since={Date.now() - (follow.current?.receivedAt() ?? Date.now())}
        busy={busy}
        canUndo={session.you?.role === 'voter' && history.current.length > 0}
        onUndo={undo}
        onExtend={() => run('extend', () => groupApi.extend(session.code))}
        onFinish={() => run('finish', () => groupApi.finish(session.code))}
        onRole={() => run('screen', () => groupApi.role(session.code, 'screen'))}
      />
    );
  } else if (session && view === 'result') {
    body = (
      <ResultView
        mainRef={mainRef}
        session={session}
        busy={busy}
        posterH={Math.round(height * 0.56)}
        onPlay={play}
        onNext={i => run('next', () => groupApi.pick(session.code, i))}
        onAgain={() => run('again', () => groupApi.again(session.code))}
      />
    );
  } else if (session && view === 'nomatch') {
    body = (
      <Calm
        mainRef={mainRef}
        icon="sparkle"
        title={WORDS.noMatch}
        line={isHost ? WORDS.noMatchLine : WORDS.onlyHost}
        actions={
          isHost ? (
            <Btn uiId="group.again" ref={mainRef} label={WORDS.again} icon="refresh" hasTVPreferredFocus dim={busy === 'again'} onPress={() => run('again', () => groupApi.again(session.code))} />
          ) : (
            <Btn uiId="group.leave" ref={mainRef} label={WORDS.leave} hasTVPreferredFocus onPress={() => leave(false)} />
          )
        }
      />
    );
  } else if (view === 'chosen' && session) {
    const c = session.chosen;
    const here = playsHere(session, !!c && pressed.current === c.key);
    const scr = screenOf(session);
    body = (
      <Calm
        mainRef={mainRef}
        icon="play"
        title={WORDS.enjoy}
        big={c?.card.title}
        line={[c ? `${c.by} ${WORDS.pressedPlay}` : '', !here && scr ? (scr.app === 'tv' ? WORDS.startingOnTv : WORDS.startingOnScreen) : ''].filter(Boolean).join(' · ')}
        actions={
          <>
            {here && c ? <Btn uiId="group.play" primary icon="play" label={WORDS.play} onPress={() => startCard(c.card)} /> : null}
            <Btn uiId="group.leave" ref={mainRef} label={WORDS.leave} hasTVPreferredFocus={!here} onPress={() => leave(false)} />
          </>
        }
      />
    );
  } else if (view === 'ended') {
    body = (
      <Calm
        mainRef={mainRef}
        icon="info"
        title={WORDS.ended}
        line={lost || session?.ended?.reason || ''}
        actions={<Btn uiId="group.leave" ref={mainRef} label={WORDS.leave} hasTVPreferredFocus onPress={() => leave(false)} />}
      />
    );
  }

  return (
    <View style={[styles.root, {paddingBottom: safeBottom}]}>
      {view === 'result' && session ? <Backdrop card={currentPick(session)?.card || null} /> : null}
      {header}
      <View style={styles.body}>{body}</View>
      {err ? (
        <View style={styles.errRow}>
          <Icon name="warning" size={16} color={ERR} />
          <Text style={styles.errText} numberOfLines={2}>
            {err}
          </Text>
        </View>
      ) : null}

      {sheet === 'join' ? (
        <JoinSheet
          onClose={() => setSheet(null)}
          onJoin={async c => {
            const m = await joinWith(c);
            if (!m) setSheet(null);
            return m;
          }}
        />
      ) : null}
      {sheet === 'add' && session ? <AddSheet code={session.code} onClose={() => setSheet(null)} onAdded={() => follow.current?.refresh()} /> : null}
      {sheet === 'settings' && session ? (
        <Sheet kicker={WORDS.feature.toUpperCase()} width={760} onClose={() => setSheet(null)}>
          <SettingsGroups options={options} value={session.settings} onChange={p => run('option', () => groupApi.settings(session.code, p))} first />
          <View style={styles.sheetActions}>
            <Btn label={WORDS.close} onPress={() => setSheet(null)} />
          </View>
        </Sheet>
      ) : null}
      {sheet === 'leave' ? (
        <Sheet kicker={WORDS.feature.toUpperCase()} title={WORDS.leaveAsk} onClose={() => setSheet(null)}>
          <Text style={styles.sheetText}>{WORDS.leaveLine}</Text>
          <View style={styles.sheetActions}>
            <Btn label={WORDS.stay} hasTVPreferredFocus onPress={() => setSheet(null)} />
            <Btn uiId="group.leave" label={WORDS.leave} onPress={() => leave(false)} />
            {isHost ? <Btn uiId="group.end" label={WORDS.endAll} onPress={() => leave(true)} /> : null}
          </View>
        </Sheet>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- header
function Header({showHowto, showLeave, claimLeave, onHowto, onLeave}: {showHowto: boolean; showLeave: boolean; claimLeave: boolean; onHowto: () => void; onLeave: () => void}) {
  return (
    <View style={styles.head}>
      <View style={styles.kickerRow}>
        <Icon name="people" size={16} color={colors.accent} />
        <Text style={styles.kicker}>{WORDS.feature.toUpperCase()}</Text>
      </View>
      <View style={styles.headBtns}>
        {showHowto ? <Btn uiId="group.howto" small icon="info" label={WORDS.howItWorks} onPress={onHowto} /> : null}
        {/* asks first (the sheet holds Leave and End for everyone) */}
        {showLeave ? <Btn small label={WORDS.leave} hasTVPreferredFocus={claimLeave} onPress={onLeave} /> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- the explanation
function Tutorial({mainRef, onDone}: {mainRef: FocusRef; onDone: () => void}) {
  const [i, setI] = useState(0);
  const step = TUTORIAL[i];
  const last = i === TUTORIAL.length - 1;
  return (
    <View style={styles.tutRow}>
      <View style={styles.artPanel}>
        <Art name={step.art} />
      </View>
      <View style={styles.tutText}>
        <View style={styles.dots}>
          {TUTORIAL.map((_, n) => (
            <View key={n} style={[styles.dot, n === i && styles.dotOn]} />
          ))}
        </View>
        <Text style={styles.h1}>{step.title}</Text>
        <Text style={styles.tutBody}>{step.body}</Text>
        <View style={styles.actions}>
          <Btn
            uiId="group.tutorial.next"
            ref={mainRef as never}
            primary
            label={last ? WORDS.letsGo : WORDS.next}
            hasTVPreferredFocus
            onPress={() => (last ? onDone() : setI(i + 1))}
          />
          {last ? null : <Btn uiId="group.tutorial.skip" label={WORDS.skip} onPress={onDone} />}
        </View>
      </View>
    </View>
  );
}

// Four calm line drawings, one per step (TUTORIAL[].art).
function Art({name}: {name: 'tv' | 'phones' | 'swipe' | 'result'}) {
  const line = 'rgba(255,255,255,0.55)';
  const faint = 'rgba(255,255,255,0.14)';
  const a = colors.accent;
  return (
    <Svg width={260} height={176} viewBox="0 0 260 176">
      {name === 'tv' ? (
        <>
          <Rect x={30} y={18} width={200} height={120} rx={12} fill={faint} stroke={line} strokeWidth={2.5} />
          <Line x1={100} y1={152} x2={160} y2={152} stroke={line} strokeWidth={3} strokeLinecap="round" />
          <Line x1={130} y1={138} x2={130} y2={152} stroke={line} strokeWidth={3} />
          <SvgText x={96} y={88} fill={colors.text} fontSize={30} fontWeight="bold" textAnchor="middle" letterSpacing={4}>
            AB7K
          </SvgText>
          <Rect x={160} y={46} width={50} height={50} rx={6} fill="#ffffff" />
          <Rect x={166} y={52} width={14} height={14} fill={colors.bg} />
          <Rect x={190} y={52} width={14} height={14} fill={colors.bg} />
          <Rect x={166} y={76} width={14} height={14} fill={colors.bg} />
          <Rect x={190} y={78} width={8} height={8} fill={colors.bg} />
        </>
      ) : name === 'phones' ? (
        <>
          <Rect x={52} y={22} width={70} height={132} rx={12} fill={faint} stroke={line} strokeWidth={2.5} transform="rotate(-8 87 88)" />
          <Rect x={138} y={22} width={70} height={132} rx={12} fill={faint} stroke={line} strokeWidth={2.5} transform="rotate(8 173 88)" />
          <Rect x={66} y={44} width={42} height={60} rx={6} fill={a} opacity={0.7} transform="rotate(-8 87 88)" />
          <Rect x={152} y={44} width={42} height={60} rx={6} fill={a} opacity={0.7} transform="rotate(8 173 88)" />
          <SvgText x={87} y={130} fill={colors.text} fontSize={13} fontWeight="bold" textAnchor="middle" transform="rotate(-8 87 88)">
            AB7K
          </SvgText>
          <SvgText x={173} y={130} fill={colors.text} fontSize={13} fontWeight="bold" textAnchor="middle" transform="rotate(8 173 88)">
            AB7K
          </SvgText>
        </>
      ) : name === 'swipe' ? (
        <>
          <Rect x={92} y={8} width={76} height={110} rx={10} fill={faint} stroke={line} strokeWidth={2.5} />
          <Rect x={102} y={18} width={56} height={62} rx={6} fill={a} opacity={0.55} />
          <Line x1={104} y1={94} x2={156} y2={94} stroke={line} strokeWidth={3} strokeLinecap="round" />
          <Line x1={104} y1={104} x2={140} y2={104} stroke={faint} strokeWidth={3} strokeLinecap="round" />
          {[
            {x: 82, c: YES, t: '✓'},
            {x: 130, c: MAYBE, t: '?'},
            {x: 178, c: NO, t: '✕'},
          ].map(b => (
            <React.Fragment key={b.t}>
              <Circle cx={b.x} cy={148} r={17} fill="none" stroke={b.c} strokeWidth={2.5} />
              <SvgText x={b.x} y={155} fill={b.c} fontSize={19} fontWeight="bold" textAnchor="middle">
                {b.t}
              </SvgText>
            </React.Fragment>
          ))}
        </>
      ) : (
        <>
          <Rect x={86} y={22} width={88} height={130} rx={10} fill={faint} stroke={line} strokeWidth={2.5} />
          <Rect x={96} y={32} width={68} height={84} rx={6} fill={a} opacity={0.55} />
          <Line x1={98} y1={130} x2={162} y2={130} stroke={line} strokeWidth={3} strokeLinecap="round" />
          <Path
            d="M196 22 l7.6 15.4 17 2.5 -12.3 12 2.9 16.9 -15.2 -8 -15.2 8 2.9 -16.9 -12.3 -12 17 -2.5 z"
            fill={colors.star}
          />
        </>
      )}
    </Svg>
  );
}

// ---------------------------------------------------------------- the choices
function SettingsGroups({
  options,
  value,
  onChange,
  first,
}: {
  options: GroupOptions | null;
  value: GroupSettings;
  onChange: (p: Partial<GroupSettings>) => void;
  first?: boolean; // the first chip claims the focus (the settings sheet)
}) {
  if (!options) return null;
  return (
    <View style={styles.groups}>
      <Group label={WORDS.kind}>
        {options.kinds.map((k, i) => (
          <Chip uiId="group.option" key={k.id} small label={k.label} on={value.kind === k.id} hasTVPreferredFocus={first && i === 0} onPress={() => onChange({kind: k.id})} />
        ))}
      </Group>
      <Group label={WORDS.mood}>
        {options.moods.map(m => (
          <Chip uiId="group.option" key={m.id} small label={m.label} on={value.mood === m.id} onPress={() => onChange({mood: m.id})} />
        ))}
      </Group>
      <Group label={WORDS.length}>
        {options.lengths.map(l => (
          <Chip uiId="group.option" key={l.id} small label={l.label} on={value.length === l.id} onPress={() => onChange({length: l.id})} />
        ))}
      </Group>
      <Group label={WORDS.time}>
        {options.limits.map(s => (
          <Chip uiId="group.option" key={s} small label={limitLabel(s)} on={value.limitSec === s} onPress={() => onChange({limitSec: s})} />
        ))}
      </Group>
    </View>
  );
}
function Group({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      <View style={styles.chips}>{children}</View>
    </View>
  );
}

// ---------------------------------------------------------------- start
function StartView({
  mainRef,
  options,
  form,
  busy,
  onChange,
  onStart,
  onJoin,
}: {
  mainRef: FocusRef;
  options: GroupOptions | null;
  form: GroupSettings;
  busy: boolean;
  onChange: (p: Partial<GroupSettings>) => void;
  onStart: () => void;
  onJoin: () => void;
}) {
  return (
    <View>
      <Text style={styles.h1}>{WORDS.feature}</Text>
      <Text style={styles.sub}>{WORDS.entryLine}</Text>
      <View style={styles.panel}>
        <SettingsGroups options={options} value={form} onChange={onChange} />
      </View>
      <View style={styles.actions}>
        <Btn uiId="group.start" ref={mainRef as never} primary icon="play" label={WORDS.startHere} hasTVPreferredFocus dim={busy} onPress={onStart} />
        <Btn uiId="group.join" icon="people" label={WORDS.joinCode} onPress={onJoin} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- lobby
function LobbyView({
  mainRef,
  session,
  options,
  busy,
  onDeal,
  onAdd,
  onSettings,
  onRole,
}: {
  mainRef: FocusRef;
  session: GroupSession;
  options: GroupOptions | null;
  busy: string | null;
  onDeal: () => void;
  onAdd: () => void;
  onSettings: () => void;
  onRole: () => void;
}) {
  const base = getBaseUrl();
  const host = !!session.you?.host;
  const voter = session.you?.role === 'voter';
  const people = peopleOf(session);
  const added = session.added.slice(-3);
  return (
    <View style={styles.lobby}>
      <View style={styles.joinPanel}>
        <Text style={styles.panelKicker}>{WORDS.joinTitle.toUpperCase()}</Text>
        <Text style={styles.code} accessibilityLabel={session.code.split('').join(' ')}>
          {session.code}
        </Text>
        <View style={styles.qr}>
          <QRCode value={joinUrl(base, session.code)} size={128} backgroundColor="#ffffff" color="#0b0c14" />
        </View>
        <Text style={styles.joinLine}>{WORDS.joinLine}</Text>
        <Text style={styles.hostLine} numberOfLines={1}>
          {hostOf(base)}
        </Text>
      </View>

      <View style={styles.lobbyMain}>
        <Text style={styles.joined} numberOfLines={1}>
          {joinedLine(session)}
        </Text>
        <View style={styles.people}>
          {people.map(m => (
            <Person key={m.id} m={m} badges={badgesOf(m, session.phase)} />
          ))}
        </View>

        <View style={styles.settingsRow}>
          <Icon name="sparkle" size={16} color={colors.accent} />
          <Text style={styles.settingsText} numberOfLines={1}>
            {settingsLine(session.settings, options)}
          </Text>
          {host ? <Btn small label={WORDS.change} onPress={onSettings} /> : null}
        </View>

        {added.length ? (
          <View style={styles.addedBox}>
            <Text style={styles.smallCaps}>{WORDS.addedSoFar.toUpperCase()}</Text>
            {added.map(a => (
              <Text key={a.key} style={styles.addedItem} numberOfLines={1}>
                {a.title}
                <Text style={styles.addedBy}>{`  ·  ${addedLine(a.by)}`}</Text>
              </Text>
            ))}
            {session.added.length > added.length ? <Text style={styles.addedBy}>{`+${session.added.length - added.length}`}</Text> : null}
          </View>
        ) : null}

        <View style={styles.actions}>
          {host ? (
            <Btn uiId="group.deal" ref={mainRef as never} primary icon="play" label={WORDS.startSwiping} hasTVPreferredFocus dim={!session.voters || busy === 'deal'} onPress={onDeal} />
          ) : null}
          <Btn uiId="group.add" ref={host ? undefined : (mainRef as never)} icon="plus" label={WORDS.addTitle} hasTVPreferredFocus={!host} onPress={onAdd} />
          <Btn uiId="group.screen" icon={voter ? 'check' : 'people'} label={voter ? WORDS.justShow : WORDS.swipeHereToo} dim={busy === 'screen'} onPress={onRole} />
        </View>
        {host && !session.voters ? <Text style={styles.hint}>{WORDS.needSomeone}</Text> : null}
        {!host ? <Text style={styles.hint}>{WORDS.onlyHost}</Text> : null}
      </View>
    </View>
  );
}

function Avatar({m, size = 40}: {m: GroupMember; size?: number}) {
  const pic = m.avatarImage ? imgSrc(m.avatarImage) : null;
  return (
    <View style={[styles.avatar, {width: size, height: size, borderRadius: size / 2}]}>
      {pic ? (
        <Image source={pic} style={{width: size, height: size}} resizeMode="cover" fadeDuration={0} />
      ) : (
        <Text style={{fontSize: Math.round(size * 0.5)}}>{m.role === 'screen' && !m.avatar ? '📺' : m.avatar || '🍿'}</Text>
      )}
    </View>
  );
}
function Person({m, badges, line}: {m: GroupMember; badges: string[]; line?: string}) {
  return (
    <View style={[styles.person, m.away && styles.personAway]}>
      <Avatar m={m} />
      <View style={styles.personText}>
        <Text style={styles.personName} numberOfLines={1}>
          {m.name}
        </Text>
        {line || badges.length ? (
          <Text style={[styles.personBadge, line === WORDS.doneBadge && {color: YES}]} numberOfLines={1}>
            {[line, ...badges.filter(b => b !== line)].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- the clock
function Clock({session, since, wide}: {session: GroupSession; since: number; wide?: boolean}) {
  const c = countdown(session, since);
  if (!session.deadline) return null;
  return (
    <View style={[styles.clock, wide && styles.clockWide]}>
      <View style={[styles.clockBar, wide && styles.clockBarWide]}>
        <View style={[styles.clockFill, {width: `${Math.round(c.frac * 1000) / 10}%`}, c.left <= 15 && styles.clockLow]} />
      </View>
      <Text style={[styles.clockText, wide && styles.clockTextWide]}>{c.text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- swiping here
function SwipeView({
  mainRef,
  session,
  card,
  since,
  canUndo,
  posterH,
  onVote,
  onUndo,
}: {
  mainRef: FocusRef;
  session: GroupSession;
  card: GroupCard | undefined;
  since: number;
  canUndo: boolean;
  posterH: number;
  onVote: (c: GroupCard, v: GroupVerdict) => void;
  onUndo: () => void;
}) {
  const posterW = Math.round((posterH * 2) / 3);
  const done = Object.keys(session.mine).length;
  if (!card) return null;
  const src = picture(card.poster, posterW);
  const seen = seenLine(card.seenBy);
  const by = addedLine(card.addedBy);
  return (
    <View>
      <View style={styles.swipeTop}>
        <Clock session={session} since={since} />
        <Text style={styles.count}>
          {Math.min(done + 1, session.deck.length)} / {session.deck.length}
        </Text>
        <Text style={styles.countDim}>{progressLine(session)}</Text>
      </View>
      <View style={styles.swipeRow}>
        <View style={[styles.poster, {width: posterW, height: posterH}]}>
          {src ? (
            <Image source={src} style={styles.fill} resizeMode="cover" fadeDuration={0} />
          ) : (
            <View style={styles.posterFallback}>
              <Text style={styles.posterFallbackText}>{card.title}</Text>
            </View>
          )}
          {card.lib ? (
            <View style={styles.libBadge}>
              <Text style={styles.libBadgeText}>{WORDS.libBadge}</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.swipeInfo}>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {card.title}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {cardMeta(card)}
          </Text>
          {card.line ? (
            <Text style={styles.cardLine} numberOfLines={3}>
              {card.line}
            </Text>
          ) : null}
          {seen ? <Text style={styles.note}>{seen}</Text> : null}
          {by ? <Text style={styles.note}>{by}</Text> : null}
          <View style={styles.actions}>
            <Btn uiId="group.yes" ref={mainRef as never} icon="check" label={WORDS.yes} hasTVPreferredFocus onPress={() => onVote(card, 'yes')} />
            <Btn uiId="group.maybe" glyph="?" label={WORDS.maybe} onPress={() => onVote(card, 'maybe')} />
            <Btn uiId="group.no" icon="close" label={WORDS.no} onPress={() => onVote(card, 'no')} />
            <Btn uiId="group.undo" small label={`↶ ${WORDS.undo}`} dim={!canUndo} onPress={onUndo} />
          </View>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- the others are swiping
function WaitingView({
  mainRef,
  session,
  since,
  busy,
  canUndo,
  onUndo,
  onExtend,
  onFinish,
  onRole,
}: {
  mainRef: FocusRef;
  session: GroupSession;
  since: number;
  busy: string | null;
  canUndo: boolean;
  onUndo: () => void;
  onExtend: () => void;
  onFinish: () => void;
  onRole: () => void;
}) {
  const host = !!session.you?.host;
  const voter = session.you?.role === 'voter';
  const people = votersOf(peopleOf(session));
  return (
    <View style={styles.waiting}>
      {voter ? <Text style={styles.waitKicker}>{WORDS.doneWaiting}</Text> : null}
      <Text style={styles.progressBig}>{progressLine(session) || WORDS.waiting}</Text>
      <Clock session={session} since={since} wide />
      <View style={[styles.people, styles.peopleCenter]}>
        {people.map(m => (
          <Person key={m.id} m={m} badges={m.away ? [WORDS.awayBadge] : []} line={personProgress(m, session.deck.length)} />
        ))}
      </View>
      <View style={[styles.actions, styles.actionsCenter]}>
        {host ? (
          <>
            <Btn uiId="group.extend" ref={mainRef as never} icon="clock" label={WORDS.oneMore} hasTVPreferredFocus dim={busy === 'extend'} onPress={onExtend} />
            <Btn uiId="group.finish" label={WORDS.showNow} dim={busy === 'finish'} onPress={onFinish} />
          </>
        ) : null}
        {voter ? <Btn uiId="group.undo" ref={host ? undefined : (mainRef as never)} hasTVPreferredFocus={!host} small label={`↶ ${WORDS.undo}`} dim={!canUndo} onPress={onUndo} /> : null}
        {voter ? <Btn uiId="group.screen" small label={WORDS.justShow} dim={busy === 'screen'} onPress={onRole} /> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- the pick
function Backdrop({card}: {card: GroupCard | null}) {
  const src = card ? picture(card.backdrop, 960) : null;
  if (!src) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Image source={src} style={[styles.fill, styles.backdropImg]} resizeMode="cover" fadeDuration={0} />
      <View style={[StyleSheet.absoluteFill, styles.veil]} />
    </View>
  );
}
function ResultView({
  mainRef,
  session,
  busy,
  posterH,
  onPlay,
  onNext,
  onAgain,
}: {
  mainRef: FocusRef;
  session: GroupSession;
  busy: string | null;
  posterH: number;
  onPlay: (key: string) => void;
  onNext: (index: number) => void;
  onAgain: () => void;
}) {
  const pick = currentPick(session);
  if (!pick) return null;
  const card = pick.card;
  const posterW = Math.round((posterH * 2) / 3);
  const src = picture(card.poster, posterW);
  const next = nextPick(session);
  const count = pickCount(session);
  return (
    <View style={styles.resultRow}>
      <View style={styles.resultText}>
        <Text style={styles.resultKicker}>
          {WORDS.resultTitle.toUpperCase()}
          {count ? <Text style={styles.resultCount}>{`   ${count}`}</Text> : null}
        </Text>
        <Text style={styles.resultTitle} numberOfLines={2}>
          {card.title}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {cardMeta(card)}
        </Text>
        {pick.why ? (
          <View style={[styles.why, pick.everyone && styles.whyAll]}>
            <Icon name="check" size={16} color={pick.everyone ? YES : colors.accent} />
            <Text style={styles.whyText}>{pick.why}</Text>
          </View>
        ) : null}
        {card.line ? (
          <Text style={styles.cardLine} numberOfLines={3}>
            {card.line}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Btn uiId="group.play" ref={mainRef as never} primary icon="play" label={playLabel(session)} hasTVPreferredFocus dim={busy === 'play'} onPress={() => onPlay(pick.key)} />
          {next ? <Btn uiId="group.next" label={next.label} dim={busy === 'next'} onPress={() => onNext(next.index)} /> : null}
          {session.you?.host ? <Btn uiId="group.again" icon="refresh" label={WORDS.again} dim={busy === 'again'} onPress={onAgain} /> : null}
        </View>
      </View>
      {src ? (
        <View style={[styles.poster, {width: posterW, height: posterH}]}>
          <Image source={src} style={styles.fill} resizeMode="cover" fadeDuration={0} />
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- calm one-liners (no match, chosen, ended)
function Calm({
  icon,
  title,
  big,
  line,
  actions,
}: {
  mainRef: FocusRef;
  icon: 'sparkle' | 'play' | 'info';
  title: string;
  big?: string;
  line?: string;
  actions: React.ReactNode;
}) {
  return (
    <View style={styles.center}>
      <View style={styles.calmIcon}>
        <Icon name={icon} size={26} color={colors.accent} />
      </View>
      <Text style={styles.calmTitle}>{title}</Text>
      {big ? (
        <Text style={styles.calmBig} numberOfLines={2}>
          {big}
        </Text>
      ) : null}
      {line ? <Text style={styles.calmLine}>{line}</Text> : null}
      <View style={[styles.actions, styles.actionsCenter]}>{actions}</View>
    </View>
  );
}

// ---------------------------------------------------------------- join with a code
function JoinSheet({onClose, onJoin}: {onClose: () => void; onJoin: (code: string) => Promise<string | null>}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    const c = tidyCode(text);
    if (!codeOk(c)) return setErr(WORDS.codeWrong);
    if (busy) return;
    setBusy(true);
    setErr('');
    const m = await onJoin(c);
    setBusy(false);
    if (m) setErr(m);
  };
  return (
    <Sheet kicker={WORDS.feature.toUpperCase()} title={WORDS.joinCode} onClose={onClose}>
      <Text style={styles.sheetText}>{WORDS.codeHelp}</Text>
      <Text style={styles.fieldLabel}>{WORDS.codeLabel}</Text>
      <TextInput
        style={[styles.input, styles.codeInput]}
        value={text}
        onChangeText={t => {
          setText(tidyCode(t));
          if (err) setErr('');
        }}
        autoFocus
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={4}
        placeholder="ABCD"
        placeholderTextColor={colors.textFaint}
        returnKeyType="go"
        onSubmitEditing={go}
      />
      {err ? <Text style={styles.sheetErr}>{err}</Text> : null}
      <View style={styles.sheetActions}>
        <Btn primary label={WORDS.join} dim={busy || !codeOk(tidyCode(text))} onPress={go} />
        <Btn label={WORDS.close} onPress={onClose} />
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------- add a title
function AddSheet({code, onClose, onAdded}: {code: string; onClose: () => void; onAdded: () => void}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<GroupSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [added, setAdded] = useState<Record<string, true>>({});
  const [err, setErr] = useState('');
  const asked = useRef(0);
  useEffect(() => {
    const words = q.trim();
    if (words.length < 2) {
      setHits([]);
      return;
    }
    const n = ++asked.current;
    const t = setTimeout(() => {
      setSearching(true);
      groupApi
        .search(code, words)
        .then(r => n === asked.current && setHits(r.results || []))
        .catch(e => n === asked.current && setErr(messageOf(e)))
        .finally(() => n === asked.current && setSearching(false));
    }, 400);
    return () => clearTimeout(t);
  }, [q, code]);
  const add = (h: GroupSearchHit) => {
    if (h.inDeck || added[h.key]) return;
    setErr('');
    groupApi
      .add(code, {id: h.id, imdbId: h.imdbId, type: h.type, title: h.title, year: h.year, poster: h.poster})
      .then(() => {
        setAdded(a => ({...a, [h.key]: true}));
        onAdded();
      })
      .catch(e => setErr(messageOf(e)));
  };
  return (
    <Sheet kicker={WORDS.feature.toUpperCase()} title={WORDS.addTitle} width={640} onClose={onClose}>
      <Text style={styles.sheetText}>{WORDS.addLine}</Text>
      <View style={styles.searchField}>
        <Icon name="search" size={18} color={colors.textFaint} />
        <TextInput
          style={styles.searchInput}
          value={q}
          onChangeText={t => {
            setQ(t);
            if (err) setErr('');
          }}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
          placeholder={WORDS.searchPlaceholder}
          placeholderTextColor={colors.textFaint}
          maxLength={80}
        />
        {searching ? <ActivityIndicator color={colors.textDim} /> : null}
      </View>
      {err ? <Text style={styles.sheetErr}>{err}</Text> : null}
      <ScrollView style={styles.hits}>
        {hits.map(h => {
          const state = h.inDeck ? WORDS.inDeck : added[h.key] ? WORDS.added : '';
          const src = picture(h.poster, 40);
          return (
            <Focusable key={h.key} noScale highlightColor={colors.surfaceHover} style={styles.hit} onPress={() => add(h)} accessibilityLabel={h.title}>
              <View style={styles.hitPoster}>{src ? <Image source={src} style={styles.fill} resizeMode="cover" fadeDuration={0} /> : null}</View>
              <View style={styles.hitText}>
                <Text style={styles.hitTitle} numberOfLines={1}>
                  {h.title}
                  {h.year ? <Text style={styles.hitYear}>{`  ${h.year}`}</Text> : null}
                </Text>
                {h.lib ? <Text style={styles.hitLib}>{WORDS.libBadge}</Text> : null}
              </View>
              {state ? <Text style={styles.hitState}>{state}</Text> : <Icon name="plus" size={18} color={colors.textDim} />}
            </Focusable>
          );
        })}
      </ScrollView>
      <View style={styles.sheetActions}>
        <Btn label={WORDS.close} onPress={onClose} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // No backgroundColor: the ambient canvas behind the navigator paints the page.
  root: {flex: 1, paddingHorizontal: spacing.pageX, paddingTop: spacing.pageY},
  body: {flex: 1},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm},
  fill: {width: '100%', height: '100%'},

  head: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 40, marginBottom: spacing.md},
  kickerRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  kicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 2.4},
  headBtns: {flexDirection: 'row', gap: spacing.sm},

  h1: {color: colors.text, fontSize: fontSize.title, lineHeight: 30, fontWeight: '900'},
  sub: {color: colors.textDim, fontSize: fontSize.body, lineHeight: 21, marginTop: 2, marginBottom: spacing.md},
  actions: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.lg},
  actionsCenter: {justifyContent: 'center'},
  hint: {color: colors.textDim, fontSize: 14, marginTop: spacing.sm},

  panel: {
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.l,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  groups: {gap: 10},
  group: {flexDirection: 'row', alignItems: 'flex-start', gap: 10},
  groupLabel: {width: 124, color: colors.textDim, fontSize: 14, fontWeight: '800', paddingTop: 9},
  chips: {flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8},

  // ---- the explanation ----
  tutRow: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xl, paddingBottom: spacing.xl},
  artPanel: {
    width: 320,
    height: 240,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.l,
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderWidth: 1,
    borderColor: colors.line,
  },
  tutText: {flex: 1},
  tutBody: {color: colors.textDim, fontSize: 17, lineHeight: 25, marginTop: spacing.sm, maxWidth: 440},
  dots: {flexDirection: 'row', gap: 6, marginBottom: spacing.md},
  dot: {width: 8, height: 8, borderRadius: 4, backgroundColor: colors.surfaceHover},
  dotOn: {width: 22, backgroundColor: colors.accent},

  // ---- lobby ----
  lobby: {flex: 1, flexDirection: 'row', gap: spacing.xl},
  joinPanel: {
    width: 260,
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: radius.l,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1,
    borderColor: colors.line,
    borderTopColor: 'rgba(255,255,255,0.18)',
    alignSelf: 'flex-start',
  },
  panelKicker: {color: colors.textDim, fontSize: 13, fontWeight: '800', letterSpacing: 2},
  code: {color: colors.text, fontSize: 54, lineHeight: 64, fontWeight: '900', letterSpacing: 10, marginLeft: 10, fontVariant: ['tabular-nums']},
  qr: {width: 146, height: 146, borderRadius: radius.m, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center', marginTop: 4},
  joinLine: {color: colors.textDim, fontSize: 14, lineHeight: 19, textAlign: 'center', marginTop: 10},
  hostLine: {color: colors.text, fontSize: 16, fontWeight: '800', marginTop: 4},
  lobbyMain: {flex: 1},
  joined: {color: colors.text, fontSize: fontSize.title, lineHeight: 30, fontWeight: '900'},
  people: {flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: spacing.md},
  peopleCenter: {justifyContent: 'center', marginTop: spacing.lg},
  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
    paddingLeft: 6,
    paddingRight: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    maxWidth: 260,
  },
  personAway: {opacity: 0.5},
  personText: {flexShrink: 1},
  personName: {color: colors.text, fontSize: 15, fontWeight: '700'},
  personBadge: {color: colors.textDim, fontSize: 13},
  avatar: {backgroundColor: colors.surfaceHover, alignItems: 'center', justifyContent: 'center', overflow: 'hidden'},
  settingsRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: spacing.lg},
  settingsText: {flexShrink: 1, color: colors.text, fontSize: 16, fontWeight: '700'},
  addedBox: {marginTop: spacing.md, gap: 2},
  smallCaps: {color: colors.textDim, fontSize: 13, fontWeight: '800', letterSpacing: 1.6, marginBottom: 2},
  addedItem: {color: colors.text, fontSize: 15, fontWeight: '600'},
  addedBy: {color: colors.textDim, fontSize: 14, fontWeight: '400'},

  // ---- the clock ----
  clock: {flexDirection: 'row', alignItems: 'center', gap: 10},
  clockWide: {justifyContent: 'center', marginTop: spacing.md},
  clockBar: {width: 180, height: 6, borderRadius: 3, backgroundColor: colors.surfaceHover, overflow: 'hidden'},
  clockBarWide: {width: 420, height: 8, borderRadius: 4},
  clockFill: {height: '100%', backgroundColor: colors.accent, borderRadius: 4},
  clockLow: {backgroundColor: MAYBE},
  clockText: {color: colors.textDim, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'], minWidth: 80},
  clockTextWide: {color: colors.text, fontSize: 18},

  // ---- swiping here ----
  swipeTop: {flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginBottom: spacing.md},
  count: {color: colors.text, fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums']},
  countDim: {color: colors.textDim, fontSize: 14},
  swipeRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.xl},
  poster: {borderRadius: radius.l, overflow: 'hidden', backgroundColor: colors.bgRaised, boxShadow: '0 18px 36px rgba(0,0,0,0.6)'},
  posterFallback: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg},
  posterFallbackText: {color: colors.textDim, fontSize: fontSize.row, fontWeight: '800', textAlign: 'center'},
  libBadge: {position: 'absolute', left: 8, top: 8, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: 'rgba(11,12,20,0.78)'},
  libBadgeText: {color: '#8cffbe', fontSize: 13, fontWeight: '800'},
  swipeInfo: {flex: 1},
  cardTitle: {color: colors.text, fontSize: 28, lineHeight: 34, fontWeight: '900'},
  meta: {color: colors.textDim, fontSize: 16, fontWeight: '600', marginTop: 4},
  cardLine: {color: colors.textDim, fontSize: 16, lineHeight: 23, marginTop: spacing.sm, maxWidth: 520},
  note: {color: colors.text, fontSize: 14, fontWeight: '600', marginTop: 6},

  // ---- waiting ----
  waiting: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  waitKicker: {color: YES, fontSize: 16, fontWeight: '700', marginBottom: 6},
  progressBig: {color: colors.text, fontSize: 44, lineHeight: 52, fontWeight: '900', fontVariant: ['tabular-nums']},

  // ---- the pick ----
  backdropImg: {opacity: 0.38},
  veil: {backgroundColor: 'rgba(11,12,20,0.55)'},
  resultRow: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xl},
  resultText: {flex: 1},
  resultKicker: {color: colors.accent, fontSize: 14, fontWeight: '800', letterSpacing: 2.4},
  resultCount: {color: colors.textDim, letterSpacing: 0.5},
  resultTitle: {color: colors.text, fontSize: 36, lineHeight: 42, fontWeight: '900', marginTop: 4},
  why: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    marginTop: spacing.md,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(139,123,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(139,123,255,0.4)',
  },
  whyAll: {backgroundColor: 'rgba(110,231,168,0.12)', borderColor: 'rgba(110,231,168,0.4)'},
  whyText: {color: colors.text, fontSize: 16, fontWeight: '700'},

  // ---- calm states ----
  calmIcon: {width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(139,123,255,0.14)', marginBottom: 6},
  calmTitle: {color: colors.text, fontSize: fontSize.title, fontWeight: '900', textAlign: 'center'},
  calmBig: {color: colors.text, fontSize: 32, lineHeight: 38, fontWeight: '900', textAlign: 'center', maxWidth: 720},
  calmLine: {color: colors.textDim, fontSize: 16, lineHeight: 23, textAlign: 'center', maxWidth: 600},

  // ---- the error line ----
  errRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: spacing.sm},
  errText: {flex: 1, color: ERR, fontSize: 15, fontWeight: '600'},

  // ---- sheets ----
  sheetText: {color: colors.textDim, fontSize: 16, lineHeight: 23},
  sheetErr: {color: ERR, fontSize: 15, fontWeight: '600', marginTop: spacing.sm},
  sheetActions: {flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg},
  fieldLabel: {color: colors.text, fontSize: 15, fontWeight: '700', marginTop: spacing.md, marginBottom: 6},
  input: {
    height: 52,
    borderRadius: radius.m,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    color: colors.text,
    paddingHorizontal: 16,
  },
  codeInput: {width: 220, fontSize: 28, fontWeight: '900', letterSpacing: 8},
  searchField: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 14,
    paddingRight: 10,
    marginTop: spacing.md,
    borderRadius: radius.m,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  searchInput: {flex: 1, color: colors.text, fontSize: 16, paddingVertical: 0},
  hits: {maxHeight: 220, marginTop: spacing.sm},
  hit: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, paddingHorizontal: 8, borderRadius: radius.m},
  hitPoster: {width: 32, height: 48, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.surfaceHover},
  hitText: {flex: 1},
  hitTitle: {color: colors.text, fontSize: 16, fontWeight: '700'},
  hitYear: {color: colors.textDim, fontWeight: '400'},
  hitLib: {color: '#8cffbe', fontSize: 13, fontWeight: '700'},
  hitState: {color: colors.textDim, fontSize: 14, fontWeight: '700'},
});
