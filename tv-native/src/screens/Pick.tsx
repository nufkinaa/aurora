// The AI tab — the site's "Pick for me" (screens/pickforme.js), on a remote,
// in the Aurora Play look: "The Draw" (docs/play/tv.md).
//
// Describe the mood, pick Movies or Shows and two taste dials, press Find, and
// the server (src/media/ai.js) answers with titles and a line on why each one
// fits. What it answers, and what is asked of it, is what it always was; what
// changed is how the answer arrives.
//
// THE DRAW. The answer is drawn, not listed. From the moment of the ask a
// stage stands under the question: a poster-sized window where card backs roll
// while the server thinks, and ONE key beside it that says "Thinking…". When
// the answer is in, the reel runs through the picks and slows onto the first
// one (the server's best), stands still for a beat, and that is the prize: a
// gold flash, the meteor burst (once per answer), "TONIGHT'S PICK", the title,
// the reason. The same key is now "Open", in gold. "Another one" rolls to the
// next pick (no burst: a flow has one reward). The whole hand is under the
// stage, as the grid of compact posters it always was, the drawn one marked.
//
// It replaces "New" in the nav rail (elia, 2026-10-06); the New page is still
// one press away under Settings → What's new.
//
// Remote order: field → Find (right); down to What → Era (right along one row);
// down to Length. At every ask focus is handed, once, to the stage's key, and
// the question folds to one line above it. From the key: RIGHT is Another one,
// DOWN the hand, UP the folded question (which unfolds it, focus on Find). UP
// from the hand's top row lands on Try again (or Find when there is no answer
// yet). Back leaves, at any moment.
//
// Motion: transform and opacity on the native driver only. The landing is one
// value running 0 → 1 at a steady pace with the curve in its stops (reel.ts),
// so nothing is computed per frame in JS. A lite box (perfTier) and "Remove
// animations" get the prize at once, still: no reel, no flash, no burst.
//
// The last answer lives at module scope, with the pick that was drawn: opening
// a result and coming Back — or leaving the tab and returning — paints the
// prize straight back, still, instead of spending another ten seconds (and
// real money) on the same question.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Animated, FlatList, Image, StyleSheet, Text, TextInput, TVFocusGuideView, View} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Card, {COMPACT_W} from '../components/Card';
import Chip from '../components/Chip';
import Btn from '../components/Btn';
import Focusable from '../components/Focusable';
import Icon, {IconName} from '../components/Icon';
import NavRail from '../components/NavRail';
import {api, artPath, artPx, HeroItem, imgSrc} from '../api';
import {canNavigate} from '../navLock';
import {useRouteShown} from '../useRouteShown';
import {warmItem} from '../prefetch';
import {noteFocus, railOpen, requestRailOpen, useFocusFallback, useTVKeys, pressMovedFocus} from '../focus';
import {showToast} from '../toast';
import {registerProfileCache} from '../profileScope';
import {RootStackParamList} from '../navigation';
import {WORDS as GROUP} from '../groupPick'; // [group-pick]
import theme, {useTvMetrics} from '../theme';
import {LINEAR, tween, useCalm, useInFront, useTimers, useValue} from '../play/anim';
import Burst from '../play/Burst';
import {BACK_SRC, Tile} from '../play/Cards';
import {Rise} from '../play/Motion';
import PlayKey from '../play/PlayKey';
import {HOLD_MS, LAND_MS, landingStrip, nextDraw, reelStops, RESPIN_MS, respinStrip} from '../play/reel';
import Room from '../play/Room';
import {Star} from '../play/Star';
import {PLAY} from '../play/tokens';

const {colors, radius, fontSize, spacing, CLEARANCE} = theme;

