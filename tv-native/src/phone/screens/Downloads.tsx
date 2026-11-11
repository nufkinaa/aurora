// Downloads on the phone — two lists, the website's two pages in one:
//
//   On this device  the website's place (offline/Place.tsx, docs/offline-look.md): what is
//                   being saved here (Pause / Resume / Cancel / Retry), what this device waits
//                   for that the server does not have yet (a wish: Cancel / Dismiss), the copies
//                   saved here (play them with no server at all; Remove with Undo), and the
//                   "Keep the next episode ready" switch
//   My downloads    what you asked the SERVER to fetch — ready to play, on its
//                   way, waiting on an admin, didn't make it — then what the
//                   rest of the house has moving. Live over the socket. A row on
//                   its way offers "This device too" (saved here by itself when it
//                   lands); a ready one "Save to this device".
//
// A server row's actions are the TV's and the site's (downloadsLogic.ts); its
// words are shared with the TV page (downloadsWords.ts).
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Image, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useIsFocused, useRoute} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {api, ApiError, HeroItem, MyDownload} from '../../api';
import {useApp} from '../../AppContext';
import {canNavigate} from '../../navLock';
import {isOpen, onMessage} from '../../realtime';
import {showToast} from '../../toast';
import {openActions, openReplace} from '../../overlay';
import {cancelQuestion, countLine, DownloadAction, downloadActions, downloadCounts, isReady, rowStatus, startedBy} from '../../downloadsLogic';
import {ACTIVE, fmtBytes, statusLine} from '../../downloadsWords';
import {pushPhone, usePNav} from '../nav';
import {BackBar, useColumn, useSolidBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import Tap from '../ui/Tap';
import Icon from '../ui/Icon';
import {artSrc, Bar} from '../ui/Cards';
import {offlineAvailable, saveOffline, useOffline, useOfflineUsage} from '../offline/store';
import {markOf, MOVING_STATES, PLACE} from '../offline/rules';
import {chooseQuality} from '../offline/choose';
import {useWishes} from '../offline/wishes';
import {toggleWish} from '../offline/wishAsk';
import {wishFor, wishOn} from '../offline/wishRules';
import {useNoConnection} from '../offline/reach';
import Mark from '../offline/Mark';
import {EmptyPlace, JobRow, NoServerLine, RoomBlock, s as place, SavedTitles, SmartNextFoot, useLanded, WishRow} from '../offline/Place';
import {colors, GUTTER, radius} from '../theme';

const LABEL: Record<DownloadAction, string> = {play: 'Play', title: 'Title page', retry: 'Try again', another: 'Pick another version', remove: 'Remove from this list', confirmCancel: 'Cancel'};

function Row({pic, title, line, sub, pct, right, below, onPress, onLongPress, tone}: {pic?: string | null; title: string; line: string; sub?: string | null; pct?: number | null; right?: React.ReactNode; below?: React.ReactNode; onPress?: () => void; onLongPress?: () => void; tone?: 'ok' | 'warn' | 'live'}) {
  const src = pic ? artSrc(pic, 60).src : null;
  return (
    <Tap uiId="downloads.row" flat onPress={onPress} onLongPress={onLongPress} disabled={!onPress && !onLongPress} style={s.row} accessibilityRole="button" accessibilityLabel={`${title}, ${line}`}>
      <View style={s.pic}>{src ? <Image source={src} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <Icon name="film" size={22} color={colors.textFaint} />}</View>
      <View style={{flex: 1}}>
        <Text style={s.title} numberOfLines={2}>
          {title}
        </Text>
        <Text style={[s.line, tone === 'ok' && {color: colors.owned}, tone === 'warn' && {color: '#ffcf8a'}]} numberOfLines={2}>
          {line}
        </Text>
        {sub ? <Text style={s.sub}>{sub}</Text> : null}
        {pct != null ? <Bar f={pct} bead={false} style={{marginTop: 8}} /> : null}
        {below}
      </View>
      {right}
    </Tap>
  );
}

export default function Downloads() {
  const bar = useSolidBar();
  // More → "My downloads" opens the page at its second list (`section: 'server'`);
  // "Saved on this phone" at the top, where the phone's copies are
  const section = (useRoute().params as {section?: 'server'} | undefined)?.section;
  const scroller = useRef<ScrollView>(null);
  const jumped = useRef(false);
  const onServerHead = (y: number) => {
    if (section !== 'server' || jumped.current) return;
    jumped.current = true;
    requestAnimationFrame(() => scroller.current?.scrollTo({y: Math.max(0, y - 64), animated: false}));
  };
  const column = useColumn();
  const navigation = usePNav();
  const live = useIsFocused();
  const {profileId} = useApp();
  const insets = useSafeAreaInsets();
  const bottom = useTabBarSpace();
  const phone = useOffline();
  const usage = useOfflineUsage();
  const wishes = useWishes();
  const noLink = useNoConnection();
  const landed = useLanded();
  const [jobs, setJobs] = useState<Map<string, MyDownload> | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    () =>
      api
        .myDownloads(profileId)
        .then(list => {
          setError('');
          setJobs(new Map(list.map(j => [j.id, j])));
        })
        .catch(() => setJobs(prev => (prev || (setError("Couldn't load your downloads. The server didn't answer."), null)))),
    [profileId],
  );
  useEffect(() => {
    if (live) load();
  }, [live, load]);
  useEffect(() => {
    if (!live) return;
    const a = onMessage('download_update', d => {
      const job = d.job as MyDownload | undefined;
      if (job) setJobs(prev => new Map(prev || []).set(job.id, job));
    });
    const b = onMessage('download_removed', d =>
      setJobs(prev => {
        if (!prev || !prev.has(String(d.id))) return prev;
        const n = new Map(prev);
        n.delete(String(d.id));
        return n;
      }),
    );
    const c = onMessage('welcome', load);
    const iv = setInterval(() => !isOpen() && load(), 15000);
    return () => {
      a();
      b();
      c();
      clearInterval(iv);
    };
  }, [live, load]);

  const {mine, others} = useMemo(() => {
    const all = [...(jobs?.values() || [])].sort((x, y) => Date.parse(y.at || '') - Date.parse(x.at || ''));
    return {mine: all.filter(j => j.mine), others: all.filter(j => !j.mine && ['approved', 'downloading', 'pending'].includes(j.status))};
  }, [jobs]);

  // ---- a server row's actions ----
  const play = (j: MyDownload) => {
    if (!j.libraryId || !canNavigate(navigation as never)) return;
    if (!j.seenAt) api.downloadSeen(j.id, profileId).catch(() => {});
    navigation.push('Player', {id: j.libraryId, title: j.label || j.title || 'Download'});
  };
  const cancel = async (j: MyDownload) => {
    try {
      await api.downloadCancel(j.id, profileId);
      showToast(`Cancelled “${j.label || j.title}”`, '🗑');
    } catch (e) {
      showToast((e as Error).message || "Couldn't cancel", '⚠️');
    }
  };
  const remove = async (j: MyDownload) => {
    const gone = () => setJobs(prev => (prev && prev.has(j.id) ? (n => (n.delete(j.id), n))(new Map(prev)) : prev));
    try {
      await api.downloadDismiss(j.id, profileId);
      gone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        try {
          await api.downloadCancel(j.id, profileId);
          await api.downloadDismiss(j.id, profileId);
          gone();
          return;
        } catch {}
      }
      showToast((e as Error).message || "Couldn't remove it", '⚠️');
    }
  };
  const retry = async (j: MyDownload) => {
    try {
      const res = await api.requestDownload({infoHash: j.infoHash, fileIdx: j.fileIdx, type: j.type, imdbId: j.imdbId, title: j.title, label: j.label, poster: j.poster, quality: j.quality, sizeBytes: j.sizeBytes || 0, season: j.season || null, episode: j.episode || null, provider: j.provider || null, release: j.release || null, profile: profileId});
      if (res.error) throw new Error(res.error);
      showToast(res.alreadyAvailable ? "Already yours — it's in the library" : res.duplicate ? 'That one is already on its way' : `Trying “${j.label || j.title}” again`, '⬇');
      api.downloadDismiss(j.id, profileId).catch(() => {});
      load();
    } catch (e) {
      showToast((e as Error).message || "Couldn't start it again", '⚠️');
    }
  };
  const openTitle = (j: MyDownload) => {
    if (!j.imdbId || !canNavigate(navigation as never)) return;
    const item: HeroItem = {id: j.imdbId, imdbId: j.imdbId, type: j.type === 'show' ? 'show' : 'movie', title: j.title || j.label || '', poster: j.poster || null, source: 'stream'};
    navigation.push('Detail', {item});
  };
  const run = (a: DownloadAction, j: MyDownload) => {
    if (a === 'play') return play(j);
    if (a === 'title') return openTitle(j);
    if (a === 'retry') return retry(j);
    if (a === 'remove') return remove(j);
    if (a === 'another') {
      if (j.replaces) openReplace({libraryId: j.replaces.libraryId, title: j.title || j.label || '', context: {title: j.title || j.label || '', itemId: j.replaces.libraryId}});
      return;
    }
    const q = cancelQuestion(j);
    openActions({
      title: q.title,
      body: q.body,
      items: [
        {label: q.keep, onPress: () => {}},
        {label: q.yes, danger: true, onPress: () => cancel(j)},
      ],
    });
  };
  const menu = (j: MyDownload, list: DownloadAction[]) =>
    openActions({title: j.label || j.title || 'Download', sub: statusLine(j), items: list.map(a => ({label: LABEL[a], danger: a === 'remove' || a === 'confirmCancel', onPress: () => run(a, j)}))});
  const serverRow = (j: MyDownload, own: boolean) => {
    const acts = downloadActions(j, own);
    const pct = j.status === 'downloading' ? j.progress || 0 : null;
    return (
      <Row
        key={j.id}
        pic={j.poster}
        title={j.label || j.title || 'Download'}
        line={rowStatus({who: startedBy(j, own), kind: null, status: statusLine(j), size: j.sizeBytes ? fmtBytes(j.sizeBytes) : null})}
        pct={pct}
        tone={isReady(j) ? 'ok' : ['error', 'declined', 'canceled'].includes(j.status) ? 'warn' : ACTIVE.includes(j.status) ? 'live' : undefined}
        onPress={acts.press ? () => (acts.press === 'menu' ? menu(j, acts.all) : run(acts.press as DownloadAction, j)) : undefined}
        onLongPress={acts.all.length ? () => menu(j, acts.all) : undefined}
        right={acts.label ? <Text style={s.act}>{acts.label.replace('▶  ', '')}</Text> : null}
        below={own ? deviceButton(j) : null}
      />
    );
  };

  // ---- onto THIS device (the website's My downloads buttons) ----
  // On its way: "This device too" — saved here by itself once it lands (a wish). Ready:
  // "Save to this device" — the same save as the title page's.
  const wishTarget = (j: MyDownload) => ({
    type: j.type === 'show' ? ('show' as const) : ('movie' as const),
    imdbId: j.imdbId || '',
    jobId: j.id,
    season: j.type === 'show' ? j.season ?? null : null,
    episode: j.type === 'show' ? j.episode ?? null : null,
    title: j.label || j.title || null,
    showTitle: j.type === 'show' ? j.title || null : null,
    poster: j.poster || null,
  });
  const deviceButton = (j: MyDownload) => {
    if (!offlineAvailable() || !j.mine) return null;
    const live = ['pending', 'approved', 'downloading'].includes(j.status);
    if (live && j.imdbId) {
      const t = wishTarget(j);
      const on = wishOn(wishFor(wishes, t));
      return (
        <Tap uiId="downloads.offline.wish" onPress={() => toggleWish(t, j.label || j.title || '')} style={[s.dev, on && s.devOn]} accessibilityRole="button" accessibilityState={{selected: on}} accessibilityLabel={on ? 'It will be saved on this device when it arrives — press to stop that' : 'Save it on this device as soon as it arrives'}>
          <Mark state={on ? 'waiting' : 'none'} size={18} />
          <Text style={s.devText}>{on ? 'Will be saved here' : 'This device too'}</Text>
        </Tap>
      );
    }
    if (isReady(j) && j.libraryId) {
      const c = phone.find(x => x.id === j.libraryId);
      const here = c?.state === 'done';
      return (
        <Tap
          uiId="downloads.offline.save"
          onPress={async () => {
            if (c && (here || MOVING_STATES.includes(c.state))) return;
            try {
              const item = await api.item(j.libraryId!, profileId);
              await saveOffline(
                {id: item.id, title: item.title, showId: item.showId || null, showTitle: item.showTitle || null, season: item.season ?? null, episode: item.episode ?? null, year: item.year ?? null, cover: item.cover || item.poster || j.poster || null, duration: item.duration, subtitles: (item.subtitles || []).filter(t => !!t.url).map(t => ({label: t.label, lang: t.lang, url: t.url as string})), originalLanguage: item.originalLanguage || null},
                chooseQuality(j.label || j.title || item.title),
              );
            } catch (e) {
              showToast(`Didn't save — ${(e as Error)?.message || 'try again'}`, '⚠️');
            }
          }}
          style={[s.dev, here && s.devOn]}
          accessibilityRole="button"
          accessibilityLabel={here ? 'Saved on this device' : 'Save to this device'}>
          <Mark state={markOf(c)} pct={c?.pct || 0} size={18} />
          <Text style={s.devText}>{here ? 'On this device' : c && MOVING_STATES.includes(c.state) ? 'Saving…' : 'Save to this device'}</Text>
        </Tap>
      );
    }
    return null;
  };

  // this device: saves on their way (and the ones that need you), what it waits for, what is here
  const jobsHere = phone.filter(c => MOVING_STATES.includes(c.state) || c.state === 'failed').sort((a, b) => a.at - b.at);
  // (a ready wish whose copy is already on its way here shows as that save's row instead)
  const waitingWishes = wishes.filter(w => !(w.state === 'ready' && w.libraryId && phone.some(c => c.id === w.libraryId)));
  const savedHere = phone.filter(c => c.state === 'done');
  const ready = mine.filter(isReady).sort((a, b) => (a.seenAt ? 1 : 0) - (b.seenAt ? 1 : 0));
  const moving = mine.filter(j => ACTIVE.includes(j.status) || (j.status === 'done' && !isReady(j)));
  const waiting = mine.filter(j => j.status === 'pending');
  const failed = mine.filter(j => ['error', 'declined', 'canceled'].includes(j.status));
  return (
    <View style={s.root}>
      <ScrollView
        ref={scroller}
        onScroll={bar.onScroll}
        scrollEventThrottle={32}
        contentContainerStyle={[{paddingTop: insets.top + 70, paddingBottom: bottom + 24}, column]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            tintColor={colors.text}
            colors={[colors.accentStrong]}
            progressBackgroundColor="#1b1d36"
          />
        }>
        <Text style={s.h1}>Downloads</Text>
        <View style={s.placeHead}>
          <Icon name="downloadDevice" size={22} color={colors.text} />
          <Text style={[s.h2, {marginTop: 0, paddingHorizontal: 0}]}>{PLACE}</Text>
        </View>
        <Text style={s.hint}>Plays right here — even with no connection</Text>
        {noLink ? <NoServerLine onRetry={load} /> : null}
        {jobsHere.length ? <Text style={place.h3}>Saving now</Text> : null}
        {jobsHere.map(c => (
          <JobRow key={`j-${c.id}`} c={c} />
        ))}
        {waitingWishes.length ? <Text style={place.h3}>Waiting for the server's copy</Text> : null}
        {waitingWishes.map(w => (
          <WishRow key={`w-${w.id}`} w={w} />
        ))}
        {savedHere.length ? (
          <>
            <Text style={place.h3}>{`Saved for offline · ${savedHere.length}`}</Text>
            <RoomBlock copies={phone} free={usage.free} profileId={profileId} />
            <SavedTitles copies={savedHere} onPlay={c => pushPhone('OfflinePlayer', {id: c.id})} landed={landed} />
          </>
        ) : (
          <EmptyPlace free={usage.free} moving={jobsHere.length > 0 || waitingWishes.length > 0} />
        )}
        <SmartNextFoot copies={phone} />

        <Text style={s.h2} onLayout={e => onServerHead(e.nativeEvent.layout.y)}>
          My downloads
        </Text>
        {mine.length ? <Text style={s.summary}>{countLine(downloadCounts(mine))}</Text> : null}
        <Text style={s.hint}>What you asked the server to fetch. Tap one on its way to cancel it (it asks first); hold a row for everything you can do.</Text>
        {error ? <Text style={s.err}>{error}</Text> : null}
        {jobs && !mine.length ? <Text style={s.empty}>Nothing yet. Tap Save next to any source on a title's page and it lands here.</Text> : null}
        {moving.length ? <Text style={s.h3}>On its way</Text> : null}
        {moving.map(j => serverRow(j, true))}
        {waiting.length ? <Text style={s.h3}>Waiting for approval</Text> : null}
        {waiting.map(j => serverRow(j, true))}
        {ready.length ? <Text style={s.h3}>Ready to play</Text> : null}
        {ready.map(j => serverRow(j, true))}
        {failed.length ? <Text style={s.h3}>Didn't make it</Text> : null}
        {failed.map(j => serverRow(j, true))}
        {others.length ? <Text style={s.h2}>Downloading for the rest of the house</Text> : null}
        {others.map(j => serverRow(j, false))}
      </ScrollView>
      <BackBar solid={bar.solid} title={bar.solid ? 'Downloads' : undefined} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  h1: {color: colors.text, fontSize: 32, fontWeight: '900', paddingHorizontal: GUTTER},
  h2: {color: colors.text, fontSize: 20, fontWeight: '800', paddingHorizontal: GUTTER, marginTop: 22},
  h3: {color: colors.textDim, fontSize: 13, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: GUTTER, marginTop: 14, marginBottom: 6},
  summary: {color: colors.text, fontSize: 15, fontWeight: '800', paddingHorizontal: GUTTER, marginTop: 4},
  hint: {color: colors.textDim, fontSize: 14, paddingHorizontal: GUTTER, marginTop: 4, marginBottom: 10},
  empty: {color: colors.textDim, fontSize: 15, paddingHorizontal: GUTTER, paddingVertical: 12},
  err: {color: '#ffb3b3', fontSize: 15, paddingHorizontal: GUTTER},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: GUTTER, marginBottom: 8, padding: 10, borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge},
  pic: {width: 52, height: 78, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center'},
  title: {color: colors.text, fontSize: 15, fontWeight: '800'},
  line: {color: colors.textDim, fontSize: 13, marginTop: 3},
  sub: {color: colors.textFaint, fontSize: 12, marginTop: 2},
  act: {color: colors.accent, fontSize: 14, fontWeight: '800'},
  placeHead: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: GUTTER, marginTop: 22},
  // the device button on a server row (My downloads): the mark and its words
  dev: {flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 8, minHeight: 44, marginTop: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.glassEdge},
  devOn: {backgroundColor: 'rgba(110,231,183,0.12)', borderColor: 'rgba(110,231,183,0.45)'},
  devText: {color: colors.text, fontSize: 14, fontWeight: '800'},
});
