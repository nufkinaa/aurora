// "What do we watch tonight?" — the TV as the room's main screen, in the
// Aurora Play look ("Party night", docs/play/tv.md).
//
// The TV starts a session (or joins one with a code), shows the code as a
// ticket and a QR code big enough to scan from the sofa, and the people in
// the room join on their phones — each one takes a seat. While they swipe it
// shows everyone's ribbon and the time draining; then the reveal ("The votes
// are in…", a tie-break when the top two were level, the drop, one burst) and
// the pick, with the server's why and its tally as stars, and one press plays
// it. "Swipe on this screen too" makes the TV a voter as well: the Taste deck.
//
// What is drawn follows the session (groupPick.ts stepOf, groupPickTv.ts
// viewOf); followGroup (groupPickApi.ts) keeps it live — socket + slow poll —
// and every action's own answer is handed to it (follow.take), so the screen
// never waits for the next poll to show what was just pressed.
//
// THE REMOTE. Each view's main key holds the focus as it appears (Start,
// Start swiping, More time, the card, Play…); the header's keys sit above it.
// On the deck the card holds the focus inside a focus guide that traps LEFT,
// RIGHT and DOWN: RIGHT (or OK) = Yes, LEFT = No, DOWN = Maybe, UP = Undo and
// the header. A press that only just carried focus onto the card is not an
// answer (focus.ts pressMovedFocus). BACK in a session that is still going
// asks first (Stay / Leave / End for everyone) — a stray Back never drops the
// room's screen; during the reveal BACK (or any key) skips the show. Back in
// the explanation opened from "How it works" closes it. Anywhere else Back
// leaves the screen; the live follow stops on unmount (the server marks this
// box away by itself).
//
// THE SHOW. Once per result, and only on a screen that saw the vote end (a
// late join or a restart gets the still page), the reveal plays over the
// finished result; the burst is its one reward. Skipping it gives the burst
// up. "Something else" is a quick change of the card: no show, no burst.
// Calm (Remove animations, a lite box): no show, nothing pops, the tie is a
// line, the time ribbon steps.
//
// PLAY. The room's screen is where the film plays (groupPick.ts playsHere):
// on this TV as the screen, Play — or anyone's Play on their phone — starts
// the title here once per chosen session (groupPickTv.ts autoStart). A library
// film goes straight to the player; a series or a catalogue title opens its
// title page (routeFor), replacing this screen: the evening is decided.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Animated, BackHandler, Image, ScrollView, StyleSheet, Text, TextInput, TVFocusGuideView, View} from 'react-native';
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
import {noteOwnFocusMove, pressMovedFocus, useFocusFallback, useTVKeys} from '../focus';
import {uiHit} from '../telemetry'; // [analytics]
import {
  GroupCard,
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
  chosenKey,
  countdown,
  firstSettings,
  nextPick,
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
import {EASE, LINEAR, SPRING, tween, useCalm, useInFront, useTimers, useValue} from '../play/anim';
import Burst from '../play/Burst';
import {Answer, Plates, Shade, Stamp, Tile} from '../play/Cards';
import {answerRun, depthOf, layerAt, PEEK} from '../play/deck';
import Meter from '../play/Meter';
import {Rise, useEnter} from '../play/Motion';
import PlayKey from '../play/PlayKey';
import Room from '../play/Room';
import {Glow, Star} from '../play/Star';
import {isTie} from '../play/tally';
import {PLAY, T} from '../play/tokens';
import {Poster} from '../play/wrapped/parts';
import {SHOW, tieSides, verdictForGroupKey} from '../play/groupShow';
import {Duel, Reveal, Seats, TallyStars, Ticket, seatBadge} from '../play/group/parts';

const {colors, spacing, radius} = theme;
const ERR = '#ff9b9b';
const RUN = answerRun(T.slam, T.throw); // the stops of an answer's one run
const STAMP: Record<GroupVerdict, string> = {yes: 'YES', no: 'NO', maybe: 'MAYBE'};
const INK: Record<GroupVerdict, string> = {yes: PLAY.yes, no: PLAY.no, maybe: PLAY.maybe};
const HEAD_H = 54; // the header row and the air under it
const TOP_H = 46; // the deck's own top row (the time, the count, Undo)
const FOOT_H = 64; // "Maybe" and the card's line, under the deck

type Props = NativeStackScreenProps<RootStackParamList, 'GroupPick'>;
type SheetKind = null | 'join' | 'add' | 'settings' | 'leave';
type FocusRef = React.RefObject<{requestTVFocus?: () => void} | null>;
type Leaving = {card: GroupCard; verdict: GroupVerdict; n: number};

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
  const calm = useCalm();
  const calmRef = useRef(calm);
  calmRef.current = calm;
  const inFront = useInFront(navigation as never);
  const timers = useTimers();
  const seen = useRef(new Set<string>()); // who has had their seat's entrance

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
  // a new round (Swipe another round) starts with nothing to undo
  const round = raw ? `${raw.code}:${raw.round}` : '';
  useEffect(() => {
    history.current = [];
  }, [round]);
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

  // ---------- the deck's motion (the same run as Taste's) ----------
  const out = useValue(0); // the answered card: 0 -> 1 (stamped, then thrown)
  const pop = useValue(1); // the next card coming up: 0 -> 1
  const hitNo = useValue(0); // the answers' labels: lit for a moment
  const hitYes = useValue(0);
  const hitMaybe = useValue(0);
  const flights = useRef(0);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const arrive = useCallback(
    (delay = 0) => {
      pop.stopAnimation();
      pop.setValue(0);
      tween(pop, 1, calmRef.current ? 120 : T.rise, {delay: calmRef.current ? 0 : delay}).start();
    },
    [pop],
  );
  const fly = useCallback(
    (card: GroupCard, verdict: GroupVerdict) => {
      const lit = verdict === 'yes' ? hitYes : verdict === 'no' ? hitNo : hitMaybe;
      if (!calmRef.current) {
        lit.stopAnimation();
        lit.setValue(0);
        Animated.sequence([tween(lit, 1, 90), tween(lit, 0, 170)]).start();
      }
      out.stopAnimation();
      out.setValue(0);
      const n = ++flights.current;
      setLeaving({card, verdict, n});
      // finished or cut short, this flight's card goes; a newer one stays
      tween(out, 1, calmRef.current ? 140 : RUN.total, {easing: calmRef.current ? EASE : LINEAR}).start(() =>
        setLeaving(l => (l && l.n === n ? null : l)),
      );
      arrive(T.slam);
    },
    [out, arrive, hitYes, hitNo, hitMaybe],
  );

  const vote = useCallback(
    (card: GroupCard, verdict: GroupVerdict) => {
      if (!code) return;
      history.current.push(card.key);
      setLocal(l => ({...l, [card.key]: verdict}));
      setErr('');
      fly(card, verdict);
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
    [code, fly],
  );
  const cardRef = useRef<View>(null);
  const cardFocused = useRef(false);
  const undo = useCallback(() => {
    if (!code || !session) return;
    const {key, history: rest} = undoTarget(history.current, session.mine);
    history.current = rest;
    if (!key) return;
    setLocal(l => ({...l, [key]: null}));
    setLeaving(null);
    arrive();
    // back to the card it brought back (Undo was pressed up above it)
    setTimeout(() => {
      const node = cardRef.current as unknown as {requestTVFocus?: () => void} | null;
      if (node?.requestTVFocus) {
        noteOwnFocusMove();
        node.requestTVFocus();
      }
    }, 0);
    groupApi
      .vote(code, key, null)
      .then(() => follow.current?.refresh())
      .catch(e => setErr(messageOf(e)));
  }, [code, session, arrive]);

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

  // ---------- the reveal ----------
  // Once per result, only for a screen that saw the vote (the deck or the
  // others' ribbons) — a late join or a restart opens on the still page.
  const sawVoting = useRef(false);
  const shownFor = useRef<number | null>(null);
  const [showing, setShowing] = useState<number | null>(null);
  const [drop, setDrop] = useState({run: 0, index: -1});
  const [fire, setFire] = useState(0);
  const resultAt = view === 'result' && session?.result ? Number(session.result.at) || 0 : null;
  const resultAtRef = useRef(resultAt);
  resultAtRef.current = resultAt;
  const hasPick = !!(session && currentPick(session));
  useEffect(() => {
    if (view === 'swipe' || view === 'waiting') sawVoting.current = true;
    if (resultAt === null) return;
    if (sawVoting.current && shownFor.current !== resultAt && !calm && hasPick) {
      shownFor.current = resultAt;
      setShowing(resultAt);
    }
    sawVoting.current = false;
  }, [view, resultAt, calm, hasPick]);
  // The curtain is up from the very first frame of the result (the effect above
  // would leave one frame of the bare result, keys and all, before it).
  const due = resultAt !== null && sawVoting.current && shownFor.current !== resultAt && !calm && hasPick;
  const curtain = showing !== null ? showing : due ? resultAt : null;
  // a result that has gone (another round, the session ended) takes its show along
  useEffect(() => {
    if (showing !== null && resultAt !== showing) setShowing(null);
  }, [showing, resultAt]);
  const endShow = useCallback(
    (lifted: boolean) => {
      if (resultAtRef.current !== null) shownFor.current = resultAtRef.current;
      sawVoting.current = false;
      setShowing(null);
      // Play holds the focus again (the curtain's Skip has gone)
      timers.after(0, () => {
        if (mainRef.current?.requestTVFocus) {
          noteOwnFocusMove();
          mainRef.current.requestTVFocus();
        }
      });
      if (!lifted) return;
      // the drop, and the one meteor burst from the poster
      setDrop(d => ({run: d.run + 1, index: session?.result?.index ?? 0}));
      timers.after(440, () => setFire(f => f + 1));
    },
    [timers, session],
  );

  // The deck's last answer unmounts the card under the focus; Android would
  // hand it to whatever is nearest. The next view's main key takes it (the
  // reveal hands it over itself when its curtain lifts).
  // The deck's last answer: its card finishes its flight on the deck before
  // the next view takes the page (most of the time the result is in by then,
  // and "waiting" never flashes up for a moment in between).
  const shownView = view === 'waiting' && leaving && raw?.phase === 'swiping' ? 'swipe' : view;
  const lastView = useRef(shownView);
  useEffect(() => {
    const was = lastView.current;
    lastView.current = shownView;
    if (was !== 'swipe' || shownView === 'swipe' || sheet) return;
    return timers.after(60, () => {
      if (backState.current.showing) return;
      if (mainRef.current?.requestTVFocus) {
        noteOwnFocusMove();
        mainRef.current.requestTVFocus();
      }
    });
  }, [shownView, sheet, timers]);

  // ---------- BACK ----------
  const backState = useRef({sheet, tutorial, live: false, showing: false});
  backState.current = {sheet, tutorial, live: sessionLive(raw, lost), showing: curtain !== null};
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!navigation.isFocused()) return false;
      const b = backState.current;
      if (b.sheet) return false; // the sheet's own Back closes it
      if (b.showing) {
        endShow(false); // the show is not a resting state: Back skips it
        return true;
      }
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
  }, [navigation, endShow]);

  // ---------- the remote on the deck ----------
  const left = shownView === 'swipe' && session ? unanswered(session) : [];
  const card = left[0];
  const voteRef = useRef(vote);
  voteRef.current = vote;
  const cardNow = useRef(card);
  cardNow.current = card;
  useTVKeys(
    useCallback((evt: {eventType: string}) => {
      if (!cardFocused.current || !cardNow.current) return;
      // not the release of the press that carried focus onto the card
      if (pressMovedFocus()) return;
      const v = verdictForGroupKey(evt.eventType);
      if (!v) return;
      uiHit(v === 'yes' ? 'group.yes' : v === 'no' ? 'group.no' : 'group.maybe'); // [analytics]
      voteRef.current(cardNow.current, v);
    }, []),
  );

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
  const since = Date.now() - (follow.current?.receivedAt() ?? Date.now());

  let body: React.ReactNode = null;
  if (view === 'loading') {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={PLAY.ink} />
      </View>
    );
  } else if (view === 'failed') {
    body = <ErrorState message={WORDS.noReach} onAction={loadOptions} edgeLeft={false} />;
  } else if (view === 'tutorial') {
    body = <Tutorial mainRef={mainRef} calm={calm} onDone={finishTutorial} />;
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
        calm={calm}
        seen={seen}
        onDeal={() => {
          if (!session.voters) return setErr(WORDS.needSomeone);
          run('deal', () => groupApi.start(session.code));
        }}
        onAdd={() => setSheet('add')}
        onSettings={() => setSheet('settings')}
        onRole={() => run('screen', () => groupApi.role(session.code, session.you?.role === 'voter' ? 'screen' : 'voter'))}
      />
    );
  } else if (session && shownView === 'swipe') {
    const room = height - spacing.pageY - safeBottom - HEAD_H - TOP_H - PEEK - FOOT_H;
    const cardH = Math.max(200, Math.min(Math.round(height * 0.6), room));
    body = (
      <DeckView
        session={session}
        card={card}
        next={left[1]}
        left={left.length}
        since={since}
        calm={calm}
        cardH={cardH}
        canUndo={history.current.length > 0}
        leaving={leaving}
        out={out}
        pop={pop}
        hits={{yes: hitYes, no: hitNo, maybe: hitMaybe}}
        cardRef={cardRef}
        onCardFocus={f => {
          cardFocused.current = f;
        }}
        onYes={() => card && vote(card, 'yes')}
        onUndo={undo}
      />
    );
  } else if (session && view === 'waiting') {
    body = (
      <WaitingView
        mainRef={mainRef}
        session={session}
        since={since}
        busy={busy}
        calm={calm}
        seen={seen}
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
        calm={calm}
        posterH={Math.round(height * 0.58)}
        hidden={curtain !== null}
        drop={drop}
        fire={fire}
        onPlay={play}
        onNext={i => run('next', () => groupApi.pick(session.code, i))}
        onAgain={() => run('again', () => groupApi.again(session.code))}
      />
    );
  } else if (session && view === 'nomatch') {
    body = (
      <Calm
        glyph="✦"
        title={WORDS.noMatch}
        line={isHost ? WORDS.noMatchLine : WORDS.onlyHost}
        actions={
          isHost ? (
            <PlayKey uiId="group.again" ref={mainRef} kind="aurora" big glyph="↻" label={WORDS.again} hasTVPreferredFocus dim={busy === 'again'} onPress={() => run('again', () => groupApi.again(session.code))} />
          ) : (
            <PlayKey uiId="group.leave" ref={mainRef} label={WORDS.leave} hasTVPreferredFocus onPress={() => leave(false)} />
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
        glyph="▶"
        title={WORDS.enjoy}
        big={c?.card.title}
        poster={c?.card || null}
        line={[c ? `${c.by} ${WORDS.pressedPlay}` : '', !here && scr ? (scr.app === 'tv' ? WORDS.startingOnTv : WORDS.startingOnScreen) : ''].filter(Boolean).join(' · ')}
        actions={
          <>
            {here && c ? <PlayKey uiId="group.play" kind="gold" big glyph="▶" label={WORDS.play} onPress={() => startCard(c.card)} /> : null}
            <PlayKey uiId="group.leave" ref={mainRef} label={WORDS.leave} hasTVPreferredFocus={!here} onPress={() => leave(false)} />
          </>
        }
      />
    );
  } else if (view === 'ended') {
    body = (
      <Calm
        glyph="☾"
        title={WORDS.ended}
        line={lost || session?.ended?.reason || ''}
        actions={<PlayKey uiId="group.leave" ref={mainRef} label={WORDS.leave} hasTVPreferredFocus onPress={() => leave(false)} />}
      />
    );
  }

  // the show's tie-break: the two posters, the server's pick on its side
  const duel: Duel = useMemo(() => {
    const r = session?.result;
    if (curtain === null || !r || !isTie(r) || !r.picks[1]?.card) return null;
    const {swap, winner} = tieSides(r.at);
    const a = r.picks[0].card;
    const b = r.picks[1].card;
    return {posters: swap ? [b, a] : [a, b], winner};
  }, [curtain, session]);

  return (
    <View style={[styles.root, {paddingBottom: safeBottom}]}>
      <Room on={inFront && curtain === null} calm={calm} />
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
      {curtain !== null ? (
        <View style={styles.curtain}>
          <Reveal key={curtain} duel={duel} onEnd={endShow} inFront={inFront} />
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
        <Sheet kicker={WORDS.entry.toUpperCase()} width={760} onClose={() => setSheet(null)}>
          <SettingsGroups options={options} value={session.settings} onChange={p => run('option', () => groupApi.settings(session.code, p))} first />
          <View style={styles.sheetActions}>
            <Btn label={WORDS.close} onPress={() => setSheet(null)} />
          </View>
        </Sheet>
      ) : null}
      {sheet === 'leave' ? (
        <Sheet kicker={WORDS.entry.toUpperCase()} title={WORDS.leaveAsk} onClose={() => setSheet(null)}>
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
        <Star size={14} color={PLAY.gold} />
        <Text style={styles.kicker}>{WORDS.entry.toUpperCase()}</Text>
      </View>
      <View style={styles.headBtns}>
        {showHowto ? <PlayKey uiId="group.howto" small glyph="?" label={WORDS.howItWorks} onPress={onHowto} /> : null}
        {/* asks first (the sheet holds Leave and End for everyone) */}
        {showLeave ? <PlayKey small label={WORDS.leave} hasTVPreferredFocus={claimLeave} onPress={onLeave} /> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- the explanation
function Tutorial({mainRef, calm, onDone}: {mainRef: FocusRef; calm: boolean; onDone: () => void}) {
  const [i, setI] = useState(0);
  const step = TUTORIAL[i];
  const last = i === TUTORIAL.length - 1;
  return (
    <View style={styles.tutRow}>
      <Rise run={i} calm={calm} dy={8} style={styles.artPanel}>
        <Art name={step.art} />
      </Rise>
      <View style={styles.tutText}>
        <View style={styles.dots}>
          {TUTORIAL.map((_, n) => (
            <View key={n} style={[styles.dot, n <= i && styles.dotLit, n === i && styles.dotOn]} />
          ))}
        </View>
        <Rise run={i} calm={calm}>
          <Text style={styles.h1}>{step.title}</Text>
        </Rise>
        <Rise run={i} i={1} calm={calm}>
          <Text style={styles.tutBody}>{step.body}</Text>
        </Rise>
        <View style={styles.actions}>
          <PlayKey
            uiId="group.tutorial.next"
            ref={mainRef as never}
            kind="aurora"
            big
            label={last ? WORDS.letsGo : WORDS.next}
            hasTVPreferredFocus
            onPress={() => (last ? onDone() : setI(i + 1))}
          />
          {last ? null : <PlayKey uiId="group.tutorial.skip" label={WORDS.skip} onPress={onDone} />}
        </View>
      </View>
    </View>
  );
}

// Four calm line drawings, one per step (TUTORIAL[].art), in the night sky's colours.
function Art({name}: {name: 'tv' | 'phones' | 'swipe' | 'result'}) {
  const line = 'rgba(232,228,255,0.55)';
  const faint = 'rgba(232,228,255,0.1)';
  const a = PLAY.violet;
  return (
    <Svg width={260} height={176} viewBox="0 0 260 176">
      {name === 'tv' ? (
        <>
          <Rect x={30} y={18} width={200} height={120} rx={12} fill={faint} stroke={line} strokeWidth={2.5} />
          <Line x1={100} y1={152} x2={160} y2={152} stroke={line} strokeWidth={3} strokeLinecap="round" />
          <Line x1={130} y1={138} x2={130} y2={152} stroke={line} strokeWidth={3} />
          <SvgText x={96} y={88} fill={PLAY.gold} fontSize={30} fontWeight="bold" textAnchor="middle" letterSpacing={4}>
            AB7K
          </SvgText>
          <Rect x={160} y={46} width={50} height={50} rx={6} fill="#ffffff" />
          <Rect x={166} y={52} width={14} height={14} fill={PLAY.night1} />
          <Rect x={190} y={52} width={14} height={14} fill={PLAY.night1} />
          <Rect x={166} y={76} width={14} height={14} fill={PLAY.night1} />
          <Rect x={190} y={78} width={8} height={8} fill={PLAY.night1} />
        </>
      ) : name === 'phones' ? (
        <>
          <Rect x={52} y={22} width={70} height={132} rx={12} fill={faint} stroke={line} strokeWidth={2.5} transform="rotate(-8 87 88)" />
          <Rect x={138} y={22} width={70} height={132} rx={12} fill={faint} stroke={line} strokeWidth={2.5} transform="rotate(8 173 88)" />
          <Rect x={66} y={44} width={42} height={60} rx={6} fill={a} opacity={0.75} transform="rotate(-8 87 88)" />
          <Rect x={152} y={44} width={42} height={60} rx={6} fill={PLAY.teal} opacity={0.75} transform="rotate(8 173 88)" />
          <SvgText x={87} y={130} fill={PLAY.ink} fontSize={13} fontWeight="bold" textAnchor="middle" transform="rotate(-8 87 88)">
            AB7K
          </SvgText>
          <SvgText x={173} y={130} fill={PLAY.ink} fontSize={13} fontWeight="bold" textAnchor="middle" transform="rotate(8 173 88)">
            AB7K
          </SvgText>
        </>
      ) : name === 'swipe' ? (
        <>
          <Rect x={92} y={8} width={76} height={110} rx={10} fill={faint} stroke={line} strokeWidth={2.5} />
          <Rect x={102} y={18} width={56} height={62} rx={6} fill={a} opacity={0.6} />
          <Line x1={104} y1={94} x2={156} y2={94} stroke={line} strokeWidth={3} strokeLinecap="round" />
          <Line x1={104} y1={104} x2={140} y2={104} stroke={faint} strokeWidth={3} strokeLinecap="round" />
          {[
            {x: 82, c: PLAY.no, t: '✕'},
            {x: 130, c: PLAY.maybe, t: '?'},
            {x: 178, c: PLAY.yes, t: '✓'},
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
          <Rect x={86} y={22} width={88} height={130} rx={10} fill={faint} stroke={PLAY.gold} strokeWidth={2.5} />
          <Rect x={96} y={32} width={68} height={84} rx={6} fill={a} opacity={0.6} />
          <Line x1={98} y1={130} x2={162} y2={130} stroke={line} strokeWidth={3} strokeLinecap="round" />
          <Path d="M196 22 l7.6 15.4 17 2.5 -12.3 12 2.9 16.9 -15.2 -8 -15.2 8 2.9 -16.9 -12.3 -12 17 -2.5 z" fill={PLAY.gold} />
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
      <Text style={styles.groupLabel}>{label.toUpperCase()}</Text>
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
        <PlayKey uiId="group.start" ref={mainRef as never} kind="aurora" big star label={WORDS.startHere} hasTVPreferredFocus dim={busy} onPress={onStart} />
        <PlayKey uiId="group.join" label={WORDS.joinCode} onPress={onJoin} />
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
  calm,
  seen,
  onDeal,
  onAdd,
  onSettings,
  onRole,
}: {
  mainRef: FocusRef;
  session: GroupSession;
  options: GroupOptions | null;
  busy: string | null;
  calm: boolean;
  seen: React.MutableRefObject<Set<string>>;
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
        <Ticket code={session.code} calm={calm} />
        <View style={styles.qr}>
          <QRCode value={joinUrl(base, session.code)} size={120} backgroundColor="#ffffff" color="#0b0c14" />
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
        <View style={styles.seatsBox}>
          <Seats people={people} seen={seen} calm={calm} room badgeOf={m => seatBadge(m, false, 0)} />
        </View>

        <View style={styles.settingsRow}>
          <Star size={14} color={PLAY.teal} />
          <Text style={styles.settingsText} numberOfLines={1}>
            {settingsLine(session.settings, options)}
          </Text>
          {host ? <PlayKey small label={WORDS.change} onPress={onSettings} /> : null}
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
            <PlayKey uiId="group.deal" ref={mainRef as never} kind="aurora" big star label={WORDS.startSwiping} hasTVPreferredFocus dim={!session.voters || busy === 'deal'} onPress={onDeal} />
          ) : null}
          <PlayKey uiId="group.add" ref={host ? undefined : (mainRef as never)} glyph="+" label={WORDS.addTitle} hasTVPreferredFocus={!host} onPress={onAdd} />
          <PlayKey uiId="group.screen" glyph={voter ? '✓' : undefined} label={voter ? WORDS.justShow : WORDS.swipeHereToo} dim={busy === 'screen'} onPress={onRole} />
        </View>
        {host && !session.voters ? <Text style={styles.hint}>{WORDS.needSomeone}</Text> : null}
        {!host ? <Text style={styles.hint}>{WORDS.onlyHost}</Text> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- the clock
function Clock({session, since, calm, width, big}: {session: GroupSession; since: number; calm: boolean; width: number; big?: boolean}) {
  if (!session.deadline) return null;
  const c = countdown(session, since);
  return (
    <View style={[styles.clock, big && styles.clockBig]}>
      {/* steps once a second, no tween: a second is about a dot of ribbon, and a
          tween every second would keep the TV drawing for the whole round */}
      <Meter value={c.frac} width={width} height={big ? 10 : 7} calm tint={c.left <= 15 ? PLAY.rose : undefined} />
      <Text style={[styles.clockText, big && styles.clockTextBig, c.left <= 15 && styles.clockLow]}>{c.text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- swiping here: the deck
// What a card shows: its poster (or a tile), and on its foot, over the baked
// shade, the title and what it is; the On Aurora badge.
const CardFace = React.memo(function CardFace({card, width}: {card: GroupCard; width: number}) {
  const src = picture(card.poster, width);
  const meta = cardMeta(card);
  return (
    <>
      {src ? <Image source={src} style={styles.poster} resizeMode="cover" fadeDuration={0} /> : <Tile style={styles.poster} />}
      <Shade height="56%" />
      {card.lib ? (
        <View style={styles.libBadge}>
          <Text style={styles.libBadgeText}>{WORDS.libBadge}</Text>
        </View>
      ) : null}
      <View style={styles.foot}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {card.title}
        </Text>
        {meta ? (
          <Text style={styles.cardMeta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
    </>
  );
});

function DeckView({
  session,
  card,
  next,
  left,
  since,
  calm,
  cardH,
  canUndo,
  leaving,
  out,
  pop,
  hits,
  cardRef,
  onCardFocus,
  onYes,
  onUndo,
}: {
  session: GroupSession;
  card: GroupCard | undefined;
  next: GroupCard | undefined;
  left: number;
  since: number;
  calm: boolean;
  cardH: number;
  canUndo: boolean;
  leaving: Leaving | null;
  out: Animated.Value;
  pop: Animated.Value;
  hits: Record<GroupVerdict, Animated.Value>;
  cardRef: React.RefObject<View | null>;
  onCardFocus: (f: boolean) => void;
  onYes: () => void;
  onUndo: () => void;
}) {
  const cardW = Math.round((cardH * 2) / 3);
  const deckN = session.deck.length;
  const handN = Math.max(1, Math.min(deckN, deckN - left + 1));
  const behindAt = layerAt(0, cardH);
  const nextSrc = next ? picture(next.poster, cardW) : null;
  const seen = card ? seenLine(card.seenBy) : '';
  const by = card ? addedLine(card.addedBy) : '';
  const leaveStyle = leaving
    ? (() => {
        if (calm) return {opacity: out.interpolate({inputRange: [0, 1], outputRange: [1, 0]})};
        const dir = leaving.verdict === 'yes' ? 1 : leaving.verdict === 'no' ? -1 : 0;
        const along = (reach: number) => out.interpolate({inputRange: RUN.travel.inputRange, outputRange: RUN.travel.outputRange.map(p => +(p * reach).toFixed(1))});
        return {
          opacity: out.interpolate(RUN.fade),
          transform: [
            {translateX: along(dir * cardW * 2.4)},
            {translateY: along(dir ? -cardH * 0.08 : cardH * 1.1)},
            {rotate: out.interpolate({inputRange: RUN.travel.inputRange, outputRange: RUN.travel.outputRange.map(p => `${(p * dir * 16).toFixed(2)}deg`)})},
          ],
        };
      })()
    : null;
  const stampStyle = calm ? null : {opacity: out.interpolate(RUN.stampIn), transform: [{scale: out.interpolate(RUN.stampScale)}]};
  const popStyle = calm
    ? {opacity: pop.interpolate({inputRange: [0, 1], outputRange: [0.4, 1]})}
    : {
        transform: [
          {translateY: pop.interpolate({inputRange: [0, 1], outputRange: [PEEK / 2, 0]})},
          {scale: pop.interpolate({inputRange: [0, 1], outputRange: [behindAt.scale, 1]})},
        ],
      };
  const veilStyle = {opacity: calm ? 0 : pop.interpolate({inputRange: [0, 1], outputRange: [0.55, 0]})};
  return (
    <View style={styles.deck}>
      <View style={styles.deckTop}>
        <Clock session={session} since={since} calm={calm} width={200} />
        <Text style={styles.hand}>{SHOW.card(handN, deckN)}</Text>
        <Text style={styles.countDim} numberOfLines={1}>
          {progressLine(session)}
        </Text>
        <View style={styles.grow} />
        {/* always there (dim with nothing to undo): a key that vanished under the focus would drop it */}
        <PlayKey uiId="group.undo" small glyph="↶" label={WORDS.undo} dim={!canUndo} onPress={onUndo} />
      </View>
      <View style={styles.band}>
        <View style={styles.arena}>
          <Answer glyph="◀" label={WORDS.no} color={INK.no} hit={hits.no} side="left" />
          <View style={{width: cardW, height: cardH + PEEK}}>
            <Plates left={depthOf(left)} width={cardW} height={cardH} />
            {next ? (
              <View renderToHardwareTextureAndroid
                  pointerEvents="none" style={[styles.card, {width: cardW, height: cardH, transform: [{translateY: behindAt.translateY}, {scale: behindAt.scale}]}]}>
                {nextSrc ? <Image source={nextSrc} style={styles.poster} resizeMode="cover" fadeDuration={0} /> : <Tile style={styles.poster} />}
                <View style={[styles.veil, styles.veilOn]} />
              </View>
            ) : null}
            <TVFocusGuideView trapFocusLeft trapFocusRight trapFocusDown style={{position: 'absolute', left: 0, top: 0, width: cardW, height: cardH}}>
              {card ? (
                <Focusable
                  ref={cardRef as never}
                  uiId="group.yes"
                  hasTVPreferredFocus
                  scaleTo={1.02}
                  accessibilityLabel={`${card.title}. Right or OK: yes. Left: no. Down: maybe.`}
                  onFocusChange={onCardFocus}
                  onPress={onYes}
                  style={[styles.card, {width: cardW, height: cardH}]}>
                  <Animated.View renderToHardwareTextureAndroid style={[styles.fill, popStyle]}>
                    <CardFace card={card} width={cardW} />
                    <Animated.View pointerEvents="none" style={[styles.veil, veilStyle]} />
                  </Animated.View>
                </Focusable>
              ) : leaving ? null : (
                <View style={[styles.card, styles.waitingCard, {width: cardW, height: cardH}]}>
                  <ActivityIndicator color={PLAY.ink} />
                </View>
              )}
            </TVFocusGuideView>
            {leaving ? (
              <Animated.View renderToHardwareTextureAndroid pointerEvents="none" style={[styles.leaving, {width: cardW, height: cardH}, leaveStyle]}>
                <View style={[styles.card, {width: cardW, height: cardH}]}>
                  <CardFace card={leaving.card} width={cardW} />
                </View>
                <Animated.View
                  style={[styles.stampAt, leaving.verdict === 'yes' ? styles.stampYes : leaving.verdict === 'no' ? styles.stampNo : styles.stampMaybe, stampStyle]}>
                  <Stamp label={STAMP[leaving.verdict]} color={INK[leaving.verdict]} tilt={leaving.verdict === 'yes' ? -10 : leaving.verdict === 'no' ? 10 : 0} size={leaving.verdict === 'maybe' ? 22 : 30} />
                </Animated.View>
              </Animated.View>
            ) : null}
          </View>
          <Answer glyph="▶" label={WORDS.yes} color={INK.yes} hit={hits.yes} side="right" />
        </View>
        <View style={styles.under}>
          <Answer glyph="▼" label={WORDS.maybe} color={INK.maybe} hit={hits.maybe} side="down" />
          {card && (card.line || seen || by) ? (
            <Text style={styles.line} numberOfLines={2}>
              {[card.line, [by, seen].filter(Boolean).join(' · ')].filter(Boolean).join('  —  ')}
            </Text>
          ) : null}
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
  calm,
  seen,
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
  calm: boolean;
  seen: React.MutableRefObject<Set<string>>;
  canUndo: boolean;
  onUndo: () => void;
  onExtend: () => void;
  onFinish: () => void;
  onRole: () => void;
}) {
  const host = !!session.you?.host;
  const voter = session.you?.role === 'voter';
  const people = votersOf(peopleOf(session));
  const deck = session.deck.length;
  return (
    <View style={styles.waiting}>
      {voter ? <Text style={styles.waitKicker}>{WORDS.doneWaiting}</Text> : null}
      <Text style={styles.progressBig}>{progressLine(session) || WORDS.waiting}</Text>
      <Clock session={session} since={since} calm={calm} width={420} big />
      <View style={styles.waitSeats}>
        <Seats people={people} seen={seen} calm={calm} deck={deck} center badgeOf={m => seatBadge(m, true, deck)} />
      </View>
      <View style={[styles.actions, styles.actionsCenter]}>
        {host ? (
          <>
            <PlayKey uiId="group.extend" ref={mainRef as never} glyph="+" label={WORDS.oneMore} hasTVPreferredFocus dim={busy === 'extend'} onPress={onExtend} />
            <PlayKey uiId="group.finish" kind="aurora" star label={WORDS.showNow} dim={busy === 'finish'} onPress={onFinish} />
          </>
        ) : null}
        {voter ? <PlayKey uiId="group.undo" ref={host ? undefined : (mainRef as never)} hasTVPreferredFocus={!host} small glyph="↶" label={WORDS.undo} dim={!canUndo} onPress={onUndo} /> : null}
        {voter ? <PlayKey uiId="group.screen" small label={WORDS.justShow} dim={busy === 'screen'} onPress={onRole} /> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- the pick
// The poster falls into place once, at the end of the show (`drop`): a short
// fall with a spring. Any other change of the card (Something else) is a
// quick fade, no fall.
function Drop({run, falls, calm, children}: {run: string; falls: boolean; calm: boolean; children: React.ReactNode}) {
  const v = useEnter(run, {ms: falls ? 620 : 260, easing: falls ? SPRING : EASE, calm});
  return (
    <Animated.View
      style={{
        opacity: v.interpolate({inputRange: [0, falls ? 0.25 : 1, 1], outputRange: [0, 1, 1], extrapolate: 'clamp'}),
        transform: falls
          ? [{translateY: v.interpolate({inputRange: [0, 1], outputRange: [-70, 0]})}, {scale: v.interpolate({inputRange: [0, 1], outputRange: [1.12, 1]})}]
          : [{translateY: v.interpolate({inputRange: [0, 1], outputRange: [8, 0]})}],
      }}>
      {children}
    </Animated.View>
  );
}

function ResultView({
  mainRef,
  session,
  busy,
  calm,
  posterH,
  hidden,
  drop,
  fire,
  onPlay,
  onNext,
  onAgain,
}: {
  mainRef: FocusRef;
  session: GroupSession;
  busy: string | null;
  calm: boolean;
  posterH: number;
  hidden: boolean; // under the reveal's curtain: no keys yet (OK must not press Play under it)
  drop: {run: number; index: number};
  fire: number;
  onPlay: (key: string) => void;
  onNext: (index: number) => void;
  onAgain: () => void;
}) {
  const [at, setAt] = useState({x: 0, y: 0});
  const pick = currentPick(session);
  if (!pick) return null;
  const r = session.result;
  const index = r?.index ?? 0;
  const card = pick.card;
  const posterW = Math.round((posterH * 2) / 3);
  const next = nextPick(session);
  const count = pickCount(session);
  const fresh = drop.run > 0 && drop.index === index && !calm;
  const tieLine = !!r && index === 0 && isTie(r) && !fresh;
  return (
    <View style={styles.resultRow}>
      {/* the words come up together, as the poster lands */}
      {/* Under the curtain the words and the poster wait unseen: they come in
          with the drop (or at once when the show was skipped), never seen,
          gone and back. */}
      <Rise run={`${drop.run}:${index}`} calm={calm || !fresh} delay={fresh ? 180 : 0} dy={16} style={[styles.resultText, hidden && styles.unseen]}>
        <View style={styles.prizeKicker}>
          <Star size={15} color={PLAY.gold} />
          <Text style={styles.resultKicker}>{WORDS.resultTitle.toUpperCase()}</Text>
          {count ? <Text style={styles.resultCount}>{count}</Text> : null}
        </View>
        <Text style={styles.resultTitle} numberOfLines={2}>
          {card.title}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {cardMeta(card)}
        </Text>
        <View style={styles.tallyRow}>
          <TallyStars pick={pick} fresh={fresh} calm={calm} />
          {pick.why ? (
            <View style={[styles.why, pick.everyone && styles.whyAll]}>
              <Text style={[styles.whyText, styles.whyTick, pick.everyone && styles.whyTickAll]}>✓</Text>
              <Text style={styles.whyText}>{pick.why}</Text>
            </View>
          ) : null}
        </View>
        {tieLine ? <Text style={styles.tieLine}>{SHOW.tieLine}</Text> : null}
        {card.line ? (
          <Text style={styles.cardLine} numberOfLines={3}>
            {card.line}
          </Text>
        ) : null}
        {hidden ? null : (
          <View style={styles.actions}>
            <PlayKey uiId="group.play" ref={mainRef as never} kind="gold" big glyph="▶" label={playLabel(session)} hasTVPreferredFocus dim={busy === 'play'} onPress={() => onPlay(pick.key)} />
            {next ? <PlayKey uiId="group.next" label={next.label} dim={busy === 'next'} onPress={() => onNext(next.index)} /> : null}
            {session.you?.host ? <PlayKey uiId="group.again" glyph="↻" label={WORDS.again} dim={busy === 'again'} onPress={onAgain} /> : null}
          </View>
        )}
      </Rise>
      <View
        style={[{width: posterW, height: posterH}, hidden && styles.unseen]}
        onLayout={e => {
          const l = e.nativeEvent.layout;
          setAt({x: Math.round(l.x + l.width / 2), y: Math.round(l.y + l.height / 2)});
        }}>
        {calm ? null : (
          <Glow
            size={Math.round(posterH * 1.5)}
            color={PLAY.gold}
            opacity={0.16}
            style={{position: 'absolute', left: Math.round((posterW - posterH * 1.5) / 2), top: Math.round((posterH - posterH * 1.5) / 2)}}
          />
        )}
        <Drop run={`${drop.run}:${index}:${pick.key}`} falls={fresh} calm={calm}>
          <View style={styles.prizeEdge}>
            <Poster poster={card.poster} title={card.title} width={posterW - 6} height={posterH - 6} radius={16} size={22} />
          </View>
        </Drop>
      </View>
      <Burst fire={fire} x={at.x} y={at.y} calm={calm} seed={index + 3} />
    </View>
  );
}

// ---------------------------------------------------------------- calm one-liners (no match, chosen, ended)
function Calm({
  glyph,
  title,
  big,
  poster,
  line,
  actions,
}: {
  glyph: string;
  title: string;
  big?: string;
  poster?: GroupCard | null;
  line?: string;
  actions: React.ReactNode;
}) {
  return (
    <View style={styles.center}>
      {poster ? (
        <View style={styles.calmPoster}>
          <Poster poster={poster.poster} title={poster.title} width={120} height={180} radius={14} size={15} />
        </View>
      ) : (
        <View style={styles.calmIcon}>
          <Text style={styles.calmGlyph}>{glyph}</Text>
        </View>
      )}
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
    <Sheet kicker={WORDS.entry.toUpperCase()} title={WORDS.joinCode} onClose={onClose}>
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
    <Sheet kicker={WORDS.entry.toUpperCase()} title={WORDS.addTitle} width={640} onClose={onClose}>
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
  // The room paints the page (it lies over the app's ambient canvas).
  root: {flex: 1, paddingHorizontal: spacing.pageX, paddingTop: spacing.pageY},
  body: {flex: 1},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm},
  fill: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0},
  grow: {flex: 1},
  curtain: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0},
  unseen: {opacity: 0},

  head: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 40, marginBottom: HEAD_H - 40},
  kickerRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  kicker: {color: PLAY.green, fontSize: 14, lineHeight: 20, fontWeight: '800', letterSpacing: 2.6, includeFontPadding: false},
  headBtns: {flexDirection: 'row', gap: spacing.sm},

  h1: {color: PLAY.ink, fontSize: 30, lineHeight: 37, fontWeight: '900', includeFontPadding: false},
  sub: {color: PLAY.inkDim, fontSize: 16, lineHeight: 23, marginTop: 4, marginBottom: spacing.md},
  actions: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.lg},
  actionsCenter: {justifyContent: 'center'},
  hint: {color: PLAY.inkFaint, fontSize: 14, lineHeight: 19, marginTop: spacing.sm},

  panel: {
    backgroundColor: 'rgba(8,10,29,0.62)',
    borderWidth: 1,
    borderColor: PLAY.line,
    borderRadius: 20,
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  groups: {gap: 10},
  group: {flexDirection: 'row', alignItems: 'flex-start', gap: 10},
  groupLabel: {width: 132, color: PLAY.inkFaint, fontSize: 13, lineHeight: 17, fontWeight: '800', letterSpacing: 1.4, paddingTop: 10},
  chips: {flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8},

  // ---- the explanation ----
  tutRow: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xl, paddingBottom: spacing.xl},
  artPanel: {
    width: 320,
    height: 240,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: 'rgba(8,10,29,0.62)',
    borderWidth: 1,
    borderColor: PLAY.line,
  },
  tutText: {flex: 1},
  tutBody: {color: PLAY.inkDim, fontSize: 18, lineHeight: 26, marginTop: spacing.sm, maxWidth: 460},
  dots: {flexDirection: 'row', gap: 6, marginBottom: spacing.md},
  dot: {width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(232,228,255,0.18)'},
  dotLit: {backgroundColor: 'rgba(92,245,184,0.55)'},
  dotOn: {width: 26, backgroundColor: PLAY.green},

  // ---- lobby ----
  lobby: {flex: 1, flexDirection: 'row', gap: spacing.xl},
  joinPanel: {
    width: 284,
    alignItems: 'center',
    paddingTop: 14,
    paddingBottom: 16,
    paddingHorizontal: 16,
    borderRadius: 22,
    backgroundColor: 'rgba(8,10,29,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(255,209,102,0.32)',
    alignSelf: 'flex-start',
  },
  panelKicker: {color: PLAY.gold, fontSize: 13, lineHeight: 17, fontWeight: '800', letterSpacing: 2.4},
  qr: {width: 136, height: 136, borderRadius: 14, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center', marginTop: 14},
  joinLine: {color: PLAY.inkDim, fontSize: 14, lineHeight: 19, textAlign: 'center', marginTop: 10},
  hostLine: {color: PLAY.ink, fontSize: 16, lineHeight: 21, fontWeight: '800', marginTop: 4},
  lobbyMain: {flex: 1},
  joined: {color: PLAY.ink, fontSize: 30, lineHeight: 37, fontWeight: '900', includeFontPadding: false},
  seatsBox: {marginTop: spacing.md},
  settingsRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: spacing.lg},
  settingsText: {flexShrink: 1, color: PLAY.ink, fontSize: 16, lineHeight: 22, fontWeight: '700'},
  addedBox: {marginTop: spacing.md, gap: 2},
  smallCaps: {color: PLAY.inkFaint, fontSize: 13, lineHeight: 17, fontWeight: '800', letterSpacing: 1.6, marginBottom: 2},
  addedItem: {color: PLAY.ink, fontSize: 15, lineHeight: 21, fontWeight: '600'},
  addedBy: {color: PLAY.inkDim, fontSize: 14, fontWeight: '400'},

  // ---- the clock ----
  clock: {flexDirection: 'row', alignItems: 'center', gap: 10},
  clockBig: {justifyContent: 'center', marginTop: spacing.md},
  clockText: {color: PLAY.inkDim, fontSize: 15, lineHeight: 20, fontWeight: '800', fontVariant: ['tabular-nums'], minWidth: 72},
  clockTextBig: {color: PLAY.ink, fontSize: 19, lineHeight: 25},
  clockLow: {color: PLAY.rose},

  // ---- the deck ----
  deck: {flex: 1},
  deckTop: {flexDirection: 'row', alignItems: 'center', gap: spacing.lg, height: 34, marginBottom: TOP_H - 34},
  hand: {color: PLAY.ink, fontSize: 15, lineHeight: 20, fontWeight: '800', fontVariant: ['tabular-nums']},
  countDim: {color: PLAY.inkFaint, fontSize: 14, lineHeight: 19, flexShrink: 1},
  band: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  arena: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 40},
  card: {position: 'absolute', left: 0, top: 0, borderRadius: 18, overflow: 'hidden', backgroundColor: PLAY.tile},
  waitingCard: {alignItems: 'center', justifyContent: 'center'},
  poster: {position: 'absolute', left: 0, top: 0, width: '100%', height: '100%'},
  veil: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: '#06071c'},
  veilOn: {opacity: 0.55},
  foot: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 14, paddingBottom: 12},
  cardTitle: {color: PLAY.ink, fontSize: 19, lineHeight: 23, fontWeight: '900', includeFontPadding: false},
  cardMeta: {color: PLAY.inkDim, fontSize: 13, lineHeight: 18, fontWeight: '700', marginTop: 3},
  libBadge: {position: 'absolute', left: 10, top: 10, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: 'rgba(3,4,12,0.78)'},
  libBadgeText: {color: PLAY.green, fontSize: 13, lineHeight: 17, fontWeight: '800'},
  leaving: {position: 'absolute', left: 0, top: 0},
  stampAt: {position: 'absolute', top: 18},
  stampYes: {left: 12},
  stampNo: {right: 12},
  stampMaybe: {left: 0, right: 0, top: '40%', alignItems: 'center'},
  under: {height: FOOT_H, alignItems: 'center', paddingTop: 8, gap: 4},
  line: {color: PLAY.inkFaint, fontSize: 13, lineHeight: 18, textAlign: 'center', maxWidth: 600},

  // ---- waiting ----
  waiting: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  waitKicker: {color: PLAY.green, fontSize: 16, lineHeight: 22, fontWeight: '800', marginBottom: 6},
  progressBig: {color: PLAY.ink, fontSize: 46, lineHeight: 54, fontWeight: '900', fontVariant: ['tabular-nums'], includeFontPadding: false},
  waitSeats: {marginTop: spacing.lg, maxWidth: 800},

  // ---- the pick ----
  resultRow: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xl},
  resultText: {flex: 1},
  prizeKicker: {flexDirection: 'row', alignItems: 'center', gap: 8},
  resultKicker: {color: PLAY.gold, fontSize: 14, lineHeight: 20, fontWeight: '800', letterSpacing: 2.6, includeFontPadding: false},
  resultCount: {color: PLAY.inkFaint, fontSize: 14, lineHeight: 20, fontWeight: '700', marginLeft: 6},
  resultTitle: {color: PLAY.ink, fontSize: 40, lineHeight: 47, fontWeight: '900', marginTop: 6, includeFontPadding: false},
  meta: {color: PLAY.inkDim, fontSize: 16, lineHeight: 22, fontWeight: '700', marginTop: 4},
  tallyRow: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 14, marginTop: spacing.md},
  why: {
    flexDirection: 'row',
    gap: 7,
    paddingVertical: 6,
    paddingHorizontal: 13,
    borderRadius: 999,
    backgroundColor: 'rgba(160,131,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(160,131,255,0.42)',
  },
  whyAll: {backgroundColor: 'rgba(92,245,184,0.12)', borderColor: 'rgba(92,245,184,0.42)'},
  whyText: {color: PLAY.ink, fontSize: 15, lineHeight: 20, fontWeight: '800'},
  whyTick: {color: PLAY.violet},
  whyTickAll: {color: PLAY.green},
  tieLine: {color: PLAY.gold, fontSize: 14, lineHeight: 19, fontWeight: '700', marginTop: 8},
  cardLine: {color: PLAY.inkDim, fontSize: 16, lineHeight: 23, marginTop: spacing.sm, maxWidth: 520},
  prizeEdge: {borderRadius: 19, borderWidth: 3, borderColor: PLAY.gold, backgroundColor: PLAY.tile},

  // ---- calm states ----
  calmIcon: {width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(160,131,255,0.16)', borderWidth: 1, borderColor: 'rgba(160,131,255,0.4)', marginBottom: 6},
  calmGlyph: {color: PLAY.ink, fontSize: 24, lineHeight: 30, fontWeight: '900'},
  calmPoster: {marginBottom: 8, borderRadius: 16, borderWidth: 2, borderColor: PLAY.gold},
  calmTitle: {color: PLAY.ink, fontSize: 28, lineHeight: 35, fontWeight: '900', textAlign: 'center'},
  calmBig: {color: PLAY.gold, fontSize: 32, lineHeight: 39, fontWeight: '900', textAlign: 'center', maxWidth: 720},
  calmLine: {color: PLAY.inkDim, fontSize: 16, lineHeight: 23, textAlign: 'center', maxWidth: 600},

  // ---- the error line ----
  errRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: spacing.sm},
  errText: {flex: 1, color: ERR, fontSize: 15, fontWeight: '600'},

  // ---- sheets (the app's own) ----
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
