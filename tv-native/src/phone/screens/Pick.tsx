// "AI pick" on the phone — the website's AI page (public/js/screens/pickforme.js, docs/play/
// pickforme.md "The Draw") at its phone size, in the Aurora Play look: describe the mood, flip
// Movies / Shows, set the two taste dials (chunky game chips), and the answer is DRAWN — while
// the server thinks, card backs turn in a reel; the posters roll in, the reel slows and lands
// on the first pick (a tick each poster that passes), a beat, then the prize: a gold flash, the
// meteor burst (the flow's one reward), "Tonight's pick", the title, the reason, Open and
// Another one. Under it "The whole hand": every pick with its reason, the drawn one ringed.
//
// Same words, same ask (POST /api/ai/recommend), the same rule for when the page is there at
// all (GET /api/ai/status → enabled, phone/aiStatus.ts). A pick opens through the shared
// openItem, so it opens and plays like a title found any other way.
//
// The last answer lives at module scope (as on the site): coming back to the page paints the
// prize again, still — no spin, no burst. It is this profile's: dropped when the profile is
// left (profileScope.ts), and stamped with whoever asked.
//
// Remove animations: no reel; while waiting a still card back and the words; the answer is
// the prize at once; Another one is a plain swap. No burst.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Animated, Image, Keyboard, LayoutChangeEvent, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions} from 'react-native';
import {api, HeroItem} from '../../api';
import {useApp} from '../../AppContext';
import {useMe} from '../../navSection';
import {openItem} from '../../openItem';
import {registerProfileCache} from '../../profileScope';
import {showToast} from '../../toast';
import {WORDS as GROUP} from '../../groupPick'; // [group-pick]
import {usePNav} from '../nav';
import {aiEnabled, aiKnown} from '../aiStatus';
import {BackBar, useColumn, usePageTop, useSolidBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import Tap from '../ui/Tap';
import {phoneNative} from '../native';
import {GUTTER} from '../theme';
import Burst from '../../play/Burst';
import {LINEAR, tween, useCalm, useInFront, useTimers, useValue} from '../../play/anim';
import {GLOW_SRC, Star} from '../../play/Star';
import {PLAY} from '../../play/tokens';
import {HOLD_MS, LAND_MS, landingStrip, nextDraw, reelStops, RESPIN_MS, respinStrip} from '../../play/reel';
import {AURORA, Eyebrow, GameChip, In, Key, PlayCard, PlayRoom, ty} from '../play/ui';
import {CardBack, Poster} from '../play/art';
import {DRAW, metaLine, showPips, tickTimes} from '../play/pickWords';

// ---- pickforme.js, verbatim (the ids are what src/media/ai.js understands) ----
const EXAMPLES = [
  "something dumb and loud, I've had a long day",
  'slow and beautiful, nothing scary',
  'a clever thriller that respects my time',
  'makes me cry in a good way',
  'comfort food, seen it a hundred times energy',
];
// Movies or Shows: the server takes a 0..100 mix, these are its two ends
const KINDS = [
  {id: 'movie', label: 'Movies', mix: 0},
  {id: 'show', label: 'Shows', mix: 100},
] as const;
type Kind = (typeof KINDS)[number]['id'];
const ERAS = [
  {id: 'any', label: 'Any era'},
  {id: 'fresh', label: 'Recent'},
  {id: 'modern', label: 'Not too old'},
  {id: 'classic', label: 'A classic'},
];
// length means different things for a film and a series: the row swaps with the switch
const LENGTHS: Record<Kind, {id: string; label: string}[]> = {
  movie: [
    {id: 'any', label: 'Any length'},
    {id: 'short', label: 'Under 100 min'},
    {id: 'standard', label: 'Under 2 hours'},
    {id: 'epic', label: 'Something long'},
  ],
  show: [
    {id: 'any', label: 'Any length'},
    {id: 'limited', label: 'One or two seasons'},
    {id: 'meaty', label: 'Many seasons'},
  ],
};
// the wait narrates itself (several seconds on one word looks broken)
const STAGES = ['Reading the room…', 'Ransacking the archives…', 'Arguing with itself about your taste…', 'Checking which of these Aurora can actually play…'];
const STAGE_MS = 2600;
const W = {
  title: 'AI',
  sub: "Describe the mood in your own words. It searches everything Aurora can play — not just what's already downloaded.",
  placeholder: 'What are you in the mood for?',
  go: 'Find me something',
  switchLabel: 'Recommend movies or shows',
  era: 'Era',
  length: 'Length',
  tryLabel: 'Try:',
  waitHint: 'Asking for actual opinions, not running a database query — give it a few seconds.',
  empty: 'Nothing came back for that. Try describing it differently.',
  failed: "The recommender didn't answer.",
  // (the website hides the page when the server says no; a link or a stale list here says why —
  // the TV's words for a server without a key, the server's own for a kids profile)
  off: 'The recommender isn’t set up on this server. The admin adds a key under Admin → Server to switch it on.',
  offKids: 'The recommender is switched off in kids profiles.',
};
/** The bar's title once the page has scrolled (docs/android-phone/NAV.md's words). */
const PAGE_TITLE = 'AI'; // the website's and the TV's word (web h1 "AI")

type PickItem = HeroItem & {why?: string | null};
type Answer = {vibe: string; kind: Kind; era: string; length: string; items: PickItem[]; status: string; owner: string; draw: number};
// the last answer, for the profile that asked it (and nobody else)
let last: Answer | null = null;
registerProfileCache('phone/screens/Pick', () => {
  last = null;
});

/** "6 films for “…”" — pickforme.js's status line, word for word. */
export function statusLine(n: number, kind: Kind, vibe: string, cached: boolean, era: string, length: string): string {
  const noun = kind === 'show' ? (n === 1 ? 'show' : 'shows') : n === 1 ? 'film' : 'films';
  return (
    `${n} ${noun} for “${vibe}”` +
    (cached ? ' · from earlier' : '') +
    (n < 5 && (era !== 'any' || length !== 'any') ? ' · not much fits those filters, try loosening one' : '')
  );
}

const art = (it: PickItem) => it.cover || it.poster || null;

/** One labelled dial row: the caps label, then its chips, wrapping. */
function Dial({label, options, value, onPick}: {label: string; options: {id: string; label: string}[]; value: string; onPick: (id: string) => void}) {
  return (
    <View style={s.group}>
      <Text style={s.groupLabel}>{label.toUpperCase()}</Text>
      {options.map(o => (
        <GameChip key={o.id} uiId="pick.option" label={o.label} on={o.id === value} onPress={() => onPick(o.id)} />
      ))}
    </View>
  );
}

/** Three stars that light in turn while Aurora thinks. */
function Dots({calm}: {calm: boolean}) {
  const t = useValue(0);
  useEffect(() => {
    if (calm) return;
    const loop = Animated.loop(tween(t, 1, 1500, {easing: LINEAR}));
    loop.start();
    return () => loop.stop();
  }, [t, calm]);
  const colours = [PLAY.green, PLAY.teal, PLAY.violet];
  return (
    <View style={s.dots} importantForAccessibility="no-hide-descendants">
      {colours.map((c, i) => {
        const a = i / 3;
        const op = calm ? 0.8 : t.interpolate({inputRange: [0, a, a + 0.16, a + 0.34, 1], outputRange: [0.3, 0.3, 1, 0.3, 0.3], extrapolate: 'clamp'});
        return (
          <Animated.View key={i} style={{opacity: op as never}}>
            <Star size={17} color={c} />
          </Animated.View>
        );
      })}
    </View>
  );
}

type Spin = {cells: (number | 'back')[]; last: number; ms: number; key: number; from?: number} | null;

/** The reel: a poster-sized window, gold notches at the payline; card backs going round while
 *  waiting, then one strip rolling to its last cell (one value on the native driver). */
function Reel({w, h, items, mode, spin, showing, calm, flash, onLanded}: {
  w: number;
  h: number;
  items: PickItem[];
  mode: 'waiting' | 'rolling' | 'won';
  spin: Spin;
  showing: number;
  calm: boolean;
  flash: Animated.Value;
  onLanded: () => void;
}) {
  const loop = useValue(0);
  const roll = useValue(0);
  const landed = useRef(onLanded);
  landed.current = onLanded;
  useEffect(() => {
    if (mode !== 'waiting' || calm) return;
    loop.setValue(0);
    const a = Animated.loop(tween(loop, 1, 520 * 2, {easing: LINEAR}));
    a.start();
    return () => a.stop();
  }, [mode, calm, loop]);
  useEffect(() => {
    if (!spin || mode !== 'rolling') return;
    roll.setValue(0);
    const ticks = tickTimes(spin.last, spin.ms).map(ms => setTimeout(() => phoneNative.haptic('tick'), ms));
    const a = tween(roll, 1, spin.ms, {easing: LINEAR});
    a.start(({finished}) => {
      if (finished) landed.current();
    });
    return () => {
      a.stop();
      ticks.forEach(clearTimeout);
    };
  }, [spin, mode, roll]);
  const cell = (c: number | 'back', k: number) =>
    c === 'back' ? (
      <CardBack key={k} w={w} h={h} word={false} radius={0} />
    ) : (
      <Poster key={k} name={items[c]?.title || ''} poster={items[c] ? art(items[c]) : null} w={w} h={h} radius={0} />
    );
  let strip: React.ReactNode;
  if (mode === 'waiting') {
    strip = (
      <Animated.View style={{transform: [{translateY: calm ? 0 : (loop.interpolate({inputRange: [0, 1], outputRange: [0, -2 * h]}) as never)}]}}>
        {['back', 'back', 'back'].map((c, k) => cell(c as 'back', k))}
      </Animated.View>
    );
  } else if (mode === 'rolling' && spin) {
    const stops = reelStops(spin.last, h, 48);
    strip = <Animated.View style={{transform: [{translateY: roll.interpolate(stops) as never}]}}>{[...spin.cells, 'back' as const].map((c, k) => cell(c, k))}</Animated.View>;
  } else {
    strip = cell(showing, 0);
  }
  return (
    <View style={{width: w + 40, height: h, alignItems: 'center'}} importantForAccessibility="no-hide-descendants">
      <View style={[s.reel, {width: w, height: h}, mode === 'won' && s.reelWon]}>
        {strip}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, s.flash, {opacity: flash}]} />
      </View>
      <View style={[s.notch, s.notchL, {top: h / 2 - 7}]} />
      <View style={[s.notch, s.notchR, {top: h / 2 - 7}]} />
    </View>
  );
}

