// The AI tab — the site's "Pick for me" (screens/pickforme.js), on a remote.
// Describe the mood, pick Movies or Shows and two taste dials, press Find, and
// the server (src/media/ai.js) answers with titles and a line on why each one
// fits. The cards are the same Card the rest of the app uses (its compact
// size), so anything picked here opens and plays like a title found any other
// way.
//
// It replaces "New" in the nav rail (elia, 2026-10-06); the New page is still
// one press away under Settings → What's new.
//
// Layout (2026-10-08, "more clear what it does … cards a bit smaller"): a
// header that says what the page is for, ONE glass panel holding the ask (the
// mood field + Find) over the labelled dials (What | Era, then Length), and
// the picks under it as an eight-column grid of compact posters. The header and
// the panel are the list's header, so moving down into the picks scrolls the
// controls away and the grid gets the whole screen.
//
// Remote order: field → Find (right); down to What → Era (right along one row);
// down to Length; down to the picks' "Try again", then into the grid. UP from
// the grid's top row lands on Try again (or Find when there is no answer yet).
//
// The last answer lives at module scope: opening a result and coming Back
// paints it straight back instead of spending another ten seconds (and real
// money) on the same question.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, TextInput, FlatList, StyleSheet, TVFocusGuideView} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Card, {COMPACT_W, COMPACT_H} from '../components/Card';
import Chip from '../components/Chip';
import Btn from '../components/Btn';
import Focusable from '../components/Focusable';
import Icon, {IconName} from '../components/Icon';
import MiniSpinner from '../components/MiniSpinner';
import Skeleton from '../components/Skeleton';
import NavRail from '../components/NavRail';
import {api, HeroItem} from '../api';
import {canNavigate} from '../navLock';
import {useRouteShown} from '../useRouteShown';
import {warmItem} from '../prefetch';
import {noteFocus, railOpen, requestRailOpen, useFocusFallback, useTVKeys, pressMovedFocus} from '../focus';
import {showToast} from '../toast';
import {registerProfileCache} from '../profileScope';
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

// What the page says when the server has no recommender key — the notice
// above the controls, and the toast a press on Find gets instead of nothing.
const OFF_TEXT = 'The recommender isn’t set up on this server. The admin adds a key under Admin → Server to switch it on.';

// The grid's gutter, both ways.
const GAP = spacing.md;
// The no-key notice: the site's amber, as text and a tinted box.
const AMBER = '#fbbf24';
// "On this server": the timeline's mint (Card's progress ramp).
const MINT = '#8cffbe';

