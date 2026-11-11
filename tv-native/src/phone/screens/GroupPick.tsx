// "What do we watch tonight?" on the phone — the controller in a group pick
// (the TV is usually the room's screen; the website's #/group/<CODE> and the
// TV's screens/GroupPick.tsx are the other two). The words and the rules are
// the shared groupPick.ts, the talking groupPickApi.ts; what a finger on the
// card means and this phone's not-yet-confirmed answers are ../groupSwipe.ts.
//
//   no session   Join with a code (the TV's QR lands here with the code: joined
//                at once) · Start (the same choices as the TV)
//   first time   the four-step explanation (TUTORIAL), then "How it works"
//   lobby        the code to read out, who is in, the choices (the starter
//                changes them), Add a title, Start swiping (the starter)
//   swipe        one card at a time: right yes, left no, up maybe (or the three
//                buttons), Undo, the time left; answers move on at once
//   waiting      done — who else is; the starter can add a minute or end it
//   result       the pick and why; Play (on the room's screen when there is
//                one), Something else, Swipe another round
//   chosen       Enjoy; ended: the reason
//
// followGroup drives everything (live over the socket, a poll behind it);
// every action hands the session it brought back to follow.take().
// (Back leaves the page, not the session: the member is "away" until they
// come back or the session ends. Leave says so to the others.)
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {useRoute} from '@react-navigation/native';
import QRCode from 'react-native-qrcode-svg';
import {ApiError, getBaseUrl} from '../../api';
import {
  addedLine,
  cardMeta,
  codeOk,
  currentPick,
  GroupCard,
  GroupMember,
  GroupOptions,
  GroupSearchHit,
  GroupSession,
  GroupSettings,
  GroupVerdict,
  hasNextPick,
  hostOf,
  joinedLine,
  joinUrl,
  limitLabel,
  peopleOf,
  playLabel,
  playsHere,
  progressLine,
  screenOf,
  secondsLeft,
  seenLine,
  stepOf,
  tidyCode,
  timeLeft,
  TUTORIAL,
  unanswered,
  WORDS,
} from '../../groupPick';
import {followGroup, GroupFollow, groupApi, playTarget} from '../../groupPickApi';
import {phoneNative} from '../native';
import {usePNav} from '../nav';
import {cardSize} from '../tasteSwipe';
import {answer as answerLocal, Answers, BUTTONS, cardLabel, flyTo, forget, GLYPH, groupVerdict, LABEL, noAnswers, settle, STAMP, TINT, undo as undoLocal, withMine} from '../groupSwipe';
import {BackBar, useColumn, usePageTop} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import {useBarTop} from '../ui/TopBar';
import {artSrc} from '../ui/Cards';
import Avatar from '../ui/Avatar';
import Field from '../ui/Field';
import Glass from '../ui/Glass';
import Sheet from '../ui/Sheet';
import SearchBox from '../ui/SearchBox';
import Tap from '../ui/Tap';
import {GlassButton, PrimaryButton} from '../ui/Buttons';
import {colors, GUTTER, radius} from '../theme';
import Burst from '../../play/Burst';
import Meter from '../../play/Meter';
import {Plates} from '../../play/Cards';
import {layerAt} from '../../play/deck';
import {isTie, tallyOf, tieJumps} from '../../play/tally';
import {tween, useCalm as usePlayCalm, useTimers, useValue} from '../../play/anim';
import {GLOW_SRC, Star} from '../../play/Star';
import {PLAY} from '../../play/tokens';
import {Eyebrow, GameChip, In, Key, PlayCard, PlayRoom, ty, usePress} from '../play/ui';
import {Poster as PosterArt} from '../play/art';
import {SHOW} from '../play/gameWords';
import type {GroupPick as GroupPickT} from '../../groupPick';

const DEFAULTS: GroupSettings = {kind: 'movie', mood: 'any', length: 'any', limitSec: 180};
const INFO_FADE = 'linear-gradient(to top, rgba(4,4,14,0.96) 0%, rgba(4,4,14,0.8) 45%, rgba(4,4,14,0) 100%)';
const OUT = Easing.bezier(0.2, 0.7, 0.3, 1);

/** The server's own words when it answered; a calm line when it could not be reached. */
export const errText = (e: unknown): string => {
  const m = e instanceof ApiError && e.status > 0 ? String(e.message || '') : '';
  return m && !/^\d{3}\s\//.test(m) ? m : WORDS.noReach;
};

const useCalm = () => {
  const calm = useRef(false);
  useEffect(() => {
    try {
      AccessibilityInfo?.isReduceMotionEnabled?.()
        .then(on => {
          calm.current = !!on;
        })
        .catch(() => {});
    } catch {}
  }, []);
  return calm;
};

// ---------- small pieces ----------

function Poster({card, w, h, style}: {card: Pick<GroupCard, 'poster' | 'title'>; w: number; h: number; style?: object}) {
  const {src} = artSrc(card.poster || null, w);
  const [failed, setFailed] = useState(false);
  return (
    <View style={[s.poster, {width: w, height: h}, style]}>
      {src && !failed ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} onError={() => setFailed(true)} />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.fallback]}>
          <Text style={s.fallbackText} numberOfLines={4}>
            {card.title}
          </Text>
        </View>
      )}
    </View>
  );
}

/** A person as a seat (.pg-seat): a big avatar bubble and the name under it. The starter has a
 *  small gold star; away is dimmed; while everyone swipes, how far through the deck they are
 *  (a ribbon) and a tick when done. A seat pops in only when that person is new. */
function Seat({m, size = 62, fresh, calm, deck}: {m: GroupMember; size?: number; fresh?: boolean; calm: boolean; deck?: number}) {
  const voting = deck != null && m.role === 'voter';
  const part = m.done ? 1 : deck ? Math.max(0, Math.min(1, (m.answered || 0) / deck)) : 0;
  const badge = m.role === 'screen' ? WORDS.screenBadge : m.away ? WORDS.awayBadge : voting && m.done ? WORDS.doneBadge : m.host && !voting ? WORDS.hostBadge : '';
  const count = voting && !m.done ? `${m.answered || 0}/${deck}` : '';
  return (
    <In calm={calm || !fresh} pop style={[s.seat, {width: size + 18}, m.away && s.away]}>
      <View accessible accessibilityLabel={badge ? `${m.name}, ${badge}` : m.name} style={s.seatIn}>
        <View style={[s.seatFace, {width: size, height: size, borderRadius: size / 2}]}>
          <Avatar p={{name: m.name, avatar: m.avatar || '🙂', avatarImage: m.avatarImage || null, color: ''}} size={size - 6} round />
          {m.host ? (
            <View style={s.seatStar}>
              <Star size={12} color={PLAY.goldInk} />
            </View>
          ) : null}
          {voting && m.done ? (
            <View style={s.seatTick}>
              <Text style={s.seatTickText}>✓</Text>
            </View>
          ) : null}
        </View>
        <Text style={s.seatName} numberOfLines={1}>
          {m.name}
        </Text>
        {voting ? (
          <View style={s.seatRibbon}>
            <Meter value={part} width={size} height={5} calm={calm} tint={m.done ? PLAY.green : undefined} />
          </View>
        ) : null}
        {badge || count ? <Text style={[s.badge, voting && m.done && s.badgeDone]}>{badge || count}</Text> : null}
      </View>
    </In>
  );
}