export default function Pick() {
  const bar = useSolidBar();
  const top = usePageTop();
  const column = useColumn();
  const bottom = useTabBarSpace();
  const navigation = usePNav();
  const front = useInFront(navigation as never);
  const {profileId} = useApp();
  const me = useMe(profileId);
  const {width} = useWindowDimensions();
  const calm = useCalm();
  const timers = useTimers();
  if (last && last.owner !== profileId) last = null;
  const mine = last;

  const [enabled, setEnabled] = useState<boolean | null>(aiKnown());
  const [vibe, setVibe] = useState(mine?.vibe || '');
  const [kind, setKind] = useState<Kind>(mine?.kind || 'movie');
  const [era, setEra] = useState(mine?.era || 'any');
  const [length, setLength] = useState(mine?.length || 'any');
  const [busy, setBusy] = useState(false);
  const [stageNo, setStageNo] = useState(0);
  const [items, setItems] = useState<PickItem[]>(mine?.items || []);
  const [status, setStatus] = useState(mine?.status || '');
  const [draw, setDraw] = useState(mine?.draw || 0);
  // the stage: hidden, waiting (backs turn), rolling (the posters roll in), won (the prize)
  const [mode, setMode] = useState<'none' | 'waiting' | 'rolling' | 'won'>(mine?.items.length ? 'won' : 'none');
  const [spin, setSpin] = useState<Spin>(null);
  const [prizeRun, setPrizeRun] = useState(0); // the prize's words rise again for every draw
  const [fresh, setFresh] = useState(false);
  const [handShown, setHandShown] = useState(!!mine?.items.length);
  const [burst, setBurst] = useState({n: 0, x: 0, y: 0});
  const reelRef = useRef<View>(null);
  const [inputOn, setInputOn] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const scroller = useRef<ScrollView>(null);
  const stageY = useRef(0);
  const live = useRef(true);
  const who = useRef(profileId);
  who.current = profileId;
  const busyRef = useRef(false);
  const flash = useValue(0);
  const spins = useRef(0);

  useEffect(() => {
    live.current = true;
    aiEnabled().then(on => live.current && setEnabled(on));
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (!busy) return;
    setStageNo(0);
    const t = setInterval(() => setStageNo(n => Math.min(n + 1, STAGES.length - 1)), STAGE_MS);
    return () => clearInterval(t);
  }, [busy]);

  // the window, sized from the screen: 170 wide on a phone (150 at 320)
  const reelW = width <= 340 ? 150 : Math.min(190, Math.round(width * 0.44));
  const reelH = Math.round(reelW * 1.5);

  const bringStage = useCallback(() => {
    timers.after(60, () => scroller.current?.scrollTo({y: Math.max(0, stageY.current - top + 20), animated: !calm}));
  }, [timers, top, calm]);

  const ask = useCallback(
    async (override?: string) => {
      const q = (override ?? vibe).trim();
      if (q.length < 3) {
        inputRef.current?.focus();
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      if (override != null) setVibe(override);
      Keyboard.dismiss();
      setBusy(true);
      setStatus('');
      setItems([]);
      setHandShown(false);
      setDraw(0);
      setMode('waiting');
      flash.setValue(0);
      bringStage();
      const asker = profileId; // an answer belongs to whoever asked
      try {
        const mix = KINDS.find(k => k.id === kind)!.mix;
        const res = await api.aiRecommend(q, mix, era, length);
        if (asker !== who.current) return; // the profile changed while it was thinking
        const got = (res.items || []) as PickItem[];
        if (!got.length) {
          if (live.current) {
            setStatus(W.empty);
            setMode('none');
          }
          return;
        }
        const text = statusLine(got.length, kind, q, !!res.cached, era, length);
        // kept before it is painted: an answer that lands while the page is gone waits for its return
        last = {vibe: q, kind, era, length, items: got, status: text, owner: asker, draw: 0};
        if (!live.current) return;
        setItems(got);
        setStatus(text);
        if (calm) {
          setMode('won');
          setHandShown(true);
          setPrizeRun(r => r + 1);
          setFresh(false);
          return;
        }
        // the posters roll in and the reel slows onto the first pick
        const cells: (number | 'back')[] = ['back', ...landingStrip(got.length, 0)];
        setSpin({cells, last: cells.length - 1, ms: LAND_MS, key: ++spins.current});
        setFresh(true);
        setMode('rolling');
      } catch (e) {
        if (live.current) {
          setMode('none');
          showToast((e as Error)?.message || W.failed, '🤖');
        }
      } finally {
        busyRef.current = false;
        if (live.current) setBusy(false);
      }
    },
    [vibe, kind, era, length, profileId, calm, flash, bringStage],
  );

  // the reel has stopped: a beat, then the prize (the flow's one reward on a fresh answer)
  const landed = useCallback(() => {
    timers.after(HOLD_MS, () => {
      if (!live.current) return;
      setMode('won');
      setHandShown(true);
      setPrizeRun(r => r + 1);
      flash.setValue(0);
      Animated.sequence([tween(flash, 0.55, 120), tween(flash, 0, 420)]).start();
      if (fresh) {
        phoneNative.haptic('confirm');
        reelRef.current?.measureInWindow((x, y, w, h) => setBurst(b => ({n: b.n + 1, x: x + w / 2, y: y + h / 2})));
      } else phoneNative.haptic('tick');
    });
  }, [timers, flash, fresh]);

  const another = useCallback(() => {
    if (items.length < 2 || mode !== 'won') return;
    const from = draw;
    const to = nextDraw(draw, items.length);
    setDraw(to);
    if (last && last.items === items) last.draw = to;
    if (calm) {
      setPrizeRun(r => r + 1);
      return;
    }
    const cells = respinStrip(items.length, from, to);
    setFresh(false);
    setSpin({cells, last: cells.length - 1, ms: RESPIN_MS, key: ++spins.current});
    setMode('rolling');
  }, [items, mode, draw, calm]);

  const open = useCallback((it: HeroItem) => openItem(navigation, it), [navigation]);

  const shows = kind === 'show';
  const flip = () => {
    setKind(shows ? 'movie' : 'show');
    setLength('any'); // the length ids are per kind
  };
  const item = items[draw];
  const onStage = (e: LayoutChangeEvent) => {
    stageY.current = e.nativeEvent.layout.y;
  };

  const form = (
    <>
      <PlayCard style={s.box}>
        <TextInput
          ref={inputRef}
          style={[s.input, inputOn && s.inputOn]}
          value={vibe}
          onChangeText={setVibe}
          onFocus={() => setInputOn(true)}
          onBlur={() => setInputOn(false)}
          onSubmitEditing={() => ask()}
          returnKeyType="search"
          placeholder={W.placeholder}
          placeholderTextColor="rgba(232,228,255,0.45)"
          selectionColor={PLAY.teal}
          cursorColor={PLAY.teal}
          maxLength={300}
          accessibilityLabel={W.placeholder}
        />
        <Key uiId="pick.go" kind="aurora" label={W.go} onPress={() => ask()} disabled={busy} calm={calm} />
        <View style={s.tune}>
          {/* one control, one tap: anywhere on it flips Movies <-> Shows */}
          <Tap uiId="pick.option" accessibilityRole="switch" accessibilityLabel={W.switchLabel} accessibilityState={{checked: shows}} onPress={flip} flat style={s.switch}>
            {KINDS.map(k => (
              <View key={k.id} style={[s.switchOpt, k.id === kind && s.switchOptOn]}>
                <Text style={[s.switchText, k.id === kind && s.switchTextOn]}>{k.label}</Text>
              </View>
            ))}
          </Tap>
          <Dial label={W.era} options={ERAS} value={era} onPick={setEra} />
          <Dial label={W.length} options={LENGTHS[kind]} value={length} onPick={setLength} />
        </View>
      </PlayCard>
      <View style={s.examples}>
        <Text style={s.examplesLabel}>{W.tryLabel}</Text>
        {EXAMPLES.map(ex => (
          <GameChip key={ex} uiId="pick.example" small label={ex} onPress={() => ask(ex)} />
        ))}
      </View>
    </>
  );

  const stage =
    mode === 'none' ? null : (
      <View style={s.stage} onLayout={onStage}>
        <View style={s.reelHold} ref={reelRef} collapsable={false}>
          {mode === 'won' ? <Image source={GLOW_SRC} fadeDuration={0} style={[s.reelGlow, {width: reelW * 2.4, height: reelW * 2.4}]} /> : null}
          <Reel w={reelW} h={reelH} items={items} mode={mode} spin={spin} showing={draw} calm={calm || !front} flash={flash} onLanded={landed} />
        </View>
        {mode === 'waiting' ? (
          <View style={s.wait} accessibilityLiveRegion="polite">
            <Dots calm={calm} />
            <Text style={s.waitMsg}>{STAGES[stageNo]}</Text>
            <Text style={s.waitHint}>{W.waitHint}</Text>
          </View>
        ) : (
          <View style={s.won}>
            {/* the gold line is up while the reel slows: the side is never empty */}
            <View style={s.kicker}>
              <Star size={14} color={PLAY.gold} />
              <Text style={s.kickerText}>{DRAW.kicker}</Text>
              {items.length > 1 ? <Text style={s.kickerCount}>{` · ${DRAW.of(draw + 1, items.length)}`}</Text> : null}
            </View>
            {mode === 'won' && item ? (
              <View style={s.prize} accessibilityLiveRegion="polite">
                <In calm={calm} run={prizeRun} delay={0} ms={420}>
                  <Text style={[ty.h1, s.prizeTitle]} numberOfLines={3}>
                    {item.title}
                  </Text>
                </In>
                <In calm={calm} run={prizeRun} delay={70} ms={420}>
                  <Text style={s.prizeMeta}>{metaLine(item)}</Text>
                </In>
                {item.why ? (
                  <In calm={calm} run={prizeRun} delay={140} ms={420}>
                    <Text style={[ty.lede, s.prizeWhy]}>{item.why}</Text>
                  </In>
                ) : null}
                <In calm={calm} run={prizeRun} delay={210} ms={420} style={s.prizeKeys}>
                  <Key uiId="pick.open" kind="gold" label={DRAW.open} onPress={() => open(item)} calm={calm} style={s.grow} />
                  {items.length > 1 ? <Key uiId="pick.another" label={DRAW.another} trailing="↻" onPress={another} calm={calm} style={s.grow} /> : null}
                </In>
                {showPips(items.length) ? (
                  <View style={s.pips} importantForAccessibility="no-hide-descendants">
                    {items.map((_, i) => (
                      <View key={i} style={[s.pip, i === draw && s.pipOn]} />
                    ))}
                  </View>
                ) : null}
                <Text style={s.sr}>{DRAW.said(item.title || '')}</Text>
              </View>
            ) : null}
          </View>
        )}
      </View>
    );

  const hand =
    handShown && items.length ? (
      <View style={s.hand}>
        <Eyebrow star color={PLAY.violet}>
          {DRAW.hand}
        </Eyebrow>
        {status ? <Text style={s.status}>{status}</Text> : null}
        <View style={s.handList}>
          {items.map((it, i) => (
            <Tap key={`${it.id || it.imdbId || it.title}-${i}`} uiId="pick.open" flat accessibilityRole="button" accessibilityLabel={it.title} onPress={() => open(it)} style={[s.handRow, i === draw && s.handRowOn]}>
              <Poster name={it.title || ''} poster={art(it)} w={62} h={93} radius={10} gold={i === draw} />
              <View style={s.handText}>
                <Text style={s.handTitle} numberOfLines={2}>
                  {it.title}
                </Text>
                <Text style={s.handMeta}>{metaLine(it)}</Text>
                {it.why ? <Text style={s.handWhy}>{it.why}</Text> : null}
              </View>
            </Tap>
          ))}
        </View>
      </View>
    ) : status && mode === 'none' ? (
      <Text style={[s.status, {textAlign: 'center'}]}>{status}</Text>
    ) : null;

  return (
    <View style={s.root}>
      <PlayRoom calm={calm} on={front} />
      <ScrollView
        ref={scroller}
        contentContainerStyle={[{paddingTop: top, paddingBottom: bottom + 24, paddingHorizontal: GUTTER}, column]}
        onScroll={bar.onScroll}
        scrollEventThrottle={64}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        <View style={s.head}>
          <Text style={s.h1} accessibilityRole="header">
            {W.title}
          </Text>
          <Text style={[ty.lede, s.sub]}>{W.sub}</Text>
          {/* [group-pick] a few people deciding together — the website's AI page and the TV's have the same card: a ticket */}
          <Tap uiId="group.open" accessibilityRole="button" flat onPress={() => navigation.push('GroupPick')} style={s.ticket}>
            <View style={s.ticketBadge}>
              <Star size={16} color="#04131a" />
            </View>
            <View style={s.ticketText}>
              <Text style={s.ticketTitle}>{GROUP.entry}</Text>
              <Text style={s.ticketLine}>{GROUP.entryLine}</Text>
            </View>
            <Text style={s.ticketArrow}>→</Text>
          </Tap>
        </View>
        {enabled === null ? (
          <ActivityIndicator color={PLAY.ink} style={s.loading} />
        ) : enabled === false ? (
          <PlayCard style={s.offBox}>
            <Text style={ty.small}>{me?.kids ? W.offKids : W.off}</Text>
          </PlayCard>
        ) : (
          <>
            {form}
            {stage}
            {hand}
          </>
        )}
      </ScrollView>
      <Burst fire={burst.n} x={burst.x} y={burst.y} count={16} calm={calm} reach={Math.max(width, 600) * 0.8} />
      <BackBar solid={bar.solid} title={bar.solid ? PAGE_TITLE : undefined} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  head: {alignItems: 'center', paddingBottom: 22},
  h1: {color: PLAY.teal, fontSize: 40, fontWeight: '900', letterSpacing: -1, lineHeight: 46, textShadowColor: 'rgba(58,211,230,0.35)', textShadowRadius: 18, textShadowOffset: {width: 0, height: 0}},
  sub: {marginTop: 8, fontSize: 16, lineHeight: 23},
  loading: {marginTop: 30},
  // ---- the ticket to Pick together ----
  ticket: {
    marginTop: 22,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(160,131,255,0.35)',
    backgroundColor: 'rgba(30,26,72,0.7)',
    experimental_backgroundImage: 'linear-gradient(135deg, rgba(160,131,255,0.18) 0%, rgba(58,211,230,0.06) 100%)',
  },
  ticketBadge: {width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', experimental_backgroundImage: AURORA},
  ticketText: {flex: 1, gap: 3},
  ticketTitle: {color: PLAY.ink, fontSize: 16.8, fontWeight: '900'},
  ticketLine: {color: PLAY.inkDim, fontSize: 14, lineHeight: 19},
  ticketArrow: {color: PLAY.inkDim, fontSize: 20, fontWeight: '700'},
  // ---- the question ----
  box: {padding: 16, gap: 12},
  input: {
    minHeight: 54,
    backgroundColor: 'rgba(4,4,16,0.6)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.14)',
    borderRadius: 16,
    color: PLAY.ink,
    fontSize: 16.8,
    paddingHorizontal: 17,
    paddingVertical: 13,
  },
  inputOn: {borderColor: PLAY.teal, boxShadow: '0 0 0 3px rgba(58,211,230,0.18)'},
  tune: {marginTop: 4, paddingTop: 16, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', gap: 12},
  switch: {flexDirection: 'row', alignSelf: 'flex-start', width: 236, maxWidth: '100%', padding: 4, borderRadius: 999, backgroundColor: 'rgba(4,4,16,0.6)', borderWidth: 1, borderColor: PLAY.line},
  switchOpt: {flex: 1, minHeight: 40, borderRadius: 999, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 6},
  switchOptOn: {backgroundColor: '#f2efff', borderBottomWidth: 3, borderBottomColor: 'rgba(120,100,200,0.45)'},
  switchText: {color: PLAY.inkDim, fontSize: 14.7, fontWeight: '800', textAlign: 'center'},
  switchTextOn: {color: '#1a1640'},
  group: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8},
  groupLabel: {color: 'rgba(232,228,255,0.55)', fontSize: 11.4, fontWeight: '800', letterSpacing: 1.4, marginRight: 2},
  examples: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 16},
  examplesLabel: {color: 'rgba(232,228,255,0.55)', fontSize: 12.5, fontWeight: '800', letterSpacing: 0.5},
  // ---- the stage ----
  stage: {alignItems: 'center', paddingTop: 30},
  reelHold: {alignItems: 'center', justifyContent: 'center'},
  reelGlow: {position: 'absolute', tintColor: PLAY.gold, opacity: 0.3},
  reel: {
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(160,131,255,0.55)',
    backgroundColor: PLAY.tile,
  },
  reelWon: {borderColor: PLAY.gold, borderWidth: 3},
  flash: {backgroundColor: PLAY.goldHi},
  notch: {position: 'absolute', width: 0, height: 0, borderTopWidth: 7, borderBottomWidth: 7, borderTopColor: 'transparent', borderBottomColor: 'transparent'},
  notchL: {left: 6, borderLeftWidth: 10, borderLeftColor: PLAY.gold},
  notchR: {right: 6, borderRightWidth: 10, borderRightColor: PLAY.gold},
  wait: {alignItems: 'center', gap: 12, paddingTop: 20, paddingHorizontal: 8},
  dots: {flexDirection: 'row', gap: 16},
  waitMsg: {color: PLAY.ink, fontSize: 22, fontWeight: '900', letterSpacing: -0.3, textAlign: 'center'},
  waitHint: {color: 'rgba(232,228,255,0.55)', fontSize: 14, lineHeight: 20, textAlign: 'center'},
  won: {alignItems: 'center', alignSelf: 'stretch', paddingTop: 20},
  kicker: {flexDirection: 'row', alignItems: 'center', gap: 7},
  kickerText: {color: PLAY.gold, fontSize: 12.5, fontWeight: '900', letterSpacing: 2.2, textTransform: 'uppercase'},
  kickerCount: {color: 'rgba(232,228,255,0.55)', fontSize: 12.5, fontWeight: '900', letterSpacing: 1.6, textTransform: 'uppercase'},
  prize: {alignItems: 'center', alignSelf: 'stretch', gap: 10, paddingTop: 10},
  prizeTitle: {fontSize: 32, lineHeight: 35},
  prizeMeta: {color: 'rgba(232,228,255,0.62)', fontSize: 15, fontWeight: '800', textAlign: 'center'},
  prizeWhy: {fontSize: 16.5},
  prizeKeys: {flexDirection: 'row', gap: 10, alignSelf: 'stretch', marginTop: 8},
  grow: {flex: 1},
  pips: {flexDirection: 'row', gap: 7, marginTop: 6},
  pip: {width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(232,228,255,0.25)'},
  pipOn: {backgroundColor: PLAY.ink},
  sr: {position: 'absolute', width: 1, height: 1, opacity: 0},
  // ---- the whole hand ----
  hand: {paddingTop: 36, gap: 10},
  status: {color: 'rgba(232,228,255,0.6)', fontSize: 14, lineHeight: 20, textAlign: 'center', paddingTop: 16},
  handList: {gap: 10, marginTop: 6},
  handRow: {flexDirection: 'row', gap: 14, padding: 10, borderRadius: 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)', backgroundColor: 'rgba(20,18,46,0.6)'},
  handRowOn: {borderColor: 'rgba(255,209,102,0.55)', backgroundColor: 'rgba(255,209,102,0.07)'},
  handText: {flex: 1, gap: 3, paddingVertical: 2},
  handTitle: {color: PLAY.ink, fontSize: 16, fontWeight: '900'},
  handMeta: {color: 'rgba(232,228,255,0.55)', fontSize: 12.5, fontWeight: '800'},
  handWhy: {color: PLAY.inkDim, fontSize: 13.6, lineHeight: 19, marginTop: 3},
  // ---- the no-AI line ----
  offBox: {marginTop: 8, padding: 18},
});
