// "Choose episodes" on the phone — the website's sheet (public/js/offlineChoose.js), drawn
// natively, the same words (rules: chooseRules.ts). A show's episodes, a season at a time:
// a tick box each, its number, name, length and the size it will take; saved ones wear the
// mint mark and can't be ticked; ones on their way show their percent; ones the server does not
// have yet say "saves here when it arrives" (a wish). The next unwatched ones come ticked.
// Select all / Clear, the size once for all, the running total and the room, one Save.
import React, {useEffect, useMemo, useState} from 'react';
import {NativeModules, StyleSheet, Text, View} from 'react-native';
import Sheet from '../ui/Sheet';
import Tap from '../ui/Tap';
import {colors, GUTTER, radius} from '../theme';
import {api} from '../../api';
import {showToast} from '../../toast';
import Mark, {AMBER, INK, MINT, RED} from './Mark';
import {fmtSize} from './rules';
import {CHOOSE_SIZES, ChooseEp, ChooseRow, firstSize, preTicked, rowWhat, saveWords, sizeAt, standing, tickable, totalLine, typicalSecs} from './chooseRules';
import {offlinePrefs, saveOffline, useOffline} from './store';
import {addWish, useWishes} from './wishes';
import {wishFor} from './wishRules';

export type ChooseShow = {
  title: string;
  showId?: string | null;
  imdbId?: string | null;
  poster?: string | null;
  seasons: {number: number; episodes: ChooseEp[]}[];
  /** the next episode to watch: its season opens, it is ticked first */
  from?: {season: number; episode: number} | null;
  /** an episode finished already (not ticked by default) */
  finished?: (libId: string) => boolean;
};

let current: ChooseShow | null = null;
let lastSize: string | null = null;
const subs = new Set<() => void>();
const emit = () => {
  for (const fn of [...subs]) fn();
};
/** Open the sheet for a show. */
export const openChooser = (show: ChooseShow) => {
  current = show;
  emit();
};
const close = () => {
  current = null;
  emit();
};
const N = (NativeModules as {AuroraOffline?: {space(): Promise<{free: number}>}}).AuroraOffline;

// What Save does: the ones on the server saved one after another at the size chosen (each
// fetched first: its subtitles, its running time); the others become wishes at that size.
async function run(show: ChooseShow, picked: ChooseRow[], quality: string) {
  const later = picked.filter(r => r.st === 'later');
  const now = picked.filter(r => r.st === 'ready' && r.libId);
  const of = ` of “${show.title}”`;
  let wished = 0;
  for (const r of later) {
    if (!show.imdbId) break;
    try {
      await addWish({type: 'show', imdbId: show.imdbId, season: r.season, episode: r.episode, title: r.title, showTitle: show.title, poster: show.poster || null}, quality);
      wished++;
    } catch {}
  }
  if (wished) showToast(`${wished} episode${wished === 1 ? '' : 's'}${of} will be saved to this device when ${wished === 1 ? 'it arrives' : 'they arrive'}`, '📱');
  if (!now.length) return;
  showToast(`Saving ${now.length} episode${now.length === 1 ? '' : 's'}${of} to this device`, '📱');
  for (const r of now) {
    try {
      const it = await api.item(r.libId!);
      await saveOffline(
        {
          id: it.id,
          title: it.title || r.title,
          showId: show.showId || it.showId || null,
          showTitle: show.title,
          season: r.season,
          episode: r.episode,
          year: it.year ?? null,
          cover: show.poster || it.cover || it.poster || null,
          duration: it.duration || r.duration,
          subtitles: (it.subtitles || []).filter(t => !!t.url).map(t => ({label: t.label, lang: t.lang, url: t.url as string})),
          originalLanguage: it.originalLanguage || null,
        },
        async () => null,
        {quality, quiet: true},
      );
    } catch {}
  }
}