// pickforme.js, verbatim: the ids are what src/media/ai.js understands.
const KINDS = [
  {id: 'movie', label: 'Movies', mix: 0},
  {id: 'show', label: 'Shows', mix: 100},
] as const;
const ERAS = [
  {id: 'any', label: 'Any era'},
  {id: 'fresh', label: 'Recent'},
  {id: 'modern', label: 'Not too old'},
  {id: 'classic', label: 'A classic'},
];
const LENGTHS = {
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
const EXAMPLES = [
  'something dumb and loud, I’ve had a long day',
  'slow and beautiful, nothing scary',
  'a clever thriller that respects my time',
  'makes me cry in a good way',
];
// The wait narrates itself — several seconds on one word looks broken.
const STAGES = [
  'Reading the room…',
  'Ransacking the archives…',
  'Arguing with itself about your taste…',
  'Checking which of these Aurora can actually play…',
];
// The draw's own words (the website's, pickforme.js DRAW).
const DRAW = {
  kicker: 'TONIGHT’S PICK',
  of: (n: number, of: number) => `${n} of ${of}`,
  thinking: 'Thinking…',
  open: 'Open',
  another: 'Another one',
  hand: 'The whole hand',
};

// What the page says when the server has no recommender key — the notice
// above the controls, and the toast a press on Find gets instead of nothing.
const OFF_TEXT = 'The recommender isn’t set up on this server. The admin adds a key under Admin → Server to switch it on.';

// The grid's gutter, both ways.
const GAP = spacing.md;
// The no-key notice: the site's amber, as text and a tinted box.
const AMBER = '#fbbf24';
// "On this server": the timeline's mint (Card's progress ramp).
const MINT = '#8cffbe';

// ---- the stage ----
// The reel's window: a poster, 2:3.
const WIN_W = 160;
const WIN_H = 240;
const WIN_R = 14;
// the payline's two marks, and the room each takes beside the window
const NOTCH = 14;
const SPIN_MS = 520; // one card back going by while the server thinks
const BEAT_MS = 1560; // the three stars, lit in turn
const LOAD_MS = 1200; // the longest the landing waits for its pictures
const ARM_MS = 400; // "Open" ignores a press this long after it became Open
const FLASH_MS = 500;
const STAGE_IN = 280;

type PickItem = HeroItem & {why?: string};
type Answer = {vibe: string; kind: 'movie' | 'show'; era: string; length: string; items: PickItem[]; status: string; draw: number};
// The last answer, so coming back to the tab shows it again — THIS PROFILE'S
// last answer: it is dropped when the profile is left (profileScope.ts). It
// used to live for the whole run with no owner, so the next person — a kids
// profile included — opened the tab on the previous person's picks (audit X8).
let last: Answer | null = null;
registerProfileCache('Pick', () => {
  last = null;
});

// Where the draw is: nothing yet / the question is out / the answer is in and
// its pictures are being fetched / the reel is coming down / the prize.
type Phase = 'off' | 'wait' | 'load' | 'land' | 'won';
// One cell of the reel: a pick's poster, or a card back (null).
type Cell = {key: string; pick: number | null};
type Reel = {
  id: number;
  cells: Cell[];
  // a roll: `v` runs 0 → 1 and `stops` turn it into the strip's place.
  // Without them the strip stands on its first cell.
  v: Animated.Value | null;
  stops: {inputRange: number[]; outputRange: number[]} | null;
  ms: number;
  shown: boolean;
};

// The cell a roll ends on is keyed `rest-<pick>`, and the next roll's first
// cell — the same pick — has the same key: it is the same mounted picture, so
// nothing blinks when one strip takes the place of another.
const landingCells = (n: number, winner: number): Cell[] => {
  const strip = landingStrip(n, winner, 8);
  // two backs first: the strip takes over from the waiting reel between two of them
  const cells: Cell[] = [
    {key: 'b0', pick: null},
    {key: 'b1', pick: null},
  ];
  strip.forEach((p, k) => cells.push({key: k === strip.length - 1 ? `rest-${p}` : `c${k}`, pick: p}));
  cells.push({key: 'tail', pick: null}); // (what shows under the pick while the reel is a hair past it)
  return cells;
};
const respinCells = (n: number, from: number, to: number): Cell[] => {
  const strip = respinStrip(n, from, to);
  const cells: Cell[] = strip.map((p, k) => ({key: k === 0 || k === strip.length - 1 ? `rest-${p}` : `c${k}`, pick: p}));
  cells.push({key: 'tail', pick: null});
  return cells;
};
const stillReel = (id: number, pick: number): Reel => ({id, cells: [{key: `rest-${pick}`, pick}], v: null, stops: null, ms: 0, shown: true});

const pictureOf = (it: PickItem | undefined) => (it && (it.cover || it.poster)) || null;

// One face of the reel: the pick's poster at the window's size, or — without
// one, or when it would not load — a tile with the title on it.
const Face = React.memo(function Face({item, onSettle}: {item: PickItem | undefined; onSettle?: () => void}) {
  const [bad, setBad] = useState(false);
  const pic = pictureOf(item);
  const src = useMemo(() => (pic ? imgSrc(artPath(pic, artPx(WIN_W)) || pic) : null), [pic]);
  if (!src || bad) return <Tile title={item?.title} style={styles.cell} size={17} />;
  return (
    <Image
      source={src}
      fadeDuration={0}
      resizeMode="cover"
      style={styles.cell}
      onLoad={onSettle}
      onError={() => {
        setBad(true);
        onSettle?.();
      }}
    />
  );
});

// One labelled dial group: a small icon and a caps label, then its pills.
function Group({icon, label, children}: {icon: IconName; label: string; children: React.ReactNode}) {
  return (
    <View style={styles.group}>
      <View style={styles.groupLabel}>
        <Icon name={icon} size={16} color={colors.accent} />
        <Text style={styles.groupText}>{label}</Text>
      </View>
      {children}
    </View>
  );
}

// (frozen: the one empty hand every empty state shares; nothing is ever put in it)
const NO_PICKS = Object.freeze([]) as unknown as PickItem[];
const BEAT_COLORS = [PLAY.green, PLAY.teal, PLAY.violet];

export default function Pick({navigation}: NativeStackScreenProps<RootStackParamList, 'Pick'>) {
  const {width, height, safeBottom} = useTvMetrics();
  // How many compact posters fit the content box: 8 on a 960dp canvas.
  const cols = Math.max(
    4,
    Math.floor((width - spacing.contentLeft - spacing.pageX + GAP) / (COMPACT_W + GAP)),
  );
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // usage stats: this screen's content is on (routeTiming.ts)
  useRouteShown(enabled !== null);

  // ---- how it moves, and whether it may ----
  const calm = useCalm();
  const calmRef = useRef(calm);
  calmRef.current = calm;
  const inFront = useInFront(navigation as never);
  const frontRef = useRef(inFront);
  frontRef.current = inFront;
  const timers = useTimers();
  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
    },
    [],
  );

  // The answer this visit opened on (the tab was left and come back to).
  const restored = useRef(!!last).current;
  const firstDraw = useRef(last ? Math.max(0, Math.min(last.items.length - 1, Math.floor(last.draw) || 0)) : 0).current;

  const [vibe, setVibe] = useState(last?.vibe || '');
  const [kind, setKind] = useState<'movie' | 'show'>(last?.kind || 'movie');
  const [era, setEra] = useState(last?.era || 'any');
  const [length, setLength] = useState(last?.length || 'any');
  // which of the waiting lines is up
  const [said, setSaid] = useState(0);
  // The answer's picks. The stage knows them from the moment they arrive; the
  // grid shows them once they are `dealt` (in the still beat before the prize).
  const [items, setItems] = useState<PickItem[]>(last?.items || NO_PICKS);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [dealt, setDealt] = useState(restored);
  const [status, setStatus] = useState(last?.status || '');
  // What the last ask came to when it was not a list: 'empty' or the server's
  // own message. Nothing while there is no answer at all.
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState('');
  // Has anything been asked on this visit (or restored)? Decides whether the
  // hand's header (and its Try again) is drawn.
  const [asked, setAsked] = useState(restored);

  // ---- the draw ----
  const [phase, setPhaseState] = useState<Phase>(restored ? 'won' : 'off');
  // The same, readable at once by a timer or a key press (a state is only
  // true from the next render on).
  const step = useRef<Phase>(phase);
  const setPhase = useCallback((p: Phase) => {
    step.current = p;
    setPhaseState(p);
  }, []);
  // which pick is the prize
  const [draw, setDraw] = useState(firstDraw);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  // goes up with every prize shown: its words rise again
  const [serial, setSerial] = useState(0);
  const reelId = useRef(0);
  const [reel, setReel] = useState<Reel | null>(() => (restored ? stillReel(0, firstDraw) : null));
  // goes up each time the stage comes out, so it rises in
  const [stageSerial, setStageSerial] = useState(0);
  // After an ask that came to nothing the stage stays mounted, unseen, until
  // focus is back on Find: its key holds the focus, and a focused view that
  // unmounts makes Android hand its focus to whatever is nearest.
  const [stageGhost, setStageGhost] = useState(false);
  const [fire, setFire] = useState({n: 0, x: 0, y: 0, seed: 5});
  // the title's line count: a one-line title leaves the reason a line more
  const [titleLines, setTitleLines] = useState(1);

  const spinV = useValue(0); // the waiting reel: one card back per run
  const beatV = useValue(0); // the three stars
  const flashV = useValue(0);
  const wordsV = useValue(1); // the prize's words (they leave while Another one rolls)
  const handV = useValue(restored ? 1 : 0); // the hand under the stage

  const askId = useRef(0);
  // the pictures the landing is waiting for
  const loading = useRef<{id: number; need: number; done: number} | null>(null);
  // "Another one" is rolling (Open and Another one wait for it)
  const rolling = useRef(false);
  const nextUp = useRef(0);
  const armedAt = useRef(restored ? Date.now() + ARM_MS : 0);

  // Once picks are up and the viewer is among them, the dials fold to one
  // summary line so the stage and the hand have the screen (elia, 2026-10-09).
  // Moving back up onto that line unfolds them and puts focus on Find; a key
  // of the stage, or a pick, folds them again.
  const [collapsed, setCollapsed] = useState(restored);
  const hasPicks = useRef(false);
  // While the panel unfolds, the summary line stays mounted (invisible) until
  // Find has taken the focus. Unmounting a focused view makes Android hand
  // its focus to the nearest one — the first pick — whose focus folded the
  // panel straight back (seen on the Mi TV, 2026-10-09).
  const [handoff, setHandoff] = useState(false);
  const handoffRef = useRef(false);
  // The other way: while focus is being handed to the stage's key at an ask,
  // Find unmounts with the focus on it, and if Android passes it to the
  // summary line for a moment, that must not unfold the panel again.
  const toStage = useRef(false);
  const unfold = useCallback(() => {
    setCollapsed(false);
    setHandoff(true);
    handoffRef.current = true;
    const back = () => {
      if (!railOpen()) goBtn.current?.requestTVFocus?.();
    };
    timers.after(0, back);
    timers.after(150, back);
    timers.after(400, () => {
      handoffRef.current = false;
      setHandoff(false);
    });
  }, [timers]);
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const inputFallback = useRef({requestTVFocus: () => inputRef.current?.focus()});
  useFocusFallback(inputFallback);
  // Registered after the field, so it wins: a focused card or Try again that
  // unmounts lands on Find rather than summoning the keyboard.
  const goBtn = useRef<{requestTVFocus?: () => void}>(null);
  useFocusFallback(goBtn as never);
  // And the stage's key after Find: while a draw is up, it is the page's last
  // resort (Find is folded away then).
  const mainKey = useRef<{requestTVFocus?: () => void}>(null);
  useFocusFallback(mainKey as never);
  const againBtn = useRef<{requestTVFocus?: () => void}>(null);
  // The first pill of the What row ("Movies"): where LEFT from Find goes when
  // the mood field is switched off (no recommender) — see the key handler.
  const firstKind = useRef<{requestTVFocus?: () => void}>(null);
  const findFocused = useRef(false);
  const offRef = useRef(false);
  const listRef = useRef<FlatList<PickItem>>(null);
  const winRef = useRef<View>(null);
  const toTop = useCallback((animated: boolean) => {
    (listRef.current as {scrollToOffset?: (p: {offset: number; animated: boolean}) => void} | null)?.scrollToOffset?.({offset: 0, animated});
  }, []);

  useEffect(() => {
    let live = true;
    api
      .aiStatus()
      .then(s => live && setEnabled(!!s.enabled))
      .catch(() => live && setEnabled(false));
    return () => {
      live = false;
    };
  }, []);

  const busy = phase === 'wait' || phase === 'load' || phase === 'land';
  const won = phase === 'won';

  // Narration while the server thinks.
  useEffect(() => {
    if (!busy) return;
    setSaid(0);
    const t = setInterval(() => setSaid(s => Math.min(s + 1, STAGES.length - 1)), 2600);
    return () => clearInterval(t);
  }, [busy]);

  // The waiting reel and the three stars: two loops on the native driver, and
  // only while the question is out, the screen is the one in front, and
  // things may move.
  const waiting = (phase === 'wait' || phase === 'load') && inFront && !calm;
  useEffect(() => {
    if (!waiting) return;
    spinV.setValue(0);
    beatV.setValue(0);
    const a = Animated.loop(tween(spinV, 1, SPIN_MS, {easing: LINEAR}));
    const b = Animated.loop(tween(beatV, 1, BEAT_MS, {easing: LINEAR}));
    a.start();
    b.start();
    return () => {
      a.stop();
      b.stop();
    };
  }, [waiting, spinV, beatV]);

  const flash = useCallback(() => {
    flashV.setValue(0.7);
    tween(flashV, 0, FLASH_MS).start();
  }, [flashV]);

  // The one reward of an answer: the meteor burst, from the middle of the
  // window. It is drawn over the whole page (the list would clip it at its own
  // edge), so it needs the window's place on the screen.
  const burst = useCallback(
    (n: number) => {
      const give = (x: number, y: number) => {
        if (!gone.current) setFire(f => ({n: f.n + 1, x, y, seed: 5 + n}));
      };
      const fx = spacing.contentLeft + NOTCH + WIN_W / 2;
      const fy = height / 2;
      const node = winRef.current as {measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void} | null;
      if (node?.measureInWindow) node.measureInWindow((x, y, w, h) => (w > 0 && h > 0 ? give(x + w / 2, y + h / 2) : give(fx, fy)));
      else give(fx, fy);
    },
    [height],
  );

  // The prize, still and complete: what calm gets instead of a landing, what
  // an answer that arrives while another screen is in front gets, and how a
  // roll ends when the screen is left in the middle of it.
  const settle = useCallback(
    (pick: number) => {
      const id = ++reelId.current; // (a roll in flight is not the reel any more: its end is ignored)
      loading.current = null;
      rolling.current = false;
      setReel(stillReel(id, pick));
      setDraw(pick);
      setDealt(true);
      handV.setValue(1);
      wordsV.setValue(1);
      flashV.setValue(0);
      setSerial(s => s + 1);
      armedAt.current = Date.now() + ARM_MS;
      setPhase('won');
    },
    [flashV, handV, setPhase, wordsV],
  );

  // The reel came to rest on the pick and stood its beat: the prize.
  const win = useCallback(
    (n: number) => {
      if (gone.current) return;
      rolling.current = false;
      armedAt.current = Date.now() + ARM_MS;
      setSerial(s => s + 1);
      setPhase('won');
      flash();
      tween(handV, 1, 300).start();
      if (frontRef.current && !calmRef.current) burst(n);
    },
    [burst, flash, handV, setPhase],
  );

  // The pictures are in (or have had their time): the strip takes over from
  // the waiting reel exactly where that one stands, and comes down.
  const roll = useCallback(
    (id: number) => {
      if (gone.current || step.current !== 'load' || reelId.current !== id) return;
      loading.current = null;
      if (calmRef.current || !frontRef.current) {
        settle(0);
        return;
      }
      step.current = 'land'; // (taken now: the timer and the last picture may both call)
      spinV.stopAnimation(at => {
        if (gone.current || reelId.current !== id) return;
        const from = Math.max(0, Math.min(0.99, Number(at) || 0));
        setReel(r =>
          r && r.id === id ? {...r, v: new Animated.Value(0), stops: reelStops(r.cells.length - 2, WIN_H, 48, from), shown: true} : r,
        );
        setPhase('land');
      });
    },
    [settle, setPhase, spinV],
  );
  const onFace = useCallback(() => {
    const l = loading.current;
    if (!l) return;
    l.done += 1;
    if (l.done >= l.need) roll(l.id);
  }, [roll]);

  // What a roll does when it comes to rest (always the latest closure).
  const landed = useRef<(id: number) => void>(() => {});
  landed.current = (id: number) => {
    if (gone.current || reelId.current !== id) return;
    if (step.current === 'land') {
      // The still beat. The hand is dealt now, unseen: the grid's cost falls
      // where nothing is moving, not on the flash.
      const n = itemsRef.current.length;
      setDealt(true);
      timers.after(HOLD_MS, () => {
        if (reelId.current === id && step.current === 'land') win(n);
      });
    } else if (step.current === 'won' && rolling.current) {
      // "Another one" is there: the same prize look, without the burst.
      rolling.current = false;
      setDraw(nextUp.current);
      setSerial(s => s + 1);
      wordsV.setValue(1);
      flash();
    }
  };
  // One roll per reel that has one: a single value, 0 → 1, at a steady pace.
  useEffect(() => {
    if (!reel || !reel.v || !reel.stops) return;
    const id = reel.id;
    const run = tween(reel.v, 1, reel.ms, {easing: LINEAR});
    run.start(({finished}) => {
      if (finished) landed.current(id);
    });
    return () => run.stop();
  }, [reel]);

  // Nothing rolls where nobody sees it: leave in the middle of a landing (or
  // of Another one) and it is simply there when you are back.
  useEffect(() => {
    if (inFront) return;
    if (step.current === 'load' || step.current === 'land') settle(0);
    else if (step.current === 'won' && rolling.current) settle(nextUp.current);
  }, [inFront, settle]);

  // The answer is in.
  const land = useCallback(
    (got: PickItem[], text: string) => {
      setItems(got);
      setStatus(text);
      setDraw(0);
      if (calmRef.current || !frontRef.current) {
        settle(0);
        return;
      }
      const id = ++reelId.current;
      const cells = landingCells(got.length, 0);
      const need = cells.filter(c => c.pick != null && pictureOf(got[c.pick])).length;
      loading.current = {id, need, done: 0};
      // mounted unseen first: its pictures load behind the waiting reel
      setReel({id, cells, v: null, stops: null, ms: LAND_MS, shown: false});
      setPhase('load');
      timers.after(need ? LOAD_MS : 0, () => roll(id));
    },
    [roll, setPhase, settle, timers],
  );

  // The ask came to nothing (no picks, or the server said why not): the stage
  // folds away and the question is open again, focus on Find.
  const fail = useCallback(
    (message: string | null) => {
      if (gone.current) return;
      if (message) setError(message);
      else setEmpty(true);
      reelId.current += 1;
      loading.current = null;
      setReel(null);
      setPhase('off');
      setStageGhost(true);
      timers.after(400, () => setStageGhost(false));
      unfold();
    },
    [setPhase, timers, unfold],
  );

  // UP out of the results grid lands on Try again (Find before there is one),
  // deterministically — the native focus search regularly finds nothing above
  // a top-row card; Browse and Search carry the same escape.
  const inGrid = useRef(false);
  const gridIdx = useRef(0);
  useTVKeys(
    useCallback(
      (evt: {eventType: string}) => {
        if (railOpen()) return;
        // never on the release of the press that carried focus to where it is
        // now (focus.ts pressMovedFocus): one press would move twice
        if (pressMovedFocus()) return;
        // LEFT from Find with the field off: native focus search skipped the
        // disabled field and dropped on whichever Era pill was nearest ("Not
        // too old", Mi TV 2026-10-09). Find is wrapped in a left trap while
        // the field is off, so the press moves nothing natively and lands here:
        // the first pill of the row below, or the rail if it is not there.
        if (evt.eventType === 'left' && findFocused.current && offRef.current) {
          if (firstKind.current?.requestTVFocus) firstKind.current.requestTVFocus();
          else requestRailOpen();
          return;
        }
        if (evt.eventType !== 'up') return;
        if (!inGrid.current || gridIdx.current >= cols) return;
        inGrid.current = false;
        (againBtn.current || goBtn.current)?.requestTVFocus?.();
      },
      [cols],
    ),
  );
  const onCardFocus = useCallback((item: HeroItem, index: number) => {
    warmItem(item);
    inGrid.current = true;
    gridIdx.current = index;
    if (hasPicks.current) setCollapsed(true);
  }, []);
  // A key of the stage has the focus: the question folds to its line and the
  // page stands at its top, so the whole stage is in view.
  const onStageFocus = useCallback(
    (f: boolean) => {
      if (!f) return;
      inGrid.current = false;
      if (handoffRef.current || step.current === 'off') return;
      setCollapsed(true);
      toTop(!calmRef.current);
    },
    [toTop],
  );

  const ask = useCallback(
    // `fresh`: Try again — the server skips its cached answer for this exact question
    async (override?: string, fresh = false) => {
      if (enabled === false) {
        showToast(OFF_TEXT, '⚠️');
        return;
      }
      const q = (override ?? vibe).trim();
      if (q.length < 3) {
        // (the field is folded away while a draw is up: open the question first)
        if (inputRef.current) inputRef.current.focus();
        else unfold();
        return;
      }
      // one draw at a time: not while the question is out, the reel is coming
      // down, or Another one is rolling
      if (step.current === 'wait' || step.current === 'load' || step.current === 'land' || rolling.current) return;
      if (override != null) setVibe(override);
      const turn = ++askId.current;
      setAsked(true);
      setStatus('');
      setEmpty(false);
      setError('');
      setItems(NO_PICKS);
      setDealt(false);
      setDraw(0);
      reelId.current += 1;
      setReel(null);
      handV.setValue(0);
      flashV.setValue(0);
      wordsV.setValue(1);
      if (step.current === 'off') setStageSerial(s => s + 1);
      setStageGhost(false);
      setPhase('wait');
      // The stage has the screen now: the question folds to its one line and
      // focus is handed — once, at this press — to the stage's key, which
      // waits as "Thinking…" and becomes "Open" without ever moving. (Find is
      // about to unmount, so it cannot keep the focus.)
      setCollapsed(true);
      toStage.current = true;
      const toKey = () => mainKey.current?.requestTVFocus?.();
      timers.after(0, toKey);
      timers.after(150, toKey);
      timers.after(400, () => {
        toStage.current = false;
      });
      toTop(false);
      try {
        const mix = KINDS.find(k => k.id === kind)!.mix;
        const res = await api.aiRecommend(q, mix, era, length, fresh);
        const got = (res.items || []) as PickItem[];
        if (!got.length) {
          if (askId.current === turn) fail(null);
          return;
        }
        const noun = kind === 'show' ? (got.length === 1 ? 'show' : 'shows') : got.length === 1 ? 'film' : 'films';
        const text =
          `${got.length} ${noun} for “${q}”` +
          (res.cached ? ' · from earlier' : '') +
          (got.length < 5 && (era !== 'any' || length !== 'any') ? ' · not much fits those filters, try loosening one' : '');
        // (kept even when the screen is gone by now: it is there on the way back)
        last = {vibe: q, kind, era, length, items: got, status: text, draw: 0};
        if (gone.current || askId.current !== turn) return;
        land(got, text);
      } catch (e) {
        if (askId.current === turn) fail((e as Error)?.message || 'The recommender didn’t answer.');
      }
    },
    [vibe, kind, era, length, enabled, fail, flashV, handV, land, setPhase, timers, toTop, unfold, wordsV],
  );

  const openDetail = useCallback(
    (item: HeroItem) => {
      if (!canNavigate(navigation)) return;
      navigation.push('Detail', {item});
    },
    [navigation],
  );
  // The stage's key. It is "Open" only once the prize is up — and not for the
  // first 400 ms of that, so a press meant for "Thinking…" opens nothing.
  const openPrize = useCallback(() => {
    if (step.current !== 'won' || rolling.current || Date.now() < armedAt.current) return;
    const it = itemsRef.current[drawRef.current];
    if (it) openDetail(it);
  }, [openDetail]);
  // "Another one": the next pick of the same hand, round to the first again.
  const another = useCallback(() => {
    if (step.current !== 'won' || rolling.current) return;
    const all = itemsRef.current;
    const n = all.length;
    if (n < 2) return;
    const from = drawRef.current;
    const to = nextDraw(from, n);
    if (last && last.items === all) last.draw = to;
    if (calmRef.current) {
      settle(to);
      return;
    }
    const id = ++reelId.current;
    rolling.current = true;
    nextUp.current = to;
    tween(wordsV, 0, 140).start();
    const cells = respinCells(n, from, to);
    setReel({id, cells, v: new Animated.Value(0), stops: reelStops(cells.length - 2, WIN_H, 24), ms: RESPIN_MS, shown: true});
  }, [settle, wordsV]);
  // [group-pick]
  const openTogether = useCallback(() => {
    if (canNavigate(navigation)) navigation.push('GroupPick');
  }, [navigation]);

  const marked = won && items.length > 1 ? draw : -1;
  const renderCard = useCallback(
    ({item, index}: {item: PickItem; index: number}) => {
      const onServer = item.source === 'downloaded' || !!item.inLibrary;
      // The drawn pick, in the hand: a gold star and a gold title. (Not a
      // ring: on a TV a ring says "this has the focus".)
      const drawn = index === marked;
      return (
        <Animated.View style={[styles.pick, {opacity: handV}]}>
          <Card compact item={item} index={index} onPress={openDetail} onFocus={onCardFocus} edgeLeft={index % cols === 0} />
          <View style={styles.pickTitleRow}>
            {drawn ? <Star size={12} color={PLAY.gold} /> : null}
            <Text style={[styles.pickTitle, drawn && styles.pickTitleDrawn]} numberOfLines={1} ellipsizeMode="tail">
              {item.title}
            </Text>
          </View>
          {/* The year, behind a glyph that says where it plays from: a mint
              tick for a copy on this server, a dim play mark for a stream (the
              legend sits in the hand's header — a word does not fit 88dp). */}
          <View style={styles.pickMeta}>
            <Icon name={onServer ? 'check' : 'play'} size={13} color={onServer ? MINT : colors.textFaint} />
            <Text style={[styles.pickYear, onServer && styles.pickYearOn]} numberOfLines={1}>
              {item.year ? String(item.year) : onServer ? 'On server' : 'Stream'}
            </Text>
          </View>
          {item.why ? (
            <Text style={styles.why} numberOfLines={3} ellipsizeMode="tail">
              {item.why}
            </Text>
          ) : null}
        </Animated.View>
      );
    },
    [openDetail, cols, onCardFocus, handV, marked],
  );

  const lengths = LENGTHS[kind];
  const example = EXAMPLES[Math.abs(vibe.length) % EXAMPLES.length];
  hasPicks.current = dealt && items.length > 0;
  const folded = collapsed && phase !== 'off';
  const summary = [
    KINDS.find(k => k.id === kind)?.label || '',
    ERAS.find(e => e.id === era)?.label || '',
    lengths.find(l => l.id === length)?.label || '',
  ].filter(Boolean);
  const off = enabled === false;
  offRef.current = off;

  // ---- the stage ----
  const spinY = useMemo(() => spinV.interpolate({inputRange: [0, 1], outputRange: [0, -WIN_H]}), [spinV]);
  const reelY = useMemo(() => (reel && reel.v && reel.stops ? reel.v.interpolate(reel.stops) : 0), [reel]);
  // each star bright for its third of the beat
  const beats = useMemo(
    () =>
      [0, 1, 2].map(i => {
        const a = i / 3;
        const pts: [number, number][] = [
          [0, 0.28],
          [a, 0.28],
          [a + 1 / 6, 1],
          [a + 1 / 3, 0.28],
          [1, 0.28],
        ];
        const uniq = pts.filter((p, k) => k === 0 || p[0] > pts[k - 1][0] + 1e-6);
        return beatV.interpolate({inputRange: uniq.map(p => p[0]), outputRange: uniq.map(p => p[1])});
      }),
    [beatV],
  );
  const prize = won ? items[draw] : undefined;
  const n = items.length;
  // The pictures "Another one" will roll through, already under the strip (at
  // the window's own size, so they are the very pictures the roll shows).
  const ahead = won && n > 1 ? respinStrip(n, draw, nextDraw(draw, n)).slice(1) : [];
  const onServer = !!prize && (prize.source === 'downloaded' || !!prize.inLibrary);
  const stageUp = phase !== 'off' || stageGhost;

  const stage = stageUp ? (
    <Rise run={stageSerial} ms={STAGE_IN} dy={16} calm={calm} style={[styles.stage, stageGhost && styles.stageGhost]}>
      <View style={styles.machine}>
        <View style={[styles.notch, styles.notchL, won && styles.notchLWon]} />
        <View ref={winRef} collapsable={false} style={styles.window}>
          {ahead.map(i => (
            <View key={`ahead-${i}`} style={styles.strip} pointerEvents="none">
              <Face item={items[i]} />
            </View>
          ))}
          {phase === 'wait' || phase === 'load' ? (
            <Animated.View style={[styles.strip, {transform: [{translateY: calm ? 0 : spinY}]}]}>
              <Image source={BACK_SRC} fadeDuration={0} resizeMode="cover" style={styles.cell} />
              <Image source={BACK_SRC} fadeDuration={0} resizeMode="cover" style={styles.cell} />
            </Animated.View>
          ) : null}
          {reel ? (
            <Animated.View style={[styles.strip, !reel.shown && styles.unseen, {transform: [{translateY: reelY}]}]}>
              {reel.cells.map(c =>
                c.pick == null ? (
                  <Image key={c.key} source={BACK_SRC} fadeDuration={0} resizeMode="cover" style={styles.cell} />
                ) : (
                  <Face key={c.key} item={items[c.pick]} onSettle={onFace} />
                ),
              )}
            </Animated.View>
          ) : null}
          {won ? <View style={styles.frame} pointerEvents="none" /> : null}
          <Animated.View style={[styles.flash, {opacity: flashV}]} pointerEvents="none" />
        </View>
        <View style={[styles.notch, styles.notchR, won && styles.notchRWon]} />
      </View>

      <View style={styles.side}>
        <View style={styles.words}>
          {won || phase === 'land' ? (
            <View style={styles.prizeKicker}>
              <Star size={15} color={PLAY.gold} />
              <Text style={styles.prizeKickerText}>{DRAW.kicker}</Text>
              {won && n > 1 ? <Text style={styles.prizeCount}>{`·  ${DRAW.of(draw + 1, n)}`}</Text> : null}
            </View>
          ) : (
            <>
              <View style={styles.beat}>
                {beats.map((b, i) => (
                  <Animated.View key={i} style={{opacity: calm ? 0.7 : b}}>
                    <Star size={17} color={BEAT_COLORS[i]} />
                  </Animated.View>
                ))}
              </View>
              <Text style={styles.said} numberOfLines={1}>
                {STAGES[said]}
              </Text>
              <Text style={styles.waitText} numberOfLines={2}>
                Asking for actual opinions, not running a database query — give it a few seconds.
              </Text>
            </>
          )}
          {prize ? (
            <Animated.View style={{opacity: wordsV}}>
              <Rise run={serial} i={0} calm={calm}>
                <Text
                  style={styles.prizeTitle}
                  numberOfLines={2}
                  ellipsizeMode="tail"
                  onTextLayout={e => setTitleLines(Math.max(1, e.nativeEvent?.lines?.length || 1))}>
                  {prize.title}
                </Text>
              </Rise>
              <Rise run={serial} i={1} calm={calm} style={styles.prizeMetaRow}>
                <Text style={styles.prizeMeta} numberOfLines={1}>
                  {[prize.year ? String(prize.year) : '', (prize.type || kind) === 'show' ? 'Series' : 'Film'].filter(Boolean).join('  ·  ')}
                </Text>
                {onServer ? (
                  <>
                    <Icon name="check" size={14} color={MINT} />
                    <Text style={styles.prizeOn}>On this server</Text>
                  </>
                ) : null}
              </Rise>
              {prize.why ? (
                <Rise run={serial} i={2} calm={calm}>
                  <Text style={styles.prizeWhy} numberOfLines={titleLines > 1 ? 3 : 4} ellipsizeMode="tail">
                    {prize.why}
                  </Text>
                </Rise>
              ) : null}
            </Animated.View>
          ) : null}
        </View>

        <View style={styles.keys}>
          {/* ONE key, mounted from the ask on: "Thinking…" becomes "Open"
              where it stands, so the focus that was handed to it never moves. */}
          <PlayKey
            ref={mainKey as never}
            uiId={won ? 'pick.open' : undefined}
            big
            kind={won ? 'gold' : 'aurora'}
            dim={!won}
            label={won ? DRAW.open : DRAW.thinking}
            accessibilityLabel={prize ? `${DRAW.open} ${prize.title}` : DRAW.thinking}
            hasTVPreferredFocus={restored}
            edgeLeft
            onFocusChange={onStageFocus}
            onPress={openPrize}
          />
          {won && n > 1 ? (
            <PlayKey
              uiId="pick.another"
              label={DRAW.another}
              leading={<Icon name="refresh" size={16} color={PLAY.ink} />}
              onFocusChange={onStageFocus}
              onPress={another}
            />
          ) : null}
          {won && n > 1 && n <= 12 ? (
            <View style={styles.pips} pointerEvents="none">
              {items.map((_, i) => (
                <View key={i} style={[styles.pip, i === draw && styles.pipOn]} />
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </Rise>
  ) : null;

  // ---- the page above the grid: header, notice, controls, stage, the hand's header ----
  const header = (
    <View>
      <View style={styles.kickerRow}>
        <Icon name="sparkle" size={16} color={colors.accent} />
        <Text style={styles.kicker}>AI</Text>
      </View>
      <Text style={styles.h1} numberOfLines={1}>
        What are you in the mood for?
      </Text>
      <Text style={styles.sub} numberOfLines={1}>
        Describe a mood or pick a few filters, and Aurora picks from what is on this server and what it can stream.
      </Text>

      {/* [group-pick] "What do we watch tonight?" — everyone in the room on their own phone */}
      <Focusable uiId="group.open" edgeLeft noScale style={styles.together} highlightColor={colors.surfaceHover} onPress={openTogether}>
        <Icon name="people" size={20} color={colors.accent} />
        <Text style={styles.togetherTitle}>{GROUP.entry}</Text>
        <Text style={styles.togetherLine} numberOfLines={1}>
          {GROUP.entryLine}
        </Text>
        <Text style={styles.togetherGo}>›</Text>
      </Focusable>

      {off ? (
        <View style={styles.notice}>
          <Icon name="warning" size={20} color={AMBER} />
          <Text style={styles.noticeText}>{OFF_TEXT}</Text>
        </View>
      ) : null}

      {folded || handoff ? (
        /* The dials, folded to one line while the draw has the screen.
           Focusing it (UP from the stage) unfolds the panel and hands focus
           to Find. */
        <Focusable uiId="pick.unfold"
          round
          style={[styles.summary, handoff && styles.summaryGhost]}
          onFocusChange={f => f && !handoff && !toStage.current && unfold()}
          onPress={unfold}
          ring="none"
          highlightColor={colors.white}>
          <Icon name="chat" size={16} color={colors.accent} />
          <Text style={styles.summaryVibe} numberOfLines={1}>
            {vibe.trim() || 'No mood given'}
          </Text>
          <View style={styles.summaryDials}>
            {summary.map((t, i) => (
              <React.Fragment key={t}>
                {i > 0 ? <Text style={styles.summaryDot}>·</Text> : null}
                <Text style={styles.summaryDial}>{t}</Text>
              </React.Fragment>
            ))}
          </View>
          <Text style={styles.summaryHint}>Change</Text>
        </Focusable>
      ) : null}
      {!folded ? (
      <View style={styles.panel}>
        {/* The ask: the mood in your own words, and the button that sends it. */}
        <View style={styles.askRow}>
          <View style={[styles.field, inputFocused && styles.fieldFocused, off && styles.fieldOff]}>
            <Icon name="chat" size={18} color={inputFocused ? colors.accent : colors.textFaint} />
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={vibe}
              onChangeText={setVibe}
              // No autoFocus: a focused field opens the TV keyboard, which
              // covered the controls the moment the page opened (Mi TV,
              // 2026-10-08). Focus lands on "Find me something"; the field is
              // one press left of it.
              onFocus={() => {
                inGrid.current = false;
                noteFocus(null, false);
                setInputFocused(true);
              }}
              onBlur={() => setInputFocused(false)}
              onSubmitEditing={() => ask()}
              returnKeyType="search"
              placeholder={`e.g. ${example}`}
              placeholderTextColor={colors.textFaint}
              maxLength={300}
              numberOfLines={1}
              editable={!off}
            />
          </View>
          <TVFocusGuideView trapFocusLeft={off}>
            <Btn uiId="pick.go"
              ref={goBtn as never}
              primary
              icon="sparkle"
              label={busy ? DRAW.thinking : 'Find me something'}
              hasTVPreferredFocus={!restored}
              onFocusChange={f => {
                findFocused.current = f;
              }}
              onPress={() => ask()}
            />
          </TVFocusGuideView>
        </View>

        <View style={styles.hr} />

        {/* The dials, labelled. Row one: What | Era. Row two: Length. */}
        <View style={styles.dialRow}>
          <Group icon={kind === 'show' ? 'series' : 'film'} label="WHAT">
            {KINDS.map((k, i) => (
              <Chip uiId="pick.option"
                key={k.id}
                ref={i === 0 ? (firstKind as never) : undefined}
                small
                label={k.label}
                on={kind === k.id}
                edgeLeft={i === 0}
                onPress={() => {
                  setKind(k.id);
                  setLength('any'); // the length ids are per kind
                }}
              />
            ))}
          </Group>
          <View style={styles.vr} />
          <Group icon="calendar" label="ERA">
            {ERAS.map(e => (
              <Chip uiId="pick.option" key={e.id} small label={e.label} on={era === e.id} onPress={() => setEra(e.id)} />
            ))}
          </Group>
        </View>
        <View style={[styles.dialRow, styles.dialRowNext]}>
          <Group icon="clock" label="LENGTH">
            {lengths.map((l, i) => (
              <Chip uiId="pick.option" key={l.id} small label={l.label} on={length === l.id} edgeLeft={i === 0} onPress={() => setLength(l.id)} />
            ))}
          </Group>
        </View>
      </View>
      ) : null}

      {stage}

      {/* The hand's own header: what came back, and a way to ask again. Drawn
          from the first ask on, and kept mounted while a new answer is on its
          way. */}
      {asked ? (
        <View style={styles.picksHead}>
          <Icon name="sparkle" size={16} color={colors.accent} />
          <Text style={[styles.picksTitle, busy && styles.picksTitleDim]}>{busy || items.length ? DRAW.hand : 'No picks'}</Text>
          <Text style={styles.picksStatus} numberOfLines={1} ellipsizeMode="tail">
            {busy ? 'Being dealt…' : status}
          </Text>
          {hasPicks.current && won ? (
            <View style={styles.legend}>
              <Icon name="check" size={13} color={MINT} />
              <Text style={styles.legendText}>on this server</Text>
              <Icon name="play" size={13} color={colors.textFaint} />
              <Text style={styles.legendText}>streams</Text>
            </View>
          ) : null}
          <Btn uiId="pick.retry"
            ref={againBtn as never}
            small
            icon="refresh"
            label="Try again"
            dim={busy}
            onFocusChange={f => {
              if (f) inGrid.current = false; // UP from here is the stage's, not the grid escape's
            }}
            onPress={() => ask(undefined, true)}
          />
        </View>
      ) : null}
    </View>
  );

  // ---- what sits where the grid goes when there is no grid ----
  // (While the question is out there is nothing here: the stage is the wait.)
  let body: React.ReactNode = null;
  if (busy) {
    body = null;
  } else if (error) {
    body = (
      <View style={styles.state}>
        <Icon name="warning" size={28} color="#ff7a7a" />
        <Text style={styles.stateError}>{error}</Text>
        <Text style={styles.stateHint}>Try again in a moment, or change the question.</Text>
      </View>
    );
  } else if (empty) {
    body = (
      <View style={styles.state}>
        <Icon name="search" size={28} color={colors.textDim} />
        <Text style={styles.stateTitle}>Nothing matched — try fewer filters</Text>
        <Text style={styles.stateHint}>Or describe it a different way.</Text>
      </View>
    );
  } else if (!asked && !off) {
    // Before the first ask: a few one-press examples, the site's "Try:" row.
    body = (
      <View style={styles.tryRow}>
        <Text style={styles.tryLabel}>Try</Text>
        {EXAMPLES.slice(0, 3).map((ex, i) => (
          <Chip uiId="pick.example" key={ex} small bare label={ex} edgeLeft={i === 0} onPress={() => ask(ex)} />
        ))}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Room on={inFront} calm={calm} />
      <NavRail active="ai" />
      <View style={styles.body}>
        <FlatList
          ref={listRef}
          data={dealt ? items : NO_PICKS}
          extraData={marked}
          style={styles.listFill}
          numColumns={cols}
          key={`cols-${cols}`}
          keyExtractor={(it, i) => `${it.id || it.imdbId}-${i}`}
          columnWrapperStyle={styles.rowGap}
          contentContainerStyle={[styles.grid, {paddingBottom: CLEARANCE.below + safeBottom}]}
          ListHeaderComponent={header}
          ListEmptyComponent={body ? <View>{body}</View> : null}
          initialNumToRender={cols * 2}
          maxToRenderPerBatch={cols * 2}
          windowSize={5}
          renderItem={renderCard}
        />
      </View>
      {/* the reward, over the whole page */}
      <Burst fire={fire.n} x={fire.x} y={fire.y} count={16} seed={fire.seed} calm={calm} />
    </View>
  );
}


const styles = StyleSheet.create({
  root: {flex: 1},
  // Same gutters as Search / Browse. The top inset is on the list's CONTENT
  // (the header scrolls away with it), not on the list.
  body: {flex: 1, paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX},
  listFill: {flex: 1},
  grid: {paddingTop: spacing.pageY},

  // ---- header ----
  kickerRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  kicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 3},
  h1: {color: colors.text, fontSize: fontSize.title, lineHeight: 30, fontWeight: '900', marginTop: 2},
  sub: {color: colors.textDim, fontSize: 14, lineHeight: 19, marginTop: 2, marginBottom: 12},
  // [group-pick] the way into "What do we watch tonight?" — the panel's glass, one line
  together: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(139,123,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(139,123,255,0.28)',
    borderRadius: radius.l,
    paddingVertical: 9,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  togetherTitle: {color: colors.text, fontSize: 16, fontWeight: '800'},
  togetherLine: {flex: 1, color: colors.textDim, fontSize: 14},
  togetherGo: {color: colors.textDim, fontSize: 20, fontWeight: '700'},

  // ---- the no-key notice ----
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: radius.m,
    backgroundColor: 'rgba(251,191,36,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.35)',
    marginBottom: 12,
  },
  noticeText: {flex: 1, color: AMBER, fontSize: 14, lineHeight: 19, fontWeight: '600'},

  // ---- the controls panel (glass) ----
  panel: {
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.l,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  askRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  field: {
    flex: 1,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 14,
    paddingRight: 8,
    borderRadius: radius.m,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  // The field is not a Focusable, so its focus is told by the accent edge.
  fieldFocused: {borderColor: colors.accent, backgroundColor: colors.surfaceHover},
  fieldOff: {opacity: 0.55},
  input: {flex: 1, color: colors.text, fontSize: 16, paddingVertical: 0, paddingHorizontal: 0},
  hr: {height: 1, backgroundColor: colors.line, marginVertical: 12},
  // the folded panel: one line, the same glass as the panel
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.l,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  summaryVibe: {color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1},
  summaryDials: {flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 6, flexShrink: 0},
  summaryDial: {color: colors.textDim, fontSize: 14, fontWeight: '600'},
  summaryDot: {color: colors.textFaint, fontSize: 14},
  summaryHint: {marginLeft: 'auto', color: colors.textFaint, fontSize: 13, fontWeight: '700'},
  summaryGhost: {opacity: 0, height: 0, paddingVertical: 0, borderWidth: 0, overflow: 'hidden'},
  dialRow: {flexDirection: 'row', alignItems: 'center', gap: 16},
  dialRowNext: {marginTop: 8},
  vr: {width: 1, alignSelf: 'stretch', backgroundColor: colors.line, marginVertical: 4},
  group: {flexDirection: 'row', alignItems: 'center', gap: 6},
  // A fixed label column, so the pills of What and Length start on one line.
  groupLabel: {flexDirection: 'row', alignItems: 'center', gap: 6, width: 92},
  groupText: {color: colors.textDim, fontSize: 13, fontWeight: '800', letterSpacing: 1.4},

  // ---- the stage ----
  stage: {flexDirection: 'row', height: WIN_H, marginTop: 12, gap: 20},
  stageGhost: {opacity: 0, height: 0, marginTop: 0, overflow: 'hidden'},
  // the window with its two payline marks
  machine: {width: WIN_W + 2 * NOTCH, height: WIN_H, flexDirection: 'row', alignItems: 'center'},
  window: {width: WIN_W, height: WIN_H, borderRadius: WIN_R, overflow: 'hidden', backgroundColor: PLAY.tile},
  strip: {position: 'absolute', left: 0, top: 0, width: WIN_W},
  unseen: {opacity: 0},
  cell: {width: WIN_W, height: WIN_H},
  // the prize's frame and its flash (gold: a win)
  frame: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: WIN_R, borderWidth: 2, borderColor: PLAY.gold},
  flash: {position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: PLAY.goldHi},
  // a small arrow head, pointing at the window
  notch: {width: 0, height: 0, borderTopWidth: 6, borderBottomWidth: 6, borderTopColor: 'transparent', borderBottomColor: 'transparent'},
  notchL: {borderLeftWidth: 9, borderLeftColor: PLAY.line, marginRight: NOTCH - 9},
  notchR: {borderRightWidth: 9, borderRightColor: PLAY.line, marginLeft: NOTCH - 9},
  notchLWon: {borderLeftColor: PLAY.gold},
  notchRWon: {borderRightColor: PLAY.gold},
  // beside the window: the words on top, the keys at the foot (they never move)
  side: {flex: 1, height: WIN_H},
  words: {flex: 1, paddingTop: 2, overflow: 'hidden'},
  beat: {flexDirection: 'row', alignItems: 'center', gap: 10, height: 22},
  said: {color: PLAY.ink, fontSize: 20, lineHeight: 27, fontWeight: '800', marginTop: 10},
  waitText: {color: PLAY.inkFaint, fontSize: 14, lineHeight: 19, marginTop: 6, maxWidth: 480},
  prizeKicker: {flexDirection: 'row', alignItems: 'center', gap: 7, height: 22},
  prizeKickerText: {color: PLAY.gold, fontSize: 13, lineHeight: 18, fontWeight: '900', letterSpacing: 2.2},
  prizeCount: {color: PLAY.inkDim, fontSize: 13, lineHeight: 18, fontWeight: '700'},
  prizeTitle: {color: PLAY.ink, fontSize: 26, lineHeight: 31, fontWeight: '900', marginTop: 4},
  prizeMetaRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3},
  prizeMeta: {color: PLAY.inkDim, fontSize: 15, lineHeight: 20, fontWeight: '700', marginRight: 6},
  prizeOn: {color: MINT, fontSize: 14, lineHeight: 20, fontWeight: '700'},
  prizeWhy: {color: PLAY.inkDim, fontSize: 15, lineHeight: 21, marginTop: 7, maxWidth: 560},
  keys: {flexDirection: 'row', alignItems: 'center', gap: 12},
  pips: {flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 6},
  pip: {width: 7, height: 7, borderRadius: 3.5, backgroundColor: 'rgba(255,255,255,0.22)'},
  pipOn: {backgroundColor: PLAY.gold},

  // ---- the hand's header ----
  picksHead: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 16},
  picksTitle: {color: colors.text, fontSize: 16, fontWeight: '800'},
  picksTitleDim: {color: colors.textDim},
  picksStatus: {flex: 1, color: colors.textDim, fontSize: 14, marginLeft: 4},

  // ---- the grid ----
  rowGap: {gap: GAP, marginBottom: 18},
  pick: {width: COMPACT_W},
  pickTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 7},
  pickTitle: {flexShrink: 1, color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: '700'},
  pickTitleDrawn: {color: PLAY.gold},
  pickMeta: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1},
  pickYear: {color: colors.textDim, fontSize: 13, lineHeight: 17},
  pickYearOn: {color: MINT},
  legend: {flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: 6},
  legendText: {color: colors.textFaint, fontSize: 13, marginRight: 6},
  why: {color: colors.textDim, fontSize: 13, lineHeight: 17, marginTop: 4},

  // ---- states ----
  state: {alignItems: 'center', paddingVertical: 36, gap: 8},
  stateTitle: {color: colors.text, fontSize: 16, fontWeight: '700', textAlign: 'center'},
  stateError: {color: '#ff7a7a', fontSize: 16, fontWeight: '700', textAlign: 'center'},
  stateHint: {color: colors.textDim, fontSize: 14, textAlign: 'center'},
  tryRow: {flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 14},
  tryLabel: {color: colors.textFaint, fontSize: 14, fontWeight: '700', marginRight: 4},
});