/** Everyone in the room, as seats; `room` adds the two dashed empty seats (there is room). */
function Seats({session, calm, deck, room, seen, size}: {session: GroupSession; calm: boolean; deck?: number; room?: boolean; seen: React.MutableRefObject<Set<string>>; size?: number}) {
  const people = peopleOf(session);
  const fresh = people.filter(m => !seen.current.has(m.profileId)).map(m => m.profileId);
  useEffect(() => {
    for (const id of fresh) seen.current.add(id);
  });
  const free = room ? Math.max(0, Math.min(2, 5 - people.length)) : 0;
  return (
    <View style={s.seats}>
      {people.map(m => (
        <Seat key={m.profileId} m={m} calm={calm} fresh={fresh.includes(m.profileId)} deck={deck} size={size} />
      ))}
      {Array.from({length: free}, (_, i) => (
        <View key={`free${i}`} style={[s.seat, {width: (size || 62) + 18}]} importantForAccessibility="no-hide-descendants">
          <View style={[s.seatFree, {width: size || 62, height: size || 62, borderRadius: (size || 62) / 2}]}>
            <Text style={s.seatFreeText}>+</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/** Films or series · Mood · Length · Time to swipe — as chunky game chips (the starter's). */
function Choices({opts, value, onPick, busy}: {opts: GroupOptions; value: GroupSettings; onPick: (p: Partial<GroupSettings>) => void; busy?: boolean}) {
  const rows: {name: string; field: keyof GroupSettings; items: {id: string | number; label: string}[]}[] = [
    {name: WORDS.kind, field: 'kind', items: opts.kinds},
    {name: WORDS.mood, field: 'mood', items: opts.moods},
    {name: WORDS.length, field: 'length', items: opts.lengths},
    {name: WORDS.time, field: 'limitSec', items: opts.limits.map(n => ({id: n, label: limitLabel(n)}))},
  ];
  return (
    <>
      {rows.map(r => (
        <View key={r.field} style={s.choiceRow}>
          <Text style={s.label}>{r.name}</Text>
          <View style={s.chips}>
            {r.items.map(it => (
              <GameChip uiId="group.option" key={String(it.id)} label={it.label} on={value[r.field] === it.id} disabled={busy} onPress={() => onPick({[r.field]: it.id} as Partial<GroupSettings>)} />
            ))}
          </View>
        </View>
      ))}
    </>
  );
}

/** The choices in one quiet line, for everyone but the starter. */
const choiceLine = (opts: GroupOptions | null, v: GroupSettings) => {
  if (!opts) return '';
  const name = (list: {id: string | number; label: string}[], id: string | number) => (list.find(x => x.id === id) || {label: ''}).label;
  return [name(opts.kinds, v.kind), name(opts.moods, v.mood), name(opts.lengths, v.length), limitLabel(v.limitSec)].filter(Boolean).join(' · ');
};

/** The tally of a pick as stars: gold for a yes, an outline for a maybe, a dot for the rest. */
function TallyRow({pick, calm}: {pick: GroupPickT; calm: boolean}) {
  const marks = tallyOf(pick);
  if (!marks.length) return null;
  return (
    <View style={s.tally} importantForAccessibility="no-hide-descendants">
      {marks.map((k, i) => (
        <In key={i} calm={calm} pop delay={900 + i * 90}>
          {k === 'no' ? <View style={s.tallyDot} /> : <Star size={22} color={k === 'yes' ? PLAY.gold : 'rgba(255,209,102,0.38)'} />}
        </In>
      ))}
    </View>
  );
}

// ---------- the first-time explanation ----------

/** The four calm drawings (plain shapes): a TV with a code, phones, a card with ✓ ? ✕, a poster with a star. */
export function TutorialArt({art}: {art: (typeof TUTORIAL)[number]['art']}) {
  if (art === 'tv')
    return (
      <View style={s.art}>
        <View style={s.artTv}>
          <Text style={s.artCode}>K7QM</Text>
          <View style={s.artQr} />
        </View>
        <View style={s.artStand} />
      </View>
    );
  if (art === 'phones')
    return (
      <View style={[s.art, s.artRow]}>
        {[0, 1, 2].map(i => (
          <View key={i} style={[s.artPhone, i === 1 && s.artPhoneMid]}>
            <View style={s.artPhoneScreen} />
          </View>
        ))}
      </View>
    );
  if (art === 'swipe')
    return (
      <View style={s.art}>
        <View style={[s.artCard, s.artTilt]} />
        <View style={s.artMarks}>
          {BUTTONS.map(v => (
            <View key={v} style={[s.artMark, {borderColor: TINT[v]}]}>
              <Text style={[s.artMarkText, {color: TINT[v]}]}>{GLYPH[v]}</Text>
            </View>
          ))}
        </View>
      </View>
    );
  return (
    <View style={s.art}>
      <View style={s.artCard}>
        <Text style={s.artStar}>★</Text>
      </View>
    </View>
  );
}

function Tutorial({onDone}: {onDone: () => void}) {
  const [i, setI] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;
  const calm = useCalm();
  const step = TUTORIAL[i];
  const last = i === TUTORIAL.length - 1;
  // a gentle fade and lift between the steps (none with "Remove animations")
  const go = (n: number) => {
    if (calm.current) return setI(n);
    Animated.timing(fade, {toValue: 0, duration: 140, useNativeDriver: true}).start(() => {
      setI(n);
      Animated.timing(fade, {toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
    });
  };
  return (
    <Glass style={s.tut}>
      <Animated.View style={[s.centered, {opacity: fade, transform: [{translateY: fade.interpolate({inputRange: [0, 1], outputRange: [10, 0]})}]}]} accessibilityLiveRegion="polite">
        <TutorialArt art={step.art} />
        <Text style={s.tutTitle} accessibilityRole="header">
          {step.title}
        </Text>
        <Text style={s.tutBody}>{step.body}</Text>
      </Animated.View>
      <View style={s.dots}>
        {TUTORIAL.map((_, n) => (
          <View key={n} style={[s.dot, n === i && s.dotOn]} />
        ))}
      </View>
      <View style={s.tutButtons}>
        {!last ? <GlassButton uiId="group.tutorial.skip" small label={WORDS.skip} onPress={onDone} /> : null}
        <PrimaryButton uiId="group.tutorial.next" label={last ? WORDS.letsGo : WORDS.next} onPress={() => (last ? onDone() : go(i + 1))} style={s.grow} />
      </View>
    </Glass>
  );
}

// ---------- Add a title ----------

function AddSheet({code, visible, onClose, onAdded}: {code: string; visible: boolean; onClose: () => void; onAdded: () => void}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<GroupSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  useEffect(() => {
    if (!visible) return;
    const words = q.trim();
    if (words.length < 2) {
      setHits(null);
      return;
    }
    let on = true;
    const t = setTimeout(() => {
      setBusy(true);
      groupApi
        .search(code, words)
        .then(r => {
          if (!on) return;
          setHits(r.results || []);
          setErr('');
        })
        .catch(e => on && setErr(errText(e)))
        .finally(() => on && setBusy(false));
    }, 320);
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [q, code, visible]);
  const add = (h: GroupSearchHit) => {
    if (h.inDeck || added.includes(h.key)) return;
    setAdded(a => [...a, h.key]);
    phoneNative.haptic('tick');
    groupApi
      .add(code, {id: h.id, imdbId: h.imdbId, type: h.type, title: h.title, year: h.year, poster: h.poster})
      .then(() => onAdded())
      .catch(e => {
        setAdded(a => a.filter(k => k !== h.key));
        setErr(errText(e));
      });
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={WORDS.addTitle} sub={WORDS.addLine}>
      <View style={s.sheetBody}>
        <SearchBox value={q} onChangeText={setQ} onClear={() => setQ('')} placeholder={WORDS.searchPlaceholder} autoFocus />
        {err ? <Text style={s.err}>{err}</Text> : null}
        {busy && !hits ? <ActivityIndicator color={colors.text} style={s.spin} /> : null}
        {(hits || []).map(h => {
          const isIn = h.inDeck || added.includes(h.key);
          return (
            <Tap key={h.key} flat disabled={isIn} onPress={() => add(h)} style={s.hit} accessibilityRole="button" accessibilityLabel={`${h.title}${isIn ? `, ${WORDS.inDeck}` : ''}`}>
              <Poster card={h} w={44} h={66} style={s.hitPoster} />
              <View style={s.shrink}>
                <Text style={s.hitTitle} numberOfLines={2}>
                  {h.title}
                </Text>
                <View style={s.hitMeta}>
                  {h.year ? <Text style={s.hitYear}>{h.year}</Text> : null}
                  {h.lib ? <Text style={s.libBadge}>{WORDS.libBadge}</Text> : null}
                </View>
              </View>
              <Text style={[s.hitAdd, isIn && s.hitIn]}>{isIn ? (h.inDeck ? WORDS.inDeck : WORDS.added) : '+'}</Text>
            </Tap>
          );
        })}
      </View>
    </Sheet>
  );
}

// ---------- the swiping card (the same deck as Taste) ----------

type Flying = {card: GroupCard; v: GroupVerdict; xy: Animated.ValueXY; fade: Animated.Value; slam: Animated.Value | null; n: number};

// the answers' colours (play.css: YES in aurora green, NO in rose, MAYBE pale)
const PTINT: Record<GroupVerdict, string> = {yes: PLAY.yes, maybe: PLAY.maybe, no: PLAY.no};

function CardFace({card, w}: {card: GroupCard; w: number}) {
  const meta = cardMeta(card);
  const seen = seenLine(card.seenBy);
  const by = addedLine(card.addedBy);
  const {src} = artSrc(card.poster || null, w);
  const [failed, setFailed] = useState(false);
  return (
    <>
      {src && !failed ? (
        <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} onError={() => setFailed(true)} />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.fallback]}>
          <Star size={34} color="rgba(232,228,255,0.3)" />
          <Text style={s.fallbackText}>{card.title}</Text>
        </View>
      )}
      {card.lib ? <Text style={[s.libBadge, s.cardBadge]}>{WORDS.libBadge}</Text> : null}
      <View pointerEvents="none" style={s.info}>
        <Text style={s.cardTitle} numberOfLines={2}>
          {card.title}
        </Text>
        {meta ? <Text style={s.cardMeta}>{meta}</Text> : null}
        {card.line ? (
          <Text style={s.cardLine} numberOfLines={3}>
            {card.line}
          </Text>
        ) : null}
        {seen || by ? <Text style={s.cardNote}>{[by, seen].filter(Boolean).join(' · ')}</Text> : null}
      </View>
    </>
  );
}

function StampOf({v, opacity, scale}: {v: GroupVerdict; opacity: unknown; scale?: unknown}) {
  return (
    <Animated.View pointerEvents="none" style={[v === 'maybe' ? s.stampMid : v === 'yes' ? s.stampLeft : s.stampRight, {opacity: opacity as never}]}>
      <Animated.View style={[s.stamp, {borderColor: PTINT[v]}, scale != null ? {transform: [{scale: scale as never}]} : null]}>
        <Text style={[s.stampText, {color: PTINT[v]}]}>{STAMP[v]}</Text>
      </Animated.View>
    </Animated.View>
  );
}

/** YES / NO by how far sideways, MAYBE by how far up — as the finger drags. */
function Stamps({xy}: {xy: Animated.ValueXY}) {
  const clamp = 'clamp' as const;
  const level: Record<GroupVerdict, unknown> = {
    yes: xy.x.interpolate({inputRange: [0, 110], outputRange: [0, 1], extrapolate: clamp}),
    no: xy.x.interpolate({inputRange: [-110, 0], outputRange: [1, 0], extrapolate: clamp}),
    maybe: xy.y.interpolate({inputRange: [-100, 0], outputRange: [1, 0], extrapolate: clamp}),
  };
  return (
    <>
      {BUTTONS.map(v => (
        <StampOf key={v} v={v} opacity={level[v]} />
      ))}
    </>
  );
}

/** An arcade key: rose ✕, small glass ?, green ✓ — chunky, with a bottom edge. */
function AnswerButton({v, onPress, off}: {v: GroupVerdict; onPress: () => void; off: boolean}) {
  const big = v !== 'maybe';
  const press = usePress();
  return (
    <Tap uiId={v === 'yes' ? 'group.yes' : v === 'no' ? 'group.no' : 'group.maybe'} flat rippleColor="rgba(0,0,0,0)" disabled={off} accessibilityRole="button" accessibilityLabel={LABEL[v]} onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut} style={s.answer}>
      <Animated.View style={[s.disc, big ? s.discBig : s.discSmall, v === 'yes' ? s.discYes : v === 'no' ? s.discNo : s.discMaybe, {transform: [{scale: press.scale}]}]}>
        <Text style={[s.discGlyph, !big && s.discGlyphSmall, {color: v === 'maybe' ? PLAY.ink : '#1b0f22'}]}>{GLYPH[v]}</Text>
      </Animated.View>
      <Text style={s.answerLabel}>{LABEL[v]}</Text>
    </Tap>
  );
}

/** The swipe step: the head, the card on a stage of fixed size with the deck under it, the three answers. */
function SwipeStage({
  card,
  left,
  flying,
  xy,
  lift,
  responder,
  onVote,
  head,
  foot,
}: {
  card: GroupCard | null;
  left: number;
  flying: Flying[];
  xy: Animated.ValueXY;
  lift: Animated.Value;
  responder: ReturnType<typeof PanResponder.create>;
  onVote: (v: GroupVerdict) => void;
  head: React.ReactNode;
  foot: React.ReactNode;
}) {
  const [stage, setStage] = useState({w: 0, h: 0});
  const {w, h} = cardSize(stage.w, Math.max(0, stage.h - 24));
  const onStage = (e: LayoutChangeEvent) => {
    const {width, height} = e.nativeEvent.layout;
    setStage(st => (Math.abs(st.w - width) < 1 && Math.abs(st.h - height) < 1 ? st : {w: width, h: height}));
  };
  const tilt = (x: Animated.Value) => x.interpolate({inputRange: [-1000, 1000], outputRange: ['-50deg', '50deg']});
  const rest = layerAt(0, h);
  const moving = {
    opacity: lift.interpolate({inputRange: [0, 1], outputRange: [0.85, 1]}),
    transform: [
      {translateX: xy.x},
      {translateY: Animated.add(xy.y, lift.interpolate({inputRange: [0, 1], outputRange: [rest.translateY, 0]}))},
      {rotate: tilt(xy.x)},
      {scale: lift.interpolate({inputRange: [0, 1], outputRange: [rest.scale, 1]})},
    ],
  };
  return (
    <>
      {head}
      <View style={s.stage} onLayout={onStage} testID="group-stage">
        {w > 0 ? (
          <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, s.center, {paddingBottom: 22}]}>
            <View pointerEvents="box-none" style={{width: w, height: h}}>
              <View pointerEvents="none" style={{position: 'absolute', left: 0, top: 0}}>
                <Plates left={left} width={w} height={h} radius={22} />
              </View>
              {card ? (
                <Animated.View
                  key={card.key}
                  {...responder.panHandlers}
                  accessible
                  accessibilityLabel={cardLabel(card)}
                  accessibilityActions={BUTTONS.map(v => ({name: v, label: LABEL[v]}))}
                  onAccessibilityAction={e => onVote(e.nativeEvent.actionName as GroupVerdict)}
                  style={[s.card2, {width: w, height: h}, moving]}>
                  <CardFace card={card} w={w} />
                  <Stamps xy={xy} />
                </Animated.View>
              ) : null}
              {flying.map(f => (
                <Animated.View
                  key={`fly-${f.n}`}
                  pointerEvents="none"
                  importantForAccessibility="no-hide-descendants"
                  style={[s.card2, {width: w, height: h, opacity: f.fade, transform: [{translateX: f.xy.x}, {translateY: f.xy.y}, {rotate: tilt(f.xy.x)}]}]}>
                  <CardFace card={f.card} w={w} />
                  <StampOf
                    v={f.v}
                    opacity={f.slam ? f.slam.interpolate({inputRange: [0, 0.35, 1], outputRange: [0, 1, 1]}) : 1}
                    scale={f.slam ? f.slam.interpolate({inputRange: [0, 0.75, 1], outputRange: [2.2, 0.94, 1]}) : undefined}
                  />
                </Animated.View>
              ))}
            </View>
          </View>
        ) : null}
      </View>
      {foot}
      <View style={s.answers}>
        {BUTTONS.map(v => (
          <AnswerButton key={v} v={v} off={!card} onPress={() => onVote(v)} />
        ))}
      </View>
    </>
  );
}

// ---------- the reveal: "The votes are in…", a tie-break, the drop ----------
// Over the result (which is drawn already and waits under it), once per result and only for a
// page that saw the vote end. A tap anywhere or Skip ends it — and gives up the burst. The
// server's order is the result; the show only tells it.
function RevealShow({result, onEnd, bottom}: {result: NonNullable<GroupSession['result']>; onEnd: (lifted: boolean) => void; bottom: number}) {
  const timers = useTimers();
  const tie = isTie(result) && !!result.picks[1] && !!result.picks[1].card;
  const swap = tie && (Number(result.at) || 0) % 2 === 1; // (the winner is not always on the same side)
  const pair = tie ? (swap ? [result.picks[1], result.picks[0]] : [result.picks[0], result.picks[1]]) : [];
  const winner = swap ? 1 : 0;
  const [beat, setBeat] = useState<'votes' | 'tie'>('votes');
  const [lit, setLit] = useState(-1);
  const [won, setWon] = useState(false);
  const fade = useValue(1);
  const ended = useRef(false);
  const end = useCallback(
    (lifted: boolean) => {
      if (ended.current) return;
      ended.current = true;
      timers.clear();
      tween(fade, 0, lifted ? 340 : 180).start(() => onEnd(lifted));
    },
    [timers, fade, onEnd],
  );
  useEffect(() => {
    let t = 1500;
    if (tie) {
      const jumps = tieJumps(winner);
      timers.after(t, () => setBeat('tie'));
      for (const j of jumps)
        timers.after(t + 460 + j.at, () => {
          setLit(j.i);
          phoneNative.haptic('tick');
        });
      const landed = t + 460 + jumps[jumps.length - 1].at;
      timers.after(landed + 140, () => setWon(true));
      t = landed + 820;
    }
    timers.after(t, () => end(true));
    // (once)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, s.show, {opacity: fade}]}>
      <Tap flat rippleColor="rgba(0,0,0,0)" accessible={false} onPress={() => end(false)} style={StyleSheet.absoluteFill}>
        <PlayRoom />
        <View style={s.showIn}>
          <Text style={[ty.h1, s.showWords]} accessibilityLiveRegion="polite">
            {beat === 'tie' ? SHOW.tie : SHOW.votesIn}
          </Text>
          <View style={s.showStars} importantForAccessibility="no-hide-descendants">
            {[0, 1, 2].map(i => (
              <In key={i} pop delay={200 + i * 380}>
                <Star size={30} color={PLAY.gold} />
              </In>
            ))}
          </View>
          {tie ? (
            <View style={s.duel} importantForAccessibility="no-hide-descendants">
              {pair.map((p, k) => (
                <View key={k} style={[s.duelCard, lit === k && s.duelLit, won && k === winner && s.duelWon]}>
                  <Poster card={p.card} w={112} h={168} />
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </Tap>
      <View style={[s.showSkip, {bottom: bottom + 18}]}>
        <Key label={SHOW.skip} small onPress={() => end(false)} />
      </View>
    </Animated.View>
  );
}

// ---------- the screen ----------

type Params = {code?: string | null} | undefined;

export default function GroupPick() {
  const route = useRoute();
  const nav = usePNav();
  const top = usePageTop();
  const barTop = useBarTop();
  const column = useColumn();
  const bottom = useTabBarSpace();
  const win = useWindowDimensions();
  const calm = useCalm();
  const pcalm = usePlayCalm(); // (the play look's still state: Remove animations, a lite phone)
  const seen = useRef(new Set<string>()); // who has had their seat's entrance (nobody pops in twice)
  const raw = (route.params as Params)?.code;
  const linkCode = raw ? tidyCode(raw) : '';

  const [opts, setOpts] = useState<GroupOptions | null>(null);
  const [session, setSession] = useState<GroupSession | null>(null);
  const [lost, setLost] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>(noAnswers());
  const [tut, setTut] = useState(false);
  const [typed, setTyped] = useState(linkCode);
  const [draft, setDraft] = useState<GroupSettings>(DEFAULTS);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [pressedPlay, setPressedPlay] = useState(false);
  const [, setTick] = useState(0);
  const follow = useRef<GroupFollow | null>(null);
  const live = useRef(true);
  const askedTut = useRef(false);

  useEffect(
    () => () => {
      live.current = false;
      follow.current?.stop();
    },
    [],
  );
  useEffect(() => {
    groupApi
      .options()
      .then(o => live.current && setOpts(o))
      .catch(() => live.current && setOpts(null));
  }, []);

  // ---------- following a session ----------
  const begin = useCallback((s: GroupSession) => {
    follow.current?.stop();
    setLost(null);
    setErr('');
    setPressedPlay(false);
    const f = followGroup(
      s.code,
      next => {
        if (!live.current) return;
        setSession(next);
        setAnswers(a => settle(a, next));
      },
      why => live.current && setLost(why.message || WORDS.ended),
    );
    follow.current = f;
    f.take(s);
  }, []);
  const take = (s: GroupSession | undefined) => s && follow.current?.take(s);

  // the first time here: the explanation comes first (once someone joins or starts)
  useEffect(() => {
    if (session && opts && !opts.tutorialSeen && !askedTut.current) {
      askedTut.current = true;
      setTut(true);
    }
  }, [session, opts]);
  const tutDone = () => {
    setTut(false);
    if (opts && !opts.tutorialSeen) {
      setOpts({...opts, tutorialSeen: true});
      groupApi.tutorialSeen().catch(() => {});
    }
  };

  /** An action of the starter's or anyone's: busy while it goes, its session taken, its refusal said. */
  const run = async (what: string, fn: () => Promise<unknown>, then?: (r: unknown) => void) => {
    if (busy) return;
    setBusy(what);
    setErr('');
    try {
      const r = await fn();
      if (!live.current) return;
      take((r as {session?: GroupSession} | null)?.session);
      then?.(r);
    } catch (e) {
      if (live.current) setErr(errText(e));
    } finally {
      if (live.current) setBusy(null);
    }
  };

  const join = useCallback(
    async (code: string) => {
      setErr('');
      if (!codeOk(code)) return setErr(WORDS.codeWrong);
      setBusy('join');
      try {
        const r = await groupApi.join(code, 'voter');
        if (live.current) begin(r.session);
      } catch (e) {
        if (live.current) setErr(errText(e));
      } finally {
        if (live.current) setBusy(null);
      }
    },
    [begin],
  );
  // from a link (the TV's QR): straight in
  const linked = useRef('');
  useEffect(() => {
    if (!linkCode || linked.current === linkCode) return;
    linked.current = linkCode;
    setTyped(linkCode);
    if (codeOk(linkCode)) join(linkCode);
    else setErr(WORDS.codeWrong);
  }, [linkCode, join]);

  const start = async () => {
    if (busy) return;
    setBusy('start');
    setErr('');
    try {
      const r = await groupApi.create(draft, 'voter');
      if (live.current) begin(r.session);
    } catch (e) {
      if (live.current) setErr(errText(e));
    } finally {
      if (live.current) setBusy(null);
    }
  };

  // ---------- what is on screen ----------
  const shown = session ? withMine(session, answers) : null;
  const stepNow = lost ? 'ended' : shown ? stepOf(shown) : null;
  const code = session ? session.code : '';
  const isHost = !!shown?.you?.host;
  const cards = shown ? unanswered(shown) : [];
  const card = stepNow === 'swipe' ? cards[0] || null : null;

  // the countdown: once a second while it runs
  const ticking = !!shown?.deadline && (stepNow === 'swipe' || stepNow === 'waiting');
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  const left = shown && follow.current ? timeLeft(shown, Date.now() - follow.current.receivedAt()) : '';

  // ---------- answering ----------
  const [flying, setFlying] = useState<Flying[]>([]);
  // the last answer's card finishes its flight before "done — waiting" takes the page
  const step = stepNow === 'waiting' && flying.length && session?.phase === 'swiping' ? 'swipe' : stepNow;
  // a new step (the form -> the lobby -> the result ...) opens at its top: pressing Start at the
  // foot of the long form used to land the host mid-lobby, the room's code scrolled off-screen
  const scroller = useRef<ScrollView>(null);
  useEffect(() => {
    scroller.current?.scrollTo({y: 0, animated: false});
  }, [step, tut]);
  const xy = useRef(new Animated.ValueXY({x: 0, y: 0})).current;
  const lift = useRef(new Animated.Value(1)).current;
  const flights = useRef(0);
  const cardKey = card ? card.key : null;
  const returning = useRef<string | null>(null);
  // a new card on top steps forward from behind (not one Undo is flying back in)
  useEffect(() => {
    if (!cardKey) return;
    if (returning.current === cardKey) {
      returning.current = null;
      return;
    }
    xy.setValue({x: 0, y: 0});
    lift.setValue(calm.current ? 1 : 0);
    if (!calm.current) Animated.timing(lift, {toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true}).start();
  }, [cardKey, xy, lift, calm]);

  const vote = (v: GroupVerdict, from: {dx: number; dy: number} | null = null) => {
    if (!card || !session) return;
    const c = card;
    setAnswers(a => answerLocal(a.code === session.code && a.round === session.round ? a : noAnswers(session.code, session.round), c.key, v));
    phoneNative.haptic('tick');
    // the next card starts in the middle (the effect above steps it forward)
    xy.setValue({x: 0, y: 0});
    if (!calm.current) lift.setValue(0);
    // the answered card flies off from where the finger let it go
    const n = ++flights.current;
    // a key (not a drag): the stamp is slammed on, the card takes the hit, then it is thrown
    const slammed = !from && !calm.current;
    const f: Flying = {card: c, v, xy: new Animated.ValueXY(from ? {x: from.dx, y: from.dy} : {x: 0, y: 0}), fade: new Animated.Value(1), slam: slammed ? new Animated.Value(0) : null, n};
    setFlying(l => [...l.filter(x => x.card.key !== c.key), f]);
    const gone = () => setFlying(l => l.filter(x => x.n !== n));
    if (calm.current) Animated.timing(f.fade, {toValue: 0, duration: 140, useNativeDriver: true}).start(gone);
    else {
      const t = flyTo(v, from, win.width, win.height);
      const throwIt = Animated.parallel([
        Animated.timing(f.xy, {toValue: {x: t.x, y: t.y}, duration: 300, easing: slammed ? Easing.in(Easing.quad) : OUT, useNativeDriver: true}),
        Animated.timing(f.fade, {toValue: 0, duration: 300, easing: Easing.in(Easing.quad), useNativeDriver: true}),
      ]);
      if (f.slam) {
        const nudge = v === 'yes' ? 14 : v === 'no' ? -14 : 0;
        Animated.sequence([
          Animated.parallel([
            Animated.timing(f.slam, {toValue: 1, duration: 190, easing: Easing.out(Easing.cubic), useNativeDriver: true}),
            Animated.timing(f.xy, {toValue: {x: nudge, y: v === 'maybe' ? -10 : 4}, duration: 190, easing: Easing.out(Easing.cubic), useNativeDriver: true}),
          ]),
          throwIt,
        ]).start(gone);
      } else throwIt.start(gone);
    }
    setErr('');
    groupApi.vote(session.code, c.key, v).catch(e => {
      if (!live.current) return;
      // refused with a reason (time's up…): the answer stays, the reason is said;
      // never reached: as if it had not been given (the card comes back)
      if (!(e instanceof ApiError && e.status > 0)) setAnswers(a => forget(a, c.key));
      setErr(errText(e));
    });
  };
  const voteRef = useRef(vote);
  voteRef.current = vote;

  const takeBack = () => {
    if (!session || !shown) return;
    const u = undoLocal(answers);
    if (!u) return;
    const was = shown.mine[u.key];
    setAnswers(u.next);
    setFlying(l => l.filter(x => x.card.key !== u.key));
    // it comes back from where it went
    returning.current = u.key;
    lift.setValue(1);
    if (calm.current || !was) xy.setValue({x: 0, y: 0});
    else {
      const t = flyTo(was, null, win.width, win.height);
      xy.setValue({x: t.x, y: t.y});
      Animated.timing(xy, {toValue: {x: 0, y: 0}, duration: 320, easing: OUT, useNativeDriver: true}).start();
    }
    setErr('');
    groupApi.vote(session.code, u.key, null).catch(e => live.current && setErr(errText(e)));
  };

  const held = useRef(false);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          held.current = true;
          xy.stopAnimation();
        },
        onPanResponderMove: (_e, g) => {
          if (held.current) xy.setValue({x: g.dx, y: g.dy});
        },
        onPanResponderRelease: (_e, g) => {
          held.current = false;
          const v = groupVerdict({dx: g.dx, dy: g.dy, vx: g.vx, vy: g.vy});
          if (v) return voteRef.current(v, {dx: g.dx, dy: g.dy});
          // not far enough: back to the middle
          Animated.spring(xy, {toValue: {x: 0, y: 0}, friction: 6, tension: 80, useNativeDriver: true}).start();
        },
        onPanResponderTerminate: () => {
          held.current = false;
          Animated.spring(xy, {toValue: {x: 0, y: 0}, friction: 6, tension: 80, useNativeDriver: true}).start();
        },
      }),
    [xy],
  );

  // ---------- the result ----------
  // a library film plays; a series or a catalogue title opens its page (the way a card opens)
  const openHere = (c: GroupCard, playNow: boolean) => {
    const t = playTarget(c);
    if (!t) return;
    if (t.kind === 'library' && t.type === 'movie' && playNow) nav.push('Player', {id: t.id, title: c.title});
    else if (t.kind === 'library') nav.push('Detail', {item: {id: t.id, type: t.type, title: c.title, year: c.year || undefined, cover: c.poster || null, source: 'downloaded'}});
    else nav.push('Detail', {item: {id: t.imdbId, imdbId: t.imdbId, type: t.type, title: c.title, year: c.year || undefined, cover: c.poster || null, poster: c.poster || null, source: 'stream'}});
  };
  // Play always tells the room; the film starts HERE only when the room has no screen
  const play = () => {
    const p = shown && currentPick(shown);
    if (!p || !shown) return;
    run(
      'play',
      () => groupApi.choose(code, p.key),
      r => {
        setPressedPlay(true);
        const after = (r as {session?: GroupSession}).session || shown;
        if (playsHere(after, true)) openHere(p.card, true);
      },
    );
  };
  const leave = () => {
    if (code && !lost && stepNow !== 'ended') groupApi.leave(code).catch(() => {});
    follow.current?.stop();
    follow.current = null;
    if (nav.canGoBack()) nav.goBack();
    else {
      setSession(null);
      setLost(null);
    }
  };
  const endAll = () =>
    run(
      'end',
      () => groupApi.end(code),
      () => {
        follow.current?.stop();
        follow.current = null;
        if (nav.canGoBack()) nav.goBack();
      },
    );

  // ---------- the reveal ----------
  // The show plays once per result, and only for a page that saw the vote end here (a reload, a
  // late phone: the still page). Remove animations: no show; a tie is one line.
  const sawVoting = useRef(false);
  const [showing, setShowing] = useState<number | null>(null); // the result (its `at`) under the curtain
  const shownFor = useRef<number | null>(null);
  const [dropRun, setDropRun] = useState(0);
  const [burst, setBurst] = useState({n: 0, x: 0, y: 0});
  const [timeW, setTimeW] = useState(0);
  const prizeRef = useRef<View>(null);
  const timers = useTimers();
  useEffect(() => {
    if (step === 'swipe' || step === 'waiting') sawVoting.current = true;
    if (step === 'result' && shown?.result) {
      const at = Number(shown.result.at) || 0;
      if (sawVoting.current && shownFor.current !== at && !pcalm && currentPick(shown)) {
        shownFor.current = at;
        setShowing(at);
      }
      sawVoting.current = false;
    }
  }, [step, shown, pcalm]);
  const endShow = useCallback(
    (lifted: boolean) => {
      setShowing(null);
      if (!lifted) return;
      // the drop, and the one meteor burst from the poster
      setDropRun(r => r + 1);
      timers.after(440, () => {
        phoneNative.haptic('confirm');
        prizeRef.current?.measureInWindow((x, y, w, h) => setBurst(b => ({n: b.n + 1, x: x + w / 2, y: y + h / 2})));
      });
    },
    [timers],
  );

  // ---------- drawing ----------
  const errLine = err ? (
    <Text style={s.err} accessibilityRole="alert">
      {err}
    </Text>
  ) : null;
  const howTo = (
    <Tap uiId="group.howto" flat onPress={() => setTut(true)} style={s.link} accessibilityRole="button">
      <Text style={s.linkText}>{WORDS.howItWorks}</Text>
    </Tap>
  );
  const footer = shown ? (
    <View style={s.footer}>
      <Key uiId="group.leave" small label={WORDS.leave} onPress={leave} calm={pcalm} />
      {isHost && step !== 'ended' && step !== 'chosen' ? <Key uiId="group.end" small label={WORDS.endAll} onPress={endAll} disabled={busy === 'end'} calm={pcalm} ink={PLAY.rose} /> : null}
    </View>
  ) : null;
  const addButton = <Key uiId="group.add" small label={WORDS.addTitle} glyph="+" onPress={() => setAdding(true)} calm={pcalm} />;
  const kicker = (
    <Eyebrow star style={s.kickerRow}>
      {WORDS.feature}
    </Eyebrow>
  );

  let body: React.ReactNode;
  let fixed = false; // the swipe step fills the screen (no scrolling under a finger)

  if (tut) {
    body = <Tutorial onDone={tutDone} />;
  } else if (!shown || !step) {
    // ---- no session: join or start (two play cards, as the website's) ----
    const ready = codeOk(typed);
    body = (
      <>
        <Eyebrow star style={s.kickerRow}>
          {WORDS.entry}
        </Eyebrow>
        <Text style={s.h1} accessibilityRole="header">
          {WORDS.feature}
        </Text>
        <Text style={s.sub}>{WORDS.entryLine}</Text>
        <Tap uiId="group.howto" flat onPress={() => setTut(true)} style={s.linkLeft} accessibilityRole="button">
          <Text style={s.linkText}>{WORDS.howItWorks}</Text>
        </Tap>
        <PlayCard style={s.card}>
          <Text style={s.cardHead}>{WORDS.joinCode}</Text>
          <Text style={s.helpLeft}>{WORDS.codeHelp}</Text>
          <View style={s.joinRow}>
            <Field
              value={typed}
              onChangeText={t => {
                setTyped(tidyCode(t));
                setErr('');
              }}
              placeholder="CODE"
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              maxLength={4}
              returnKeyType="go"
              onSubmitEditing={() => join(typed)}
              accessibilityLabel={WORDS.codeLabel}
              style={s.codeField}
            />
            <Key uiId="group.join" kind={ready ? 'aurora' : 'glass'} label={WORDS.join} onPress={() => join(typed)} disabled={busy === 'join'} calm={pcalm} />
          </View>
          {errLine}
        </PlayCard>
        <PlayCard style={s.card}>
          <Text style={s.cardHead}>{WORDS.startHere}</Text>
          {opts ? <Choices opts={opts} value={draft} onPick={p => setDraft(d => ({...d, ...p}))} /> : <ActivityIndicator color={PLAY.ink} style={s.spin} />}
          <Key uiId="group.start" kind="aurora" label={WORDS.startHere} onPress={start} disabled={busy === 'start'} calm={pcalm} style={s.wide} />
        </PlayCard>
      </>
    );
  } else if (step === 'lobby') {
    const letters = code.split('');
    body = (
      <>
        {/* the website's code block and the TV's join panel: Join in, the code as a ticket, the QR
            code another phone's camera reads, how to join, and the server's address */}
        <PlayCard style={[s.card, s.centered]}>
          <Eyebrow>{WORDS.joinTitle}</Eyebrow>
          <View style={s.ticket} accessible accessibilityLabel={code.split('').join(' ')}>
            {letters.map((ch, i) => (
              <View key={i} style={s.ticketTile}>
                <Text style={s.ticketText}>{ch}</Text>
              </View>
            ))}
            <Text style={s.sr} selectable>
              {code}
            </Text>
          </View>
          <View style={s.qr} accessibilityLabel={`QR code for ${joinUrl(getBaseUrl(), code)}`}>
            <QRCode value={joinUrl(getBaseUrl(), code)} size={QR_SIZE} backgroundColor="#ffffff" color="#0b0c14" />
          </View>
          <Text style={s.help}>{WORDS.joinLine}</Text>
          <Text style={s.hostLine} numberOfLines={1}>
            {hostOf(getBaseUrl())}
          </Text>
        </PlayCard>
        <PlayCard style={s.card}>
          <Text style={s.cardHead}>{joinedLine(shown)}</Text>
          <Seats session={shown} calm={pcalm} room seen={seen} size={56} />
          <View style={s.sep} />
          {isHost && opts ? (
            <Choices opts={opts} value={shown.settings} busy={busy === 'settings'} onPick={p => run('settings', () => groupApi.settings(code, p))} />
          ) : (
            <>
              <Text style={s.choiceLine}>{choiceLine(opts, shown.settings)}</Text>
              {!isHost ? <Text style={s.help}>{WORDS.onlyHost}</Text> : null}
            </>
          )}
        </PlayCard>
        {shown.added.length ? (
          <View style={s.addedBox}>
            <Text style={s.label}>{WORDS.addedSoFar}</Text>
            {shown.added.map(a => (
              <Text key={a.key} style={s.addedRow} numberOfLines={1}>
                {`${a.title} · ${addedLine(a.by)}`}
              </Text>
            ))}
          </View>
        ) : null}
        {errLine}
        <View style={s.actions}>
          {addButton}
          {isHost ? <Key uiId="group.deal" kind="aurora" label={WORDS.startSwiping} onPress={() => run('deal', () => groupApi.start(code))} disabled={busy === 'deal' || shown.voters < 1} calm={pcalm} style={s.grow} /> : null}
        </View>
        {isHost && shown.voters < 1 ? <Text style={s.help}>{WORDS.needSomeone}</Text> : null}
        {footer}
        {howTo}
      </>
    );
  } else if (step === 'swipe') {
    fixed = true;
    const deckN = shown.deck.length;
    const handN = Math.min(deckN, deckN - cards.length + 1);
    const frac = shown.deadline && shown.limitSec && follow.current ? Math.max(0, Math.min(1, secondsLeft(shown, Date.now() - follow.current.receivedAt()) / shown.limitSec)) : 0;
    body = (
      <SwipeStage
        card={card}
        left={cards.length}
        flying={flying}
        xy={xy}
        lift={lift}
        responder={responder}
        onVote={v => vote(v)}
        head={
          <View style={s.swipeHead}>
            <View style={s.swipeTop}>
              <View style={s.shrink}>
                <Text style={s.hand}>{SHOW.card(Math.max(1, handN), deckN)}</Text>
                <Text style={s.progress} numberOfLines={1}>
                  {left ? <Text style={s.timeLeft}>{left}</Text> : null}
                  {left ? ' · ' : ''}
                  {progressLine(shown)}
                </Text>
              </View>
              <Tap uiId="group.undo" flat disabled={!answers.history.length} accessibilityRole="button" accessibilityLabel={WORDS.undo} onPress={takeBack} style={[s.roundTool, !answers.history.length && s.off]}>
                <Text style={s.roundGlyph}>↶</Text>
              </Tap>
              <Tap uiId="group.add" flat accessibilityRole="button" accessibilityLabel={WORDS.addTitle} onPress={() => setAdding(true)} style={s.roundTool}>
                <Text style={s.roundGlyph}>+</Text>
              </Tap>
            </View>
            {shown.deadline ? (
              <View style={s.timeRow}>
                <View style={s.grow} onLayout={e => setTimeW(Math.round(e.nativeEvent.layout.width))}>
                  {timeW ? <Meter value={frac} width={timeW} height={8} ms={900} steady calm={pcalm} /> : null}
                </View>
                <View style={s.minis} importantForAccessibility="no-hide-descendants">
                  {peopleOf(shown)
                    .filter(m => m.role === 'voter')
                    .slice(0, 5)
                    .map(m => (
                      <View key={m.profileId} style={[s.mini, m.done && s.miniDone]}>
                        <Avatar p={{name: m.name, avatar: m.avatar || '🙂', avatarImage: m.avatarImage || null, color: ''}} size={22} round />
                      </View>
                    ))}
                </View>
              </View>
            ) : null}
          </View>
        }
        foot={errLine}
      />
    );
  } else if (step === 'waiting') {
    body = (
      <>
        {kicker}
        <Text style={[s.h1, s.center1]} accessibilityRole="header">
          {WORDS.doneWaiting}
        </Text>
        <Text style={s.help}>{[progressLine(shown), left].filter(Boolean).join(' · ')}</Text>
        <PlayCard style={[s.card, s.centered]}>
          <Seats session={shown} calm={pcalm} deck={shown.deck.length} seen={seen} size={70} />
        </PlayCard>
        {errLine}
        <View style={s.actions}>
          {answers.history.length ? <Key uiId="group.undo" small glyph="↶" label={WORDS.undo} onPress={takeBack} calm={pcalm} /> : null}
          {addButton}
          {isHost ? <Key uiId="group.extend" small label={WORDS.oneMore} onPress={() => run('extend', () => groupApi.extend(code))} disabled={busy === 'extend'} calm={pcalm} /> : null}
          {isHost ? <Key uiId="group.finish" kind="aurora" label={WORDS.showNow} onPress={() => run('finish', () => groupApi.finish(code))} disabled={busy === 'finish'} calm={pcalm} style={s.wideKey} /> : null}
        </View>
        {footer}
      </>
    );
  } else if (step === 'result') {
    const pick = currentPick(shown);
    const r = shown.result;
    const picks = r?.picks.length || 0;
    const scr = screenOf(shown);
    const posterW = Math.min(200, Math.round(win.width * 0.5));
    const nextIndex = hasNextPick(shown) ? (r?.index || 0) + 1 : 0;
    const fresh = dropRun > 0 && !pcalm;
    body = pick ? (
      <>
        <View style={s.centered}>
          <View ref={prizeRef} collapsable={false} style={s.prizePoster}>
            <Image source={GLOW_SRC} fadeDuration={0} style={[s.prizeGlow, {width: posterW * 2.2, height: posterW * 2.2, left: -posterW * 0.6, top: -posterW * 0.85}]} />
            <In calm={!fresh} drop run={`${dropRun}:${r?.index}`}>
              <PosterArt name={pick.card.title} poster={pick.card.poster || null} w={posterW} h={Math.round(posterW * 1.5)} radius={22} gold />
            </In>
          </View>
          <View style={s.prizeKicker}>
            <Star size={13} color={PLAY.gold} />
            <Text style={s.prizeKickerText}>{WORDS.resultTitle}</Text>
            {picks > 1 ? <Text style={s.prizeCount}>{` · ${(r?.index || 0) + 1} / ${picks}`}</Text> : null}
          </View>
          <Text style={[ty.h1, s.resultTitle]} accessibilityRole="header" numberOfLines={3}>
            {pick.card.title}
          </Text>
          {cardMeta(pick.card) ? <Text style={s.meta}>{cardMeta(pick.card)}</Text> : null}
          <View style={s.tallyLine}>
            <TallyRow pick={pick} calm={!fresh} />
            {pick.why ? (
              <View style={s.whyChip}>
                <Text style={s.why}>{`✓ ${pick.why}`}</Text>
              </View>
            ) : null}
          </View>
          {r && r.index === 0 && isTie(r) && (pcalm || !fresh) ? <Text style={s.tieLine}>{SHOW.tieLine}</Text> : null}
        </View>
        {errLine}
        {pressedPlay && scr && !playsHere(shown, true) ? <Text style={s.help}>{scr.app === 'tv' ? WORDS.startingOnTv : WORDS.startingOnScreen}</Text> : null}
        <View style={s.actions}>
          <Key uiId="group.play" kind="gold" glyph="▶" label={playLabel(shown)} onPress={play} disabled={busy === 'play'} calm={pcalm} style={s.grow} />
          {picks > 1 ? (
            <Key uiId="group.next" label={hasNextPick(shown) ? WORDS.somethingElse : WORDS.firstPick} onPress={() => run('next', () => groupApi.pick(code, nextIndex))} disabled={busy === 'next'} calm={pcalm} style={s.grow} />
          ) : null}
        </View>
        {isHost ? (
          <View style={s.actionsTight}>
            <Key uiId="group.again" label={WORDS.again} onPress={() => run('again', () => groupApi.again(code))} disabled={busy === 'again'} calm={pcalm} style={s.grow} />
          </View>
        ) : null}
        {footer}
      </>
    ) : (
      <>
        <Eyebrow star style={s.kickerRow}>
          {WORDS.feature}
        </Eyebrow>
        <PlayCard style={[s.card, s.centered]}>
          <Text style={[ty.h2, s.center1]} accessibilityRole="header">
            {WORDS.noMatch}
          </Text>
          <Text style={s.help}>{WORDS.noMatchLine}</Text>
        </PlayCard>
        {errLine}
        <View style={s.actions}>
          {isHost ? <Key uiId="group.again" kind="aurora" label={WORDS.again} onPress={() => run('again', () => groupApi.again(code))} disabled={busy === 'again'} calm={pcalm} style={s.grow} /> : <Text style={s.help}>{WORDS.onlyHost}</Text>}
        </View>
        {footer}
      </>
    );
  } else if (step === 'chosen') {
    const ch = shown.chosen;
    const scr = screenOf(shown);
    const posterW = Math.min(170, Math.round(win.width * 0.44));
    body = (
      <>
        {kicker}
        <View style={s.centered}>
          {ch ? <PosterArt name={ch.card.title} poster={ch.card.poster || null} w={posterW} h={Math.round(posterW * 1.5)} radius={20} gold /> : null}
          <Text style={[ty.h1, s.resultTitle]} accessibilityRole="header">
            {WORDS.enjoy}
          </Text>
          {ch ? <Text style={s.h2c}>{ch.card.title}</Text> : null}
          {ch?.by ? <Text style={s.help}>{`${ch.by} ${WORDS.pressedPlay}`}</Text> : null}
          {scr && shown.you?.role !== 'screen' ? <Text style={s.help}>{scr.app === 'tv' ? WORDS.startingOnTv : WORDS.startingOnScreen}</Text> : null}
        </View>
        {/* the title on this phone too (its page; nothing starts by itself) */}
        <View style={s.actions}>{ch ? <Key small label={WORDS.open} onPress={() => openHere(ch.card, false)} calm={pcalm} /> : null}</View>
        {footer}
      </>
    );
  } else {
    // ended (by the starter, the clock, or the server no longer knows it)
    body = (
      <>
        {kicker}
        <PlayCard style={[s.card, s.centered]}>
          <Star size={30} color="rgba(232,228,255,0.45)" />
          <Text style={[ty.h2, s.center1, s.endedTitle]} accessibilityRole="header">
            {WORDS.ended}
          </Text>
          {shown.ended?.reason || (lost && lost !== WORDS.ended) ? <Text style={s.help}>{shown.ended?.reason || lost}</Text> : null}
        </PlayCard>
        {footer}
      </>
    );
  }

  return (
    <View style={s.root}>
      <PlayRoom calm={pcalm} />
      {fixed ? (
        <View style={[s.root, {paddingTop: barTop + 56, paddingBottom: bottom}]}>{body}</View>
      ) : (
        <KeyboardAvoidingView behavior="height" style={s.root}>
          <ScrollView ref={scroller} keyboardShouldPersistTaps="handled" contentContainerStyle={[{paddingTop: top, paddingBottom: bottom + 24, paddingHorizontal: GUTTER}, column]}>
            <View style={s.page}>{body}</View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
      {code ? <AddSheet code={code} visible={adding} onClose={() => setAdding(false)} onAdded={() => follow.current?.refresh()} /> : null}
      <Burst fire={burst.n} x={burst.x} y={burst.y} count={16} calm={pcalm} reach={Math.max(win.width, 600) * 0.8} />
      {showing != null && shown?.result ? <RevealShow result={shown.result} onEnd={endShow} bottom={bottom} /> : null}
      <BackBar />
    </View>
  );
}

const QR_SIZE = 196;

const s = StyleSheet.create({
  root: {flex: 1},
  page: {width: '100%', maxWidth: 560, alignSelf: 'center'},
  center: {alignItems: 'center', justifyContent: 'center'},
  centered: {alignItems: 'center'},
  center1: {textAlign: 'center'},
  grow: {flexGrow: 1, flexBasis: 0},
  shrink: {flex: 1, minWidth: 0},
  off: {opacity: 0.4},
  sr: {position: 'absolute', width: 1, height: 1, opacity: 0},
  spin: {marginVertical: 14},
  kickerRow: {justifyContent: 'flex-start', marginBottom: 10},
  h1: {color: PLAY.ink, fontSize: 34, fontWeight: '900', letterSpacing: -1, lineHeight: 37},
  sub: {color: PLAY.inkDim, fontSize: 16.5, lineHeight: 23, marginTop: 8},
  h2c: {color: PLAY.ink, fontSize: 19, fontWeight: '800', textAlign: 'center', marginTop: 6},
  label: {color: 'rgba(232,228,255,0.55)', fontSize: 11.5, fontWeight: '800', letterSpacing: 1.4, marginBottom: 8, textTransform: 'uppercase'},
  help: {color: PLAY.inkDim, fontSize: 14.4, lineHeight: 20, textAlign: 'center', marginTop: 8},
  helpLeft: {color: PLAY.inkDim, fontSize: 14.4, lineHeight: 20, marginTop: 4},
  err: {color: '#ffc9a8', fontSize: 14.4, lineHeight: 20, textAlign: 'center', marginTop: 10},
  card: {padding: 20, marginTop: 16},
  cardHead: {color: PLAY.ink, fontSize: 20, fontWeight: '900', letterSpacing: -0.3, marginBottom: 6},
  wide: {alignSelf: 'stretch', marginTop: 14},
  wideKey: {flexGrow: 1},
  // join: the code field as a ticket waiting for its letters
  joinRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14},
  codeField: {flex: 1, textAlign: 'center', fontSize: 28, fontWeight: '900', letterSpacing: 10, height: 64, borderStyle: 'dashed', borderWidth: 2, borderColor: 'rgba(232,228,255,0.3)', borderRadius: 18, backgroundColor: 'rgba(4,4,16,0.55)'},
  // the lobby's code: four tiles, the QR on a white tile
  ticket: {flexDirection: 'row', gap: 10, marginVertical: 14},
  ticketTile: {width: 58, height: 70, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f2efff', borderBottomWidth: 5, borderBottomColor: '#9f96d6', boxShadow: '0 10px 24px -10px rgba(0,0,0,0.8)'},
  ticketText: {color: '#151236', fontSize: 38, fontWeight: '900', includeFontPadding: false},
  qr: {padding: 14, marginTop: 4, marginBottom: 6, borderRadius: 18, backgroundColor: '#ffffff'},
  hostLine: {color: PLAY.ink, fontSize: 15.2, fontWeight: '800', marginTop: 6},
  sep: {height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginVertical: 16},
  choiceRow: {marginTop: 12},
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  choiceLine: {color: PLAY.ink, fontSize: 15.68, fontWeight: '800', textAlign: 'center'},
  link: {alignSelf: 'center', marginTop: 18, paddingVertical: 10, paddingHorizontal: 14},
  linkLeft: {alignSelf: 'flex-start', marginTop: 10, paddingVertical: 8},
  linkText: {color: PLAY.green, fontSize: 15, fontWeight: '800'},
  actions: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 18},
  actionsTight: {flexDirection: 'row', marginTop: 10},
  footer: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 24},
  endAll: {},
  // seats
  seats: {flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 10},
  seat: {alignItems: 'center'},
  seatIn: {alignItems: 'center', gap: 6},
  away: {opacity: 0.45},
  seatFace: {alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.16)'},
  seatStar: {position: 'absolute', top: -3, right: -3, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: PLAY.gold, borderWidth: 2, borderColor: '#0d0c24'},
  seatTick: {position: 'absolute', bottom: -3, right: -3, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: PLAY.green, borderWidth: 2, borderColor: '#0d0c24'},
  seatTickText: {color: '#04221c', fontSize: 13, fontWeight: '900'},
  seatName: {color: PLAY.ink, fontSize: 13.5, fontWeight: '800', maxWidth: '100%'},
  seatRibbon: {marginTop: 1},
  seatFree: {alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderStyle: 'dashed', borderColor: 'rgba(232,228,255,0.25)'},
  seatFreeText: {color: 'rgba(232,228,255,0.45)', fontSize: 24, fontWeight: '700'},
  badge: {color: 'rgba(232,228,255,0.62)', fontSize: 11.5, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden'},
  badgeDone: {color: PLAY.green},
  addedBox: {marginTop: 18},
  addedRow: {color: PLAY.inkDim, fontSize: 14.4, lineHeight: 22},
  // posters
  poster: {borderRadius: radius.l, overflow: 'hidden', backgroundColor: PLAY.tile, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)'},
  fallback: {alignItems: 'center', justifyContent: 'center', gap: 12, padding: 12, backgroundColor: PLAY.tile, experimental_backgroundImage: 'linear-gradient(160deg, #2a2266 0%, #120e34 100%)'},
  fallbackText: {color: PLAY.ink, fontSize: 17, fontWeight: '900', textAlign: 'center'},
  // the result, as a prize
  prizePoster: {marginTop: 6},
  prizeGlow: {position: 'absolute', tintColor: PLAY.gold, opacity: 0.32},
  prizeKicker: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 22},
  prizeKickerText: {color: PLAY.gold, fontSize: 12.5, fontWeight: '900', letterSpacing: 2.2, textTransform: 'uppercase'},
  prizeCount: {color: 'rgba(232,228,255,0.55)', fontSize: 12.5, fontWeight: '900'},
  resultTitle: {fontSize: 32, lineHeight: 35, marginTop: 10},
  meta: {color: 'rgba(232,228,255,0.62)', fontSize: 15, fontWeight: '800', marginTop: 8, textAlign: 'center'},
  tallyLine: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 16},
  tally: {flexDirection: 'row', alignItems: 'center', gap: 4},
  tallyDot: {width: 7, height: 7, borderRadius: 4, margin: 7, backgroundColor: 'rgba(232,228,255,0.25)'},
  whyChip: {paddingHorizontal: 14, minHeight: 36, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: PLAY.line, backgroundColor: 'rgba(255,255,255,0.06)'},
  why: {color: PLAY.ink, fontSize: 14.5, fontWeight: '800'},
  tieLine: {color: PLAY.gold, fontSize: 14.5, fontWeight: '800', marginTop: 10, textAlign: 'center'},
  endedTitle: {marginTop: 10},
  bigGlyph: {fontSize: 38, color: PLAY.green, marginBottom: 2},
  // the show
  show: {zIndex: 40, backgroundColor: PLAY.night0},
  showIn: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 22},
  showWords: {fontSize: 34, lineHeight: 38},
  showStars: {flexDirection: 'row', gap: 22},
  duel: {flexDirection: 'row', gap: 18, marginTop: 6},
  duelCard: {borderRadius: 18, padding: 3, borderWidth: 3, borderColor: 'transparent', opacity: 0.6},
  duelLit: {borderColor: 'rgba(255,242,194,0.85)', opacity: 1, transform: [{scale: 1.04}]},
  duelWon: {borderColor: PLAY.gold, opacity: 1, boxShadow: '0 0 30px rgba(255,209,102,0.6)', transform: [{scale: 1.08}]},
  showSkip: {position: 'absolute', bottom: 48, left: 0, right: 0, alignItems: 'center'},
  // the search sheet's rows
  sheetBody: {paddingHorizontal: GUTTER},
  hit: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, minHeight: 64},
  hitPoster: {borderRadius: 8},
  hitTitle: {color: colors.text, fontSize: 15.68, fontWeight: '700'},
  hitMeta: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3},
  hitYear: {color: colors.textFaint, fontSize: 13.6},
  hitAdd: {color: colors.text, fontSize: 22, fontWeight: '700', minWidth: 32, textAlign: 'center'},
  hitIn: {color: colors.textFaint, fontSize: 12.5, fontWeight: '800'},
  libBadge: {color: '#0b0c14', backgroundColor: colors.owned, fontSize: 11, fontWeight: '900', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, overflow: 'hidden'},
  // the swipe step (the same deck as Taste)
  swipeHead: {paddingHorizontal: GUTTER, marginBottom: 8},
  swipeTop: {flexDirection: 'row', alignItems: 'center', gap: 8},
  hand: {color: PLAY.ink, fontSize: 22, fontWeight: '900', letterSpacing: -0.4},
  timeLeft: {color: PLAY.ink, fontWeight: '900', fontVariant: ['tabular-nums']},
  progress: {color: PLAY.inkDim, fontSize: 13.6, fontWeight: '700', marginTop: 2},
  roundTool: {width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: PLAY.line},
  roundGlyph: {color: PLAY.ink, fontSize: 19, fontWeight: '900', marginTop: -2},
  timeRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12},
  minis: {flexDirection: 'row'},
  mini: {marginLeft: -6, borderRadius: 13, borderWidth: 2, borderColor: '#0d0c24', opacity: 0.55},
  miniDone: {opacity: 1, borderColor: PLAY.green},
  stage: {flex: 1, minHeight: 240, marginHorizontal: GUTTER},
  card2: {position: 'absolute', left: 0, top: 0, borderRadius: 22, overflow: 'hidden', backgroundColor: PLAY.tile, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)'},
  cardBadge: {position: 'absolute', top: 14, right: 14},
  info: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 80, paddingHorizontal: 18, paddingBottom: 18, experimental_backgroundImage: INFO_FADE},
  cardTitle: {color: PLAY.ink, fontSize: 22, fontWeight: '900', lineHeight: 26, letterSpacing: -0.3},
  cardMeta: {color: 'rgba(232,228,255,0.78)', fontSize: 14, fontWeight: '800', marginTop: 5},
  cardLine: {color: 'rgba(232,228,255,0.7)', fontSize: 13.8, lineHeight: 18.6, marginTop: 6},
  cardNote: {color: PLAY.maybe, fontSize: 13, fontWeight: '800', marginTop: 6},
  stamp: {paddingHorizontal: 14, paddingVertical: 4, borderWidth: 4, borderRadius: 12, backgroundColor: 'rgba(3,4,12,0.55)'},
  stampLeft: {position: 'absolute', top: 26, left: 18, transform: [{rotate: '-12deg'}]},
  stampRight: {position: 'absolute', top: 26, right: 18, transform: [{rotate: '12deg'}]},
  stampMid: {position: 'absolute', top: '38%', left: 0, right: 0, alignItems: 'center'},
  stampText: {fontSize: 28, fontWeight: '900', letterSpacing: 2.4, includeFontPadding: false},
  answers: {flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-start', gap: 26, marginTop: 10, paddingBottom: 8},
  answer: {alignItems: 'center', gap: 7, paddingHorizontal: 4, paddingVertical: 4, minWidth: 76},
  disc: {alignItems: 'center', justifyContent: 'center', borderBottomWidth: 4},
  discBig: {width: 64, height: 64, borderRadius: 32},
  discSmall: {width: 46, height: 46, borderRadius: 23, marginTop: 9},
  discYes: {backgroundColor: PLAY.green, experimental_backgroundImage: 'linear-gradient(180deg, #8ffad0 0%, #3fe3a3 100%)', borderBottomColor: '#1f9f70'},
  discNo: {backgroundColor: PLAY.rose, experimental_backgroundImage: 'linear-gradient(180deg, #ffa8dd 0%, #ff6fbf 100%)', borderBottomColor: '#c2408c'},
  discMaybe: {backgroundColor: 'rgba(255,255,255,0.1)', borderWidth: 1, borderColor: PLAY.line, borderBottomColor: 'rgba(0,0,0,0.45)'},
  discGlyph: {fontSize: 27, fontWeight: '900', includeFontPadding: false},
  discGlyphSmall: {fontSize: 19},
  answerLabel: {color: PLAY.inkDim, fontSize: 13, fontWeight: '800'},
  // the explanation
  tut: {padding: 22, marginTop: 8},
  tutTitle: {color: colors.text, fontSize: 21.6, fontWeight: '900', textAlign: 'center', marginTop: 18},
  tutBody: {color: colors.textDim, fontSize: 15.68, lineHeight: 23, textAlign: 'center', marginTop: 8, minHeight: 69},
  dots: {flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 18},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)'},
  dotOn: {width: 18, backgroundColor: colors.text},
  tutButtons: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 20},
  art: {height: 150, alignItems: 'center', justifyContent: 'center'},
  artRow: {flexDirection: 'row', gap: 14, alignItems: 'flex-end'},
  artTv: {width: 180, height: 104, borderRadius: 10, borderWidth: 3, borderColor: 'rgba(255,255,255,0.55)', backgroundColor: 'rgba(60,64,150,0.25)', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 10},
  artCode: {color: colors.text, fontSize: 22, fontWeight: '900', letterSpacing: 4},
  artQr: {width: 40, height: 40, borderRadius: 4, borderWidth: 6, borderColor: 'rgba(255,255,255,0.7)', borderStyle: 'dotted'},
  artStand: {width: 60, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.4)', marginTop: 8},
  artPhone: {width: 52, height: 92, borderRadius: 10, borderWidth: 2.5, borderColor: 'rgba(255,255,255,0.55)', padding: 5},
  artPhoneMid: {height: 104, transform: [{translateY: -8}]},
  artPhoneScreen: {flex: 1, borderRadius: 5, backgroundColor: 'rgba(139,123,255,0.35)'},
  artCard: {width: 82, height: 118, borderRadius: 10, backgroundColor: 'rgba(139,123,255,0.30)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.45)', alignItems: 'center', justifyContent: 'center'},
  artTilt: {transform: [{rotate: '6deg'}]},
  artMarks: {flexDirection: 'row', gap: 12, marginTop: -14},
  artMark: {width: 34, height: 34, borderRadius: 17, borderWidth: 2, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(10,12,22,0.9)'},
  artMarkText: {fontSize: 16, fontWeight: '900'},
  artStar: {color: '#f0c67e', fontSize: 40},
});
