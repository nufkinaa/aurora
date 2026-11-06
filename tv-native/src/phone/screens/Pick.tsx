// "AI pick" on the phone — the website's AI page (public/js/screens/pickforme.js)
// at its phone size: describe the mood, flip Movies / Shows, set the two taste
// dials, and the server (src/media/ai.js) answers with titles, each with a line
// on why it fits. Same words, same ask (POST /api/ai/recommend), the same rule
// for when the page is there at all (GET /api/ai/status → enabled, phone/aiStatus.ts).
//
// The posters are the phone's PosterCard and open through the shared openItem,
// so a pick opens and plays like a title found any other way. The website's
// .pfm-results columns are 188 wide at the least, which on a phone is ONE
// column of whole-width posters; here never fewer than two, 188+ above that.
//
// The last answer lives at module scope (as on the site): coming back to the
// page paints it again instead of spending another ten seconds (and real money)
// on the same question. It is this profile's: dropped when the profile is left
// (profileScope.ts), and stamped with whoever asked.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Animated, Easing, FlatList, Keyboard, StyleSheet, Text, TextInput, View, useWindowDimensions} from 'react-native';
import {api, HeroItem} from '../../api';
import {useApp} from '../../AppContext';
import {useMe} from '../../navSection';
import {openItem} from '../../openItem';
import {registerProfileCache} from '../../profileScope';
import {showToast} from '../../toast';
import {usePNav} from '../nav';
import {aiEnabled, aiKnown} from '../aiStatus';
import {PosterCard} from '../ui/Cards';
import {BackBar, useColumn, usePageTop, useSolidBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import Glass from '../ui/Glass';
import Tap from '../ui/Tap';
import {colors, GUTTER} from '../theme';

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
const PAGE_TITLE = 'AI pick';

// .pfm .pfm-results: columns of 188 at the least, 12 apart on a phone
const MIN_COL = 188;
const GAP = 12;
const SKELETONS = 6;

type PickItem = HeroItem & {why?: string | null};
type Answer = {vibe: string; kind: Kind; era: string; length: string; items: PickItem[]; status: string; owner: string};
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

/** A taste pill (.pfm-pill): wraps to a second line rather than run off a narrow phone. */
function Pill({label, on, onPress}: {label: string; on: boolean; onPress: () => void}) {
  return (
    <Tap
      uiId="pick.option"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{selected: on}}
      onPress={onPress}
      style={[s.pill, on && s.pillOn]}>
      <Text style={[s.pillText, on && s.pillTextOn]} numberOfLines={2}>
        {label}
      </Text>
    </Tap>
  );
}

/** One labelled dial row (.pfm-tune-group): the caps label, then its pills, wrapping. */
function Dial({label, options, value, onPick}: {label: string; options: {id: string; label: string}[]; value: string; onPick: (id: string) => void}) {
  return (
    <View style={s.group}>
      <Text style={s.groupLabel}>{label.toUpperCase()}</Text>
      {options.map(o => (
        <Pill key={o.id} label={o.label} on={o.id === value} onPress={() => onPick(o.id)} />
      ))}
    </View>
  );
}

/** The wait's sweeping bar (.pfm-wait-bar). */
function SweepBar() {
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(x, {toValue: 1, duration: 1500, easing: Easing.bezier(0.2, 0.7, 0.2, 1), useNativeDriver: true}));
    loop.start();
    return () => loop.stop();
  }, [x]);
  const {width} = useWindowDimensions();
  const barW = Math.min(430, width * 0.6);
  return (
    <View style={[s.bar, {width: barW}]}>
      <Animated.View style={[s.sweep, {width: barW * 0.38, transform: [{translateX: x.interpolate({inputRange: [0, 1], outputRange: [-barW * 0.4, barW * 1.4]})}]}]} />
    </View>
  );
}