type PickItem = HeroItem & {why?: string};
type Answer = {vibe: string; kind: 'movie' | 'show'; era: string; length: string; items: PickItem[]; status: string};
// The last answer, so coming back to the tab shows it again — THIS PROFILE'S
// last answer: it is dropped when the profile is left (profileScope.ts). It
// used to live for the whole run with no owner, so the next person — a kids
// profile included — opened the tab on the previous person's picks (audit X8).
let last: Answer | null = null;
registerProfileCache('Pick', () => {
  last = null;
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

export default function Pick({navigation}: NativeStackScreenProps<RootStackParamList, 'Pick'>) {
  const {width, safeBottom} = useTvMetrics();
  // How many compact posters fit the content box: 8 on a 960dp canvas.
  const cols = Math.max(
    4,
    Math.floor((width - spacing.contentLeft - spacing.pageX + GAP) / (COMPACT_W + GAP)),
  );
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // usage stats: this screen's content is on (routeTiming.ts)
  useRouteShown(enabled !== null);
  const [vibe, setVibe] = useState(last?.vibe || '');
  const [kind, setKind] = useState<'movie' | 'show'>(last?.kind || 'movie');
  const [era, setEra] = useState(last?.era || 'any');
  const [length, setLength] = useState(last?.length || 'any');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [items, setItems] = useState<PickItem[]>(last?.items || []);
  const [status, setStatus] = useState(last?.status || '');
  // What the last ask came to when it was not a list: 'empty' or the server's
  // own message. Nothing while there is no answer at all.
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState('');
  // Has anything been asked on this visit (or restored)? Decides whether the
  // picks' header (and its Try again) is drawn.
  const [asked, setAsked] = useState(!!last);
  // Once picks are up and the viewer is among them, the dials fold to one
  // summary line so the grid has the screen (elia, 2026-10-09). Moving back up
  // onto that line unfolds them and puts focus on the search bar; moving down
  // into the picks folds them again.
  const [collapsed, setCollapsed] = useState(false);
  const hasPicks = useRef(false);
  // While the panel unfolds, the summary line stays mounted (invisible) until
  // Find has taken the focus. Unmounting a focused view makes Android hand
  // its focus to the nearest one — the first pick — whose focus folded the
  // panel straight back (seen on the Mi TV, 2026-10-09).
  const [handoff, setHandoff] = useState(false);
  const unfold = useCallback(() => {
    setCollapsed(false);
    setHandoff(true);
    const back = () => goBtn.current?.requestTVFocus?.();
    setTimeout(back, 0);
    setTimeout(back, 150);
    setTimeout(() => setHandoff(false), 400);
  }, []);
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const inputFallback = useRef({requestTVFocus: () => inputRef.current?.focus()});
  useFocusFallback(inputFallback);
  // Registered after the field, so it wins: a focused card or Try again that
  // unmounts lands on Find rather than summoning the keyboard.
  const goBtn = useRef<{requestTVFocus?: () => void}>(null);
  useFocusFallback(goBtn as never);
  const againBtn = useRef<{requestTVFocus?: () => void}>(null);
  // The first pill of the What row ("Movies"): where LEFT from Find goes when
  // the mood field is switched off (no recommender) — see the key handler.
  const firstKind = useRef<{requestTVFocus?: () => void}>(null);
  const findFocused = useRef(false);
  const offRef = useRef(false);

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

  const ask = useCallback(
    // `fresh`: Try again — the server skips its cached answer for this exact question
    async (override?: string, fresh = false) => {
      if (enabled === false) {
        showToast(OFF_TEXT, '⚠️');
        return;
      }
      const q = (override ?? vibe).trim();
      if (q.length < 3) {
        inputRef.current?.focus();
        return;
      }
      if (busy) return;
      if (override != null) setVibe(override);
      setAsked(true);
      setBusy(true);
      setStatus('');
      setEmpty(false);
      setError('');
      setItems([]);
      try {
        const mix = KINDS.find(k => k.id === kind)!.mix;
        const res = await api.aiRecommend(q, mix, era, length, fresh);
        const got = (res.items || []) as PickItem[];
        if (!got.length) {
          setEmpty(true);
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
        // The picks have the screen now: the dials fold to their one line and
        // focus moves to the picks' header, one press above the first pick.
        // (Find itself is about to unmount, so it cannot keep the focus.)
        setCollapsed(true);
        const toPicks = () => againBtn.current?.requestTVFocus?.();
        setTimeout(toPicks, 0);
        setTimeout(toPicks, 150);
      } catch (e) {
        setError((e as Error)?.message || 'The recommender didn’t answer.');
      } finally {
        setBusy(false);
      }
    },
    [vibe, kind, era, length, busy, enabled],
  );

  const openDetail = useCallback(
    (item: HeroItem) => {
      if (!canNavigate(navigation)) return;
      navigation.push('Detail', {item});
    },
    [navigation],
  );
  const renderCard = useCallback(
    ({item, index}: {item: PickItem; index: number}) => {
      const onServer = item.source === 'downloaded' || !!item.inLibrary;
      return (
        <View style={styles.pick}>
          <Card compact item={item} index={index} onPress={openDetail} onFocus={onCardFocus} edgeLeft={index % cols === 0} />
          <Text style={styles.pickTitle} numberOfLines={1} ellipsizeMode="tail">
            {item.title}
          </Text>
          {/* The year, behind a glyph that says where it plays from: a mint
              tick for a copy on this server, a dim play mark for a stream (the
              legend sits in the picks' header — a word does not fit 88dp). */}
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
        </View>
      );
    },
    [openDetail, cols, onCardFocus],
  );

  const lengths = LENGTHS[kind];
  const example = EXAMPLES[Math.abs(vibe.length) % EXAMPLES.length];
  hasPicks.current = asked && !busy && items.length > 0;
  const folded = collapsed && hasPicks.current;
  const summary = [
    KINDS.find(k => k.id === kind)?.label || '',
    ERAS.find(e => e.id === era)?.label || '',
    lengths.find(l => l.id === length)?.label || '',
  ].filter(Boolean);
  const off = enabled === false;
  offRef.current = off;

  // ---- the page above the grid: header, notice, controls, picks header ----
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

      {off ? (
        <View style={styles.notice}>
          <Icon name="warning" size={20} color={AMBER} />
          <Text style={styles.noticeText}>{OFF_TEXT}</Text>
        </View>
      ) : null}

      {folded || handoff ? (
        /* The dials, folded to one line while the picks have the screen.
           Focusing it (UP from the picks' header) unfolds the panel and
           hands focus to the search bar. */
        <Focusable
          round
          style={[styles.summary, handoff && styles.summaryGhost]}
          onFocusChange={f => f && !handoff && unfold()}
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
            <Btn
              ref={goBtn as never}
              primary
              icon="sparkle"
              label={busy ? 'Thinking…' : 'Find me something'}
              hasTVPreferredFocus
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
              <Chip
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
              <Chip key={e.id} small label={e.label} on={era === e.id} onPress={() => setEra(e.id)} />
            ))}
          </Group>
        </View>
        <View style={[styles.dialRow, styles.dialRowNext]}>
          <Group icon="clock" label="LENGTH">
            {lengths.map((l, i) => (
              <Chip key={l.id} small label={l.label} on={length === l.id} edgeLeft={i === 0} onPress={() => setLength(l.id)} />
            ))}
          </Group>
        </View>
      </View>
      ) : null}

      {/* The picks' own header: what came back, and a way to ask again. Drawn
          from the first ask on, and kept mounted while a new answer is on its
          way, so the Try again you pressed keeps focus. */}
      {asked ? (
        <View style={styles.picksHead}>
          <Icon name="sparkle" size={16} color={colors.accent} />
          <Text style={styles.picksTitle}>{busy ? 'Thinking…' : items.length ? 'Picked for you' : 'No picks'}</Text>
          <Text style={styles.picksStatus} numberOfLines={1} ellipsizeMode="tail">
            {busy ? STAGES[stage] : status}
          </Text>
          {items.length > 0 && !busy ? (
            <View style={styles.legend}>
              <Icon name="check" size={13} color={MINT} />
              <Text style={styles.legendText}>on this server</Text>
              <Icon name="play" size={13} color={colors.textFaint} />
              <Text style={styles.legendText}>streams</Text>
            </View>
          ) : null}
          <Btn
            ref={againBtn as never}
            small
            icon="refresh"
            label="Try again"
            dim={busy}
            onFocusChange={f => {
              if (f) inGrid.current = false; // UP from here is the summary's, not the grid escape's
            }}
            onPress={() => ask(undefined, true)}
          />
        </View>
      ) : null}
    </View>
  );

  // ---- what sits where the grid goes when there is no grid ----
  let body: React.ReactNode = null;
  if (busy) {
    // A calm placeholder in the grid's own shape, so the answer lands into it.
    body = (
      <View>
        <View style={styles.waitRow}>
          <MiniSpinner />
          <Text style={styles.waitText}>Asking for actual opinions, not running a database query — give it a few seconds.</Text>
        </View>
        <View style={styles.skelRow}>
          {Array.from({length: cols}, (_, i) => (
            <View key={i} style={styles.pick}>
              <Skeleton width={COMPACT_W} height={COMPACT_H} />
              <View style={styles.skelLine} />
              <View style={[styles.skelLine, styles.skelLineShort]} />
            </View>
          ))}
        </View>
      </View>
    );
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
          <Chip key={ex} small bare label={ex} edgeLeft={i === 0} onPress={() => ask(ex)} />
        ))}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <NavRail active="ai" />
      <View style={styles.body}>
        <FlatList
          data={items}
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

  // ---- the picks' header ----
  picksHead: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 16},
  picksTitle: {color: colors.text, fontSize: 16, fontWeight: '800'},
  picksStatus: {flex: 1, color: colors.textDim, fontSize: 14, marginLeft: 4},

  // ---- the grid ----
  rowGap: {gap: GAP, marginBottom: 18},
  pick: {width: COMPACT_W},
  pickTitle: {color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: '700', marginTop: 7},
  pickMeta: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1},
  pickYear: {color: colors.textDim, fontSize: 13, lineHeight: 17},
  pickYearOn: {color: MINT},
  legend: {flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: 6},
  legendText: {color: colors.textFaint, fontSize: 13, marginRight: 6},
  why: {color: colors.textDim, fontSize: 13, lineHeight: 17, marginTop: 4},

  // ---- states ----
  waitRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14},
  waitText: {flex: 1, color: colors.textFaint, fontSize: 14},
  skelRow: {flexDirection: 'row', gap: GAP},
  skelLine: {height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.06)', marginTop: 9},
  skelLineShort: {width: '60%', marginTop: 6},
  state: {alignItems: 'center', paddingVertical: 36, gap: 8},
  stateTitle: {color: colors.text, fontSize: 16, fontWeight: '700', textAlign: 'center'},
  stateError: {color: '#ff7a7a', fontSize: 16, fontWeight: '700', textAlign: 'center'},
  stateHint: {color: colors.textDim, fontSize: 14, textAlign: 'center'},
  tryRow: {flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 14},
  tryLabel: {color: colors.textFaint, fontSize: 14, fontWeight: '700', marginRight: 4},
});