export default function ChooseSheet() {
  const [, setN] = useState(0);
  useEffect(() => {
    const fn = () => setN(n => n + 1);
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  }, []);
  const show = current;
  const copies = useOffline();
  const wishes = useWishes();
  const [season, setSeason] = useState(0);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [quality, setQuality] = useState('720');
  const [free, setFree] = useState(0);

  const seasons = useMemo(() => (show?.seasons || []).filter(s => s.number > 0 && s.episodes.length), [show]);
  const typical = useMemo(() => typicalSecs(seasons.flatMap(s => s.episodes)), [seasons]);
  const rows: ChooseRow[] = useMemo(
    () =>
      seasons.flatMap(s =>
        s.episodes.map(e => {
          const c = e.libId ? copies.find(x => x.id === e.libId) : null;
          const w = !e.libId && show?.imdbId ? wishFor(wishes, {type: 'show', imdbId: show.imdbId, season: e.season, episode: e.episode}) : null;
          const job = !!c && c.state !== 'done' && c.state !== 'failed';
          return {
            ...e,
            key: `${e.season}x${e.episode}`,
            st: standing({here: c?.state === 'done', job, wish: !!w && w.state !== 'failed', onServer: !!e.libId}),
            pct: c?.pct || 0,
            paused: c?.state === 'paused',
          };
        }),
      ),
    [seasons, copies, wishes, show],
  );
  // a new show: its season, its ticks, the size to start on, the room
  useEffect(() => {
    if (!show) return;
    const first = show.from ? rows.find(r => r.season === show.from!.season && r.episode === show.from!.episode) : null;
    const fin = (r: ChooseRow) => !!(r.libId && show.finished && show.finished(r.libId));
    const s0 = first ? first.season : (rows.find(r => tickable(r.st) && !fin(r)) || rows[0])?.season || seasons[0]?.number || 1;
    setSeason(s0);
    setTicked(new Set(preTicked(rows, {from: first || rows.find(r => r.season === s0) || null, finished: fin})));
    setQuality(firstSize(offlinePrefs().quality, lastSize));
    N?.space()
      .then(sp => setFree(sp.free || 0))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  if (!show) return <Sheet visible={false} onClose={close} />;
  const inSeason = rows.filter(r => r.season === season);
  const picked = rows.filter(r => ticked.has(r.key) && tickable(r.st));
  const bytes = picked.reduce((n, r) => n + sizeAt(r, quality, typical).bytes, 0);
  const toggle = (k: string) =>
    setTicked(t => {
      const n = new Set(t);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return (
    <Sheet visible onClose={close} title="Choose episodes" sub={`“${show.title}” — tick the ones to save on this device. They play with no connection.`}>
      {seasons.length > 1 ? (
        <View style={s.chips} accessibilityRole="tablist">
          {seasons.map(se => {
            const on = se.number === season;
            const n = rows.filter(r => r.season === se.number && ticked.has(r.key)).length;
            return (
              <Tap key={se.number} uiId="offline.choose.season" onPress={() => setSeason(se.number)} style={[s.chip, on && s.chipOn]} accessibilityRole="tab" accessibilityState={{selected: on}} accessibilityLabel={`Season ${se.number}${n ? `, ${n} ticked` : ''}`}>
                <Text style={s.chipText}>
                  {`Season ${se.number}`}
                  {n ? <Text style={{color: MINT}}>{` · ${n}`}</Text> : null}
                </Text>
              </Tap>
            );
          })}
        </View>
      ) : (
        <Text style={s.only}>{`Season ${season}`}</Text>
      )}
      <View style={s.tools}>
        <Tap uiId="offline.choose.all" onPress={() => setTicked(t => new Set([...t, ...inSeason.filter(r => tickable(r.st)).map(r => r.key)]))} style={s.tool} accessibilityRole="button" accessibilityLabel="Select all">
          <Text style={s.toolText}>Select all</Text>
        </Tap>
        <Tap uiId="offline.choose.clear" onPress={() => setTicked(t => new Set([...t].filter(k => !inSeason.some(r => r.key === k))))} style={s.tool} accessibilityRole="button" accessibilityLabel="Clear">
          <Text style={s.toolText}>Clear</Text>
        </Tap>
      </View>
      {inSeason.map(r => {
        const can = tickable(r.st);
        const on = can && ticked.has(r.key);
        const sz = sizeAt(r, quality, typical);
        const what = rowWhat(r);
        const len = r.duration ? `${Math.max(1, Math.round(r.duration / 60))} min` : null;
        const meta = [len, can && sz.bytes ? `${sz.estimated ? '≈ ' : ''}${fmtSize(sz.bytes)}` : null].filter(Boolean).join(' · ');
        const body = (
          <>
            {can ? (
              <View style={[s.box, on && s.boxOn]}>{on ? <Text style={s.boxTick}>✓</Text> : null}</View>
            ) : (
              <View style={s.boxSlot}>
                <Mark state={r.st === 'saved' ? 'saved' : r.st === 'wished' ? 'waiting' : r.paused ? 'paused' : 'saving'} pct={r.pct} size={20} />
              </View>
            )}
            <View style={{flex: 1}}>
              <Text style={s.name} numberOfLines={1}>
                <Text style={s.num}>{`E${r.episode} `}</Text>
                {r.title}
              </Text>
              {meta ? <Text style={s.meta}>{meta}</Text> : null}
              {what ? <Text style={[s.what, {color: r.st === 'saved' || r.st === 'saving' ? MINT : AMBER}]}>{what}</Text> : null}
            </View>
          </>
        );
        return can ? (
          <Tap key={r.key} uiId="offline.choose.pick" flat onPress={() => toggle(r.key)} style={[s.row, on && s.rowOn]} accessibilityRole="checkbox" accessibilityState={{checked: on}} accessibilityLabel={`Episode ${r.episode}, ${r.title}${what ? `, ${what}` : ''}`}>
            {body}
          </Tap>
        ) : (
          <View key={r.key} style={[s.row, {opacity: 0.86}]} accessibilityLabel={`Episode ${r.episode}, ${r.title}, ${what}`}>
            {body}
          </View>
        );
      })}
      <Text style={s.label}>Size</Text>
      <View style={s.chips} accessibilityRole="radiogroup">
        {CHOOSE_SIZES.map(z => {
          const on = z.quality === quality;
          return (
            <Tap key={z.quality} uiId="offline.choose.size" onPress={() => setQuality(z.quality)} style={[s.chip, on && s.chipOn]} accessibilityRole="radio" accessibilityState={{checked: on}} accessibilityLabel={z.label}>
              {on ? <Text style={s.chipTick}>✓</Text> : null}
              <Text style={s.chipText}>{z.label}</Text>
            </Tap>
          );
        })}
      </View>
      <Text style={s.total} accessibilityLiveRegion="polite">
        {totalLine(picked, quality, typical)}
      </Text>
      {free ? <Text style={[s.room, bytes > free && {color: RED}]}>{`Room on this device: ≈ ${fmtSize(free)}${bytes > free ? ' — not enough for all of these' : ''}`}</Text> : null}
      <View style={s.foot}>
        <Tap uiId="offline.choose.cancel" onPress={close} style={s.btn} accessibilityRole="button" accessibilityLabel="Not now">
          <Text style={s.btnText}>Not now</Text>
        </Tap>
        <Tap
          uiId="offline.choose.save"
          disabled={!picked.length}
          onPress={() => {
            lastSize = quality;
            const sh = show;
            close();
            run(sh, picked, quality);
          }}
          style={[s.btn, s.save, !picked.length && {opacity: 0.5}]}
          accessibilityRole="button"
          accessibilityLabel={saveWords(picked.length)}>
          <Text style={[s.btnText, {color: INK}]}>{saveWords(picked.length)}</Text>
        </Tap>
      </View>
    </Sheet>
  );
}

const s = StyleSheet.create({
  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: GUTTER, marginTop: 4, marginBottom: 6},
  chip: {flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 14, borderRadius: 999, backgroundColor: colors.chip, borderWidth: 1, borderColor: colors.chipEdge},
  chipOn: {backgroundColor: 'rgba(110,231,183,0.16)', borderColor: MINT, borderWidth: 1.5},
  chipText: {color: colors.text, fontSize: 14.4, fontWeight: '700'},
  chipTick: {color: MINT, fontSize: 13, fontWeight: '900'},
  only: {color: colors.textDim, fontSize: 14.4, fontWeight: '800', paddingHorizontal: GUTTER + 4, marginBottom: 4},
  tools: {flexDirection: 'row', gap: 8, paddingHorizontal: GUTTER, marginBottom: 8},
  tool: {minHeight: 44, paddingHorizontal: 16, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.glassEdge},
  toolText: {color: colors.text, fontSize: 14, fontWeight: '800'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, marginHorizontal: GUTTER, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: radius.l, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)'},
  rowOn: {backgroundColor: 'rgba(110,231,183,0.1)', borderColor: 'rgba(110,231,183,0.6)', borderWidth: 1.5},
  box: {width: 22, height: 22, borderRadius: 7, borderWidth: 1.6, borderColor: 'rgba(255,255,255,0.5)', alignItems: 'center', justifyContent: 'center'},
  boxOn: {backgroundColor: MINT, borderColor: MINT},
  boxTick: {color: INK, fontSize: 13, fontWeight: '900', lineHeight: 16},
  boxSlot: {width: 22, alignItems: 'center'},
  name: {color: colors.text, fontSize: 15, fontWeight: '700'},
  num: {color: colors.textDim, fontWeight: '800'},
  meta: {color: colors.textFaint, fontSize: 12.8, marginTop: 2},
  what: {fontSize: 12.8, fontWeight: '700', marginTop: 2},
  label: {color: colors.text, fontSize: 14.4, fontWeight: '800', paddingHorizontal: GUTTER + 4, marginTop: 10, marginBottom: 6},
  total: {color: colors.text, fontSize: 15, fontWeight: '800', paddingHorizontal: GUTTER + 4, marginTop: 8},
  room: {color: colors.textDim, fontSize: 13.5, paddingHorizontal: GUTTER + 4, marginTop: 4},
  foot: {flexDirection: 'row', justifyContent: 'space-between', gap: 10, paddingHorizontal: GUTTER, marginTop: 14},
  btn: {minHeight: 44, paddingHorizontal: 18, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.glassEdge},
  save: {backgroundColor: MINT, borderColor: MINT, flexGrow: 1},
  btnText: {color: colors.text, fontSize: 15, fontWeight: '800'},
});