export default function Pick() {
  const bar = useSolidBar();
  const top = usePageTop();
  const column = useColumn();
  const bottom = useTabBarSpace();
  const navigation = usePNav();
  const {profileId} = useApp();
  const me = useMe(profileId);
  const {width} = useWindowDimensions();
  if (last && last.owner !== profileId) last = null;
  const mine = last;

  const [enabled, setEnabled] = useState<boolean | null>(aiKnown());
  const [vibe, setVibe] = useState(mine?.vibe || '');
  const [kind, setKind] = useState<Kind>(mine?.kind || 'movie');
  const [era, setEra] = useState(mine?.era || 'any');
  const [length, setLength] = useState(mine?.length || 'any');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [items, setItems] = useState<PickItem[]>(mine?.items || []);
  const [status, setStatus] = useState(mine?.status || '');
  const [inputOn, setInputOn] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const live = useRef(true);
  const who = useRef(profileId);
  who.current = profileId;
  const busyRef = useRef(false);

  useEffect(() => {
    live.current = true;
    aiEnabled().then(on => live.current && setEnabled(on));
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (!busy) return;
    setStage(0);
    const t = setInterval(() => setStage(n => Math.min(n + 1, STAGES.length - 1)), STAGE_MS);
    return () => clearInterval(t);
  }, [busy]);

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
      const asker = profileId; // an answer belongs to whoever asked
      try {
        const mix = KINDS.find(k => k.id === kind)!.mix;
        const res = await api.aiRecommend(q, mix, era, length);
        if (asker !== who.current) return; // the profile changed while it was thinking
        const got = (res.items || []) as PickItem[];
        if (!got.length) {
          if (live.current) setStatus(W.empty);
          return;
        }
        const text = statusLine(got.length, kind, q, !!res.cached, era, length);
        // kept before it is painted: an answer that lands while the page is gone waits for its return
        last = {vibe: q, kind, era, length, items: got, status: text, owner: asker};
        if (live.current) {
          setItems(got);
          setStatus(text);
        }
      } catch (e) {
        if (live.current) showToast((e as Error)?.message || W.failed, '🤖');
      } finally {
        busyRef.current = false;
        if (live.current) setBusy(false);
      }
    },
    [vibe, kind, era, length, profileId],
  );

  const open = useCallback((it: HeroItem) => openItem(navigation, it), [navigation]);

  // the grid: inside the page's column (a tablet / landscape), never fewer than two
  const pageW = column ? Math.min(width, 820) : width;
  const avail = pageW - GUTTER * 2;
  const cols = Math.max(2, Math.floor((avail + GAP) / (MIN_COL + GAP)));
  const cardW = Math.floor((avail - GAP * (cols - 1)) / cols);
  const renderPick = useCallback(
    ({item}: {item: PickItem}) => (
      <View style={[s.pick, {width: cardW}]}>
        <PosterCard item={item} width={cardW} onPress={open} />
        {item.why ? (
          <Text style={s.why} numberOfLines={3} ellipsizeMode="tail" accessibilityLabel={item.why}>
            {item.why}
          </Text>
        ) : null}
      </View>
    ),
    [cardW, open],
  );

  const shows = kind === 'show';
  const flip = () => {
    setKind(shows ? 'movie' : 'show');
    setLength('any'); // the length ids are per kind
  };

  const form = (
    <>
      <Glass style={s.box}>
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
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          maxLength={300}
          accessibilityLabel={W.placeholder}
        />
        <Tap uiId="pick.go" accessibilityRole="button" accessibilityLabel={W.go} accessibilityState={{disabled: busy}} disabled={busy} onPress={() => ask()} style={[s.go, busy && s.goOff]}>
          <Text style={s.goText}>{W.go}</Text>
        </Tap>
        <View style={s.tune}>
          {/* one control, one tap: anywhere on it flips Movies <-> Shows */}
          <Tap
            uiId="pick.option"
            accessibilityRole="switch"
            accessibilityLabel={W.switchLabel}
            accessibilityState={{checked: shows}}
            onPress={flip}
            flat
            style={s.switch}>
            {KINDS.map(k => (
              <View key={k.id} style={[s.switchOpt, k.id === kind && s.switchOptOn]}>
                <Text style={[s.switchText, k.id === kind && s.switchTextOn]}>{k.label}</Text>
              </View>
            ))}
          </Tap>
          <Dial label={W.era} options={ERAS} value={era} onPick={setEra} />
          <Dial label={W.length} options={LENGTHS[kind]} value={length} onPick={setLength} />
        </View>
      </Glass>
      <View style={s.examples}>
        <Text style={s.examplesLabel}>{W.tryLabel}</Text>
        {EXAMPLES.map(ex => (
          <Tap key={ex} uiId="pick.example" accessibilityRole="button" flat onPress={() => ask(ex)} style={s.example}>
            <Text style={s.exampleText}>{ex}</Text>
          </Tap>
        ))}
      </View>
      {status ? <Text style={s.status}>{status}</Text> : null}
    </>
  );

  const header = (
    <View style={[s.head, {paddingTop: top}]}>
      <Text style={s.h1} accessibilityRole="header">
        {W.title}
      </Text>
      <Text style={s.sub}>{W.sub}</Text>
      {enabled === null ? (
        <ActivityIndicator color={colors.text} style={s.loading} />
      ) : enabled === false ? (
        <Glass style={s.offBox}>
          <Text style={s.offText}>{me?.kids ? W.offKids : W.off}</Text>
        </Glass>
      ) : (
        form
      )}
    </View>
  );

  const waiting = busy ? (
    <View>
      <View style={s.wait}>
        <Text style={s.waitMsg}>{STAGES[stage]}</Text>
        <SweepBar />
        <Text style={s.waitHint}>{W.waitHint}</Text>
      </View>
      {/* poster-shaped placeholders, so the picks land into a layout that already has their shape */}
      <View style={s.skels}>
        {Array.from({length: SKELETONS}, (_, i) => (
          <View key={i} style={[s.skel, {width: cardW, height: Math.round(cardW * 1.5)}]} />
        ))}
      </View>
    </View>
  ) : null;

  return (
    <View style={s.root}>
      <FlatList
        key={`cols-${cols}`}
        data={enabled ? items : []}
        numColumns={cols}
        keyExtractor={(it, i) => `${it.id || it.imdbId || it.title}-${i}`}
        renderItem={renderPick}
        columnWrapperStyle={s.row}
        ItemSeparatorComponent={Sep}
        ListHeaderComponent={header}
        ListEmptyComponent={waiting}
        contentContainerStyle={[{paddingBottom: bottom + 16}, column]}
        onScroll={bar.onScroll}
        scrollEventThrottle={64}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={cols * 3}
        maxToRenderPerBatch={cols * 2}
        windowSize={7}
      />
      <BackBar solid={bar.solid} title={bar.solid ? PAGE_TITLE : undefined} />
    </View>
  );
}

