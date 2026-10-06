// The AI tab — the site's "Pick for me" (screens/pickforme.js), on a remote.
// Describe the mood, pick Movies or Shows and two taste dials, press Find, and
// the server (src/media/ai.js) answers with titles and a line on why each one
// fits. The cards are the same Card the rest of the app uses, so anything
// picked here opens and plays like a title found any other way.
//
// It replaces "New" in the nav rail (elia, 2026-10-06); the New page is still
// one press away under Settings → What's new.
//
// The last answer lives at module scope: opening a result and coming Back
// paints it straight back instead of spending another ten seconds (and real
// money) on the same question.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, TextInput, FlatList, StyleSheet, ActivityIndicator} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Card, {CARD_W} from '../components/Card';
import Chip from '../components/Chip';
import Btn from '../components/Btn';
import NavRail from '../components/NavRail';
import {api, HeroItem} from '../api';
import {canNavigate} from '../navLock';
import {warmItem} from '../prefetch';
import {noteFocus, railOpen, useFocusFallback, useTVKeys} from '../focus';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

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

type PickItem = HeroItem & {why?: string};
type Answer = {vibe: string; kind: 'movie' | 'show'; era: string; length: string; items: PickItem[]; status: string};
let last: Answer | null = null;

export default function Pick({navigation}: NativeStackScreenProps<RootStackParamList, 'Pick'>) {
  const {width, safeBottom} = useTvMetrics();
  const cols = Math.max(
    3,
    Math.floor((width - spacing.contentLeft - spacing.pageX + spacing.md) / (CARD_W + spacing.md)),
  );
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [vibe, setVibe] = useState(last?.vibe || '');
  const [kind, setKind] = useState<'movie' | 'show'>(last?.kind || 'movie');
  const [era, setEra] = useState(last?.era || 'any');
  const [length, setLength] = useState(last?.length || 'any');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [items, setItems] = useState<PickItem[]>(last?.items || []);
  const [status, setStatus] = useState(last?.status || '');
  const inputRef = useRef<TextInput>(null);
  const inputFallback = useRef({requestTVFocus: () => inputRef.current?.focus()});
  useFocusFallback(inputFallback);

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

  // Narration while the server thinks.
  useEffect(() => {
    if (!busy) return;
    setStage(0);
    const t = setInterval(() => setStage(s => Math.min(s + 1, STAGES.length - 1)), 2600);
    return () => clearInterval(t);
  }, [busy]);

  // UP out of the results grid lands on the Find button, deterministically
  // (the native focus search regularly finds nothing above a top-row card —
  // Browse and Search carry the same escape).
  const inGrid = useRef(false);
  const gridIdx = useRef(0);
  const goBtn = useRef<{requestTVFocus?: () => void}>(null);
  useTVKeys(
    useCallback(
      (evt: {eventType: string}) => {
        if (evt.eventType !== 'up' || railOpen()) return;
        if (!inGrid.current || gridIdx.current >= cols) return;
        inGrid.current = false;
        goBtn.current?.requestTVFocus?.();
      },
      [cols],
    ),
  );
  const onCardFocus = useCallback((item: HeroItem, index: number) => {
    warmItem(item);
    inGrid.current = true;
    gridIdx.current = index;
  }, []);

  const ask = useCallback(async () => {
    const q = vibe.trim();
    if (q.length < 3) {
      inputRef.current?.focus();
      return;
    }
    if (busy) return;
    setBusy(true);
    setStatus('');
    setItems([]);
    try {
      const mix = KINDS.find(k => k.id === kind)!.mix;
      const res = await api.aiRecommend(q, mix, era, length);
      const got = (res.items || []) as PickItem[];
      if (!got.length) {
        setStatus('Nothing came back for that. Try describing it differently.');
        return;
      }
      const noun = kind === 'show' ? (got.length === 1 ? 'show' : 'shows') : got.length === 1 ? 'film' : 'films';
      const text =
        `${got.length} ${noun} for “${q}”` +
        (res.cached ? ' · from earlier' : '') +
        (got.length < 5 && (era !== 'any' || length !== 'any') ? ' · not much fits those filters, try loosening one' : '');
      last = {vibe: q, kind, era, length, items: got, status: text};
      setItems(got);
      setStatus(text);
    } catch (e) {
      setStatus((e as Error)?.message || 'The recommender didn’t answer.');
    } finally {
      setBusy(false);
    }
  }, [vibe, kind, era, length, busy]);

  const openDetail = useCallback(
    (item: HeroItem) => {
      if (!canNavigate(navigation)) return;
      navigation.push('Detail', {item});
    },
    [navigation],
  );
  const renderCard = useCallback(
    ({item, index}: {item: PickItem; index: number}) => (
      <View style={styles.pick}>
        <Card item={item} index={index} onPress={openDetail} onFocus={onCardFocus} edgeLeft={index % cols === 0} />
        {item.why ? (
          <Text style={styles.why} numberOfLines={3}>
            {item.why}
          </Text>
        ) : null}
      </View>
    ),
    [openDetail, cols, onCardFocus],
  );

  const lengths = LENGTHS[kind];
  const example = EXAMPLES[Math.abs(vibe.length) % EXAMPLES.length];

  return (
    <View style={styles.root}>
      <NavRail active="ai" />
      <View style={styles.body}>
        <Text style={styles.kicker}>AI</Text>
        <Text style={styles.h1}>What are you in the mood for?</Text>
        {enabled === false ? (
          <Text style={styles.off}>The recommender isn’t set up on this server. The admin adds a key under Admin → Server to switch it on.</Text>
        ) : null}
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={vibe}
          onChangeText={setVibe}
          autoFocus={!last}
          onFocus={() => {
            inGrid.current = false;
            noteFocus(null, false);
          }}
          onSubmitEditing={ask}
          returnKeyType="search"
          placeholder={`e.g. ${example}`}
          placeholderTextColor={colors.textFaint}
          maxLength={300}
          editable={enabled !== false}
        />
        {/* The dials: one row each, like the site's pill rows. */}
        <View style={styles.dials}>
          <View style={styles.dialRow}>
            {KINDS.map((k, i) => (
              <Chip
                key={k.id}
                label={k.label}
                on={kind === k.id}
                edgeLeft={i === 0}
                onPress={() => {
                  setKind(k.id);
                  setLength('any'); // the length ids are per kind
                }}
              />
            ))}
            <View style={styles.dialGap} />
            {ERAS.map(e => (
              <Chip key={e.id} label={e.label} on={era === e.id} onPress={() => setEra(e.id)} />
            ))}
          </View>
          <View style={styles.dialRow}>
            {lengths.map((l, i) => (
              <Chip key={l.id} label={l.label} on={length === l.id} edgeLeft={i === 0} onPress={() => setLength(l.id)} />
            ))}
            <View style={styles.dialGap} />
            <Btn
              ref={goBtn as never}
              primary
              label={busy ? STAGES[stage] : 'Find me something'}
              hasTVPreferredFocus={!!last}
              onPress={ask}
            />
          </View>
        </View>
        {busy ? <ActivityIndicator color={colors.text} style={styles.spinner} /> : null}
        {status ? <Text style={styles.status}>{status}</Text> : null}
        <FlatList
          data={items}
          style={styles.listFill}
          numColumns={cols}
          key={`cols-${cols}`}
          keyExtractor={(it, i) => `${it.id || it.imdbId}-${i}`}
          columnWrapperStyle={styles.rowGap}
          contentContainerStyle={[styles.grid, {paddingBottom: CLEARANCE.below + safeBottom}]}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          renderItem={renderCard}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  body: {flex: 1, paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX, paddingTop: 27},
  kicker: {color: colors.accent, fontSize: fontSize.small, fontWeight: '800', letterSpacing: 3},
  h1: {color: colors.text, fontSize: fontSize.title, fontWeight: '900', marginTop: 2, marginBottom: spacing.md},
  off: {color: '#fbbf24', fontSize: fontSize.body, marginBottom: spacing.md},
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.m,
    color: colors.text,
    fontSize: fontSize.row,
    paddingVertical: 14,
    paddingHorizontal: 22,
    marginBottom: spacing.md,
  },
  dials: {gap: spacing.sm, marginBottom: spacing.md},
  dialRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap'},
  dialGap: {width: spacing.md},
  spinner: {marginBottom: spacing.sm, alignSelf: 'flex-start'},
  status: {color: colors.textDim, fontSize: fontSize.body, fontWeight: '600', marginBottom: spacing.sm},
  listFill: {flex: 1},
  grid: {paddingTop: CLEARANCE.above, gap: spacing.lg},
  rowGap: {gap: spacing.md},
  pick: {width: CARD_W},
  why: {color: colors.textDim, fontSize: 13, lineHeight: 18, marginTop: 8},
});