const Sep = () => <View style={s.sep} />;

const s = StyleSheet.create({
  root: {flex: 1},
  // ---- .pfm-head ----
  head: {paddingHorizontal: GUTTER, paddingBottom: 22},
  h1: {color: colors.text, fontSize: 32, fontWeight: '900', letterSpacing: -0.7, lineHeight: 36},
  sub: {color: colors.textDim, fontSize: 16.3, lineHeight: 25, marginTop: 12},
  loading: {marginTop: 30},
  // ---- .pfm-box: one calm glass panel ----
  box: {marginTop: 26, padding: 22, borderRadius: 24, gap: 12},
  input: {
    minHeight: 54,
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    color: colors.text,
    fontSize: 16.8,
    paddingHorizontal: 17,
    paddingVertical: 13,
  },
  inputOn: {backgroundColor: 'rgba(0,0,0,0.55)', borderColor: 'rgba(139,123,255,0.75)'},
  // .pfm-go at phone width: the whole width, the violet gradient
  go: {
    minHeight: 50,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentStrong,
    experimental_backgroundImage: 'linear-gradient(180deg, #8b7bff, #6c58ff)',
    boxShadow: '0 10px 26px rgba(108,88,255,0.34)',
    overflow: 'hidden',
  },
  goOff: {opacity: 0.5, boxShadow: 'none'},
  goText: {color: '#fff', fontSize: 16, fontWeight: '800', textAlign: 'center'},
  // ---- .pfm-tune: under a hairline ----
  tune: {marginTop: 6, paddingTop: 18, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', gap: 14},
  // .pfm-switch: 236 wide (or the box's width, if less), the lit half violet
  switch: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    width: 236,
    maxWidth: '100%',
    padding: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  switchOpt: {flex: 1, minHeight: 38, borderRadius: 999, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 6},
  switchOptOn: {
    backgroundColor: colors.accentStrong,
    experimental_backgroundImage: 'linear-gradient(180deg, #8b7bff, #6c58ff)',
    boxShadow: '0 6px 18px rgba(108,88,255,0.4)',
  },
  switchText: {flexShrink: 1, color: colors.textDim, fontSize: 14.7, fontWeight: '800', textAlign: 'center'},
  switchTextOn: {color: '#fff'},
  group: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 9},
  groupLabel: {color: colors.textFaint, fontSize: 11.4, fontWeight: '800', letterSpacing: 1},
  pill: {
    maxWidth: '100%',
    minHeight: 36,
    justifyContent: 'center',
    paddingVertical: 7,
    paddingHorizontal: 15,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.045)',
  },
  pillOn: {backgroundColor: 'rgba(139,123,255,0.2)', borderColor: 'rgba(139,123,255,0.62)'},
  pillText: {flexShrink: 1, color: colors.textDim, fontSize: 13.7, fontWeight: '700', textAlign: 'center'},
  pillTextOn: {color: '#fff'},
  // ---- .pfm-examples: outside the panel ----
  examples: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 2, paddingTop: 16},
  examplesLabel: {color: colors.textFaint, fontSize: 12.5, fontWeight: '800', letterSpacing: 0.5},
  example: {maxWidth: '100%', paddingVertical: 6},
  exampleText: {flexShrink: 1, color: colors.accent, fontSize: 13.9},
  status: {color: colors.textDim, fontSize: 14.1, lineHeight: 20, paddingTop: 22},
  // ---- the no-AI line ----
  offBox: {marginTop: 26, padding: 18},
  offText: {color: colors.textDim, fontSize: 15.7, lineHeight: 23},
  // ---- the wait ----
  wait: {alignItems: 'center', gap: 18, paddingTop: 48, paddingBottom: 10, paddingHorizontal: GUTTER},
  waitMsg: {color: colors.text, fontSize: 21.6, fontWeight: '700', letterSpacing: -0.26, textAlign: 'center'},
  bar: {height: 4, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.1)', overflow: 'hidden'},
  sweep: {height: 4, borderRadius: 999, experimental_backgroundImage: 'linear-gradient(90deg, rgba(139,123,255,0), #8b7bff, rgba(139,123,255,0))'},
  waitHint: {color: colors.textFaint, fontSize: 13.9, lineHeight: 20, textAlign: 'center'},
  skels: {flexDirection: 'row', flexWrap: 'wrap', gap: GAP, paddingHorizontal: GUTTER, paddingTop: 22},
  skel: {borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.06)'},
  // ---- the picks ----
  row: {paddingHorizontal: GUTTER, gap: GAP, alignItems: 'flex-start'},
  sep: {height: 18},
  pick: {gap: 10},
  why: {
    color: colors.textDim,
    fontSize: 13.1,
    lineHeight: 19,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(139,123,255,0.55)',
  },
});
