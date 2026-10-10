// My downloads — what THIS profile asked the server to fetch, yours first
// (ready to play, on its way, waiting on an admin, didn't make it), then what
// the rest of the house has moving. Live over the socket: progress ticks, a
// finish, and an admin removing a request all repaint here.
//
// WHAT A PRESS DOES (downloadsLogic.ts has the rule, the site's page
// public/js/screens/downloads.js has the same actions as buttons): a row has
// one press on a TV, so the press is the row's main action and HOLDING it
// opens the rest — Play, the title's page, Cancel, Try again, Remove. A row
// that did not make it has no single obvious action, so its press opens that
// list. "Remove" used to send `cancel` for a failed download, which left a
// "Canceled" row behind for good and gave declined and cancelled rows no
// action at all (audit X3): it clears the row now (`dismiss`), as the site's.
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Image, ScrollView, StyleSheet, Text, View} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useIsFocused} from '@react-navigation/native';
import Focusable from '../components/Focusable';
import NavRail from '../components/NavRail';
import {Empty} from '../components/States';
import {api, ApiError, artSrc, HeroItem, ImgSource, MyDownload} from '../api';
import {downloadActions, DownloadAction, heldLine, isHeld, isReady} from '../downloadsLogic';
import {openActions} from '../overlay';
import {useApp} from '../AppContext';
import {useRouteShown} from '../useRouteShown';
import {canNavigate} from '../navLock';
import {isOpen, onMessage} from '../realtime';
import {showToast} from '../toast';
import {RootStackParamList} from '../navigation';
import theme, {useTvMetrics} from '../theme';

const {colors, fontSize, spacing, radius} = theme;
const ACTIVE = ['approved', 'downloading'];

const fmtBytes = (b?: number) => {
  if (!b) return '';
  const gb = b / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
};
const when = (iso?: string | null) => {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = Date.now() - t;
  if (d < 60e3) return 'just now';
  if (d < 3600e3) return `${Math.round(d / 60e3)} min ago`;
  if (d < 86400e3) return `${Math.round(d / 3600e3)} h ago`;
  return new Date(t).toLocaleDateString();
};
const eta = (j: MyDownload) => {
  if (!j.sizeBytes || !j.downloadSpeed) return '';
  const s = Math.round((j.sizeBytes * (1 - (j.progress || 0))) / j.downloadSpeed);
  if (s < 60) return 'under a minute';
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  return `${(s / 3600).toFixed(1)} h left`;
};
const statusLine = (j: MyDownload) => {
  switch (j.status) {
    case 'done':
      return j.libraryId ? `Ready · ${when(j.doneAt)}` : 'Finished — indexing…';
    case 'downloading':
      return j.phase === 'copying'
        ? `Copying into the library · ${Math.round((j.copyProgress || 0) * 100)}%`
        : j.phase === 'finding' || j.phase === 'starting'
        ? 'Finding peers…'
        : [`${Math.round((j.progress || 0) * 100)}%`, j.downloadSpeed ? `${(j.downloadSpeed / 1e6).toFixed(1)} MB/s` : '', eta(j)]
            .filter(Boolean)
            .join(' · ');
    case 'approved':
      // a My List download that gave way to a person's own (downloadsLogic.ts)
      if (isHeld(j)) return heldLine(j);
      if (j.auto === 'mylist') return 'Queued — starts after the other downloads';
      return 'Queued — starts when a slot frees up';
    case 'pending':
      return j.holdReason ? `Waiting for approval — ${j.holdReason}` : 'Waiting for approval';
    case 'declined':
      return 'Declined by the admin';
    case 'canceled':
      return 'Canceled';
    case 'error':
      return `Failed — ${j.error || 'unknown error'}`;
    default:
      return j.status;
  }
};

export default function Downloads({navigation}: NativeStackScreenProps<RootStackParamList, 'Downloads'>) {
  const {profileId} = useApp();
  const {safeBottom} = useTvMetrics();
  const live = useIsFocused();
  const [jobs, setJobs] = useState<Map<string, MyDownload> | null>(null);
  // usage stats: this screen's content is on (routeTiming.ts)
  useRouteShown(jobs !== null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .myDownloads(profileId)
      .then(list => setJobs(new Map(list.map(j => [j.id, j]))))
      .catch(() => setError('Could not load your downloads.'));
  }, [profileId]);
  useEffect(() => {
    if (live) load();
  }, [live, load]);
  // Live: the socket says what moved; a slow poll covers a dropped socket.
  useEffect(() => {
    if (!live) return;
    const a = onMessage('download_update', d => {
      const job = d.job as MyDownload | undefined;
      if (!job) return;
      setJobs(prev => {
        const next = new Map(prev || []);
        next.set(job.id, job);
        return next;
      });
    });
    const b = onMessage('download_removed', d => {
      setJobs(prev => {
        if (!prev || !prev.has(String(d.id))) return prev;
        const next = new Map(prev);
        next.delete(String(d.id));
        return next;
      });
    });
    // the socket came back after a drop: read once what it missed
    const c = onMessage('welcome', load);
    // the slow poll is the fallback only — an open socket already says it all
    const iv = setInterval(() => {
      if (!isOpen()) load();
    }, 15000);
    return () => {
      a();
      b();
      c();
      clearInterval(iv);
    };
  }, [live, load]);

  const {mine, others} = useMemo(() => {
    const all = [...(jobs?.values() || [])].sort((x, y) => Date.parse(y.at || '') - Date.parse(x.at || ''));
    return {
      mine: all.filter(j => j.mine),
      others: all.filter(j => !j.mine && ['approved', 'downloading', 'pending'].includes(j.status)),
    };
  }, [jobs]);
  // "Ready" is something you can play. A download that has finished but is
  // not in the library yet ("Finished — indexing…") was listed there too, and
  // its press did nothing: it is still on its way.
  const ready = mine.filter(isReady).sort((a, b) => (a.seenAt ? 1 : 0) - (b.seenAt ? 1 : 0));
  const moving = mine.filter(j => ACTIVE.includes(j.status) || (j.status === 'done' && !isReady(j)));
  const waiting = mine.filter(j => j.status === 'pending');
  const failed = mine.filter(j => ['error', 'declined', 'canceled'].includes(j.status));

  const play = (j: MyDownload) => {
    if (!j.libraryId || !canNavigate(navigation)) return;
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
  // Off the page. A dead row is simply cleared; if the server says it is
  // still in progress after all (409), it is cancelled first and then cleared.
  const remove = async (j: MyDownload) => {
    const gone = () =>
      setJobs(prev => {
        if (!prev || !prev.has(j.id)) return prev;
        const next = new Map(prev);
        next.delete(j.id);
        return next;
      });
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
  // The same request again (the server allows a second attempt once the first
  // is dead; the job carries every field the request needs) — and the dead
  // row is cleared, so the page shows one row, not two.
  const retry = async (j: MyDownload) => {
    try {
      const res = await api.requestDownload({
        infoHash: j.infoHash,
        fileIdx: j.fileIdx,
        type: j.type,
        imdbId: j.imdbId,
        title: j.title,
        label: j.label,
        poster: j.poster,
        quality: j.quality,
        sizeBytes: j.sizeBytes || 0,
        season: j.season || null,
        episode: j.episode || null,
        provider: j.provider || null,
        profile: profileId,
      });
      if (res.error) throw new Error(res.error);
      if (res.alreadyAvailable) {
        showToast("Already yours — it's in the library", '✅');
      } else {
        showToast(res.duplicate ? 'That one is already on its way' : `Trying “${j.label || j.title}” again`, '⬇');
      }
      api.downloadDismiss(j.id, profileId).catch(() => {});
      load();
    } catch (e) {
      showToast((e as Error).message || "Couldn't start it again", '⚠️');
    }
  };
  // The title's own page, as the catalogue would open it (Detail finds the
  // copy on disk by itself).
  const openTitle = (j: MyDownload) => {
    if (!j.imdbId || !canNavigate(navigation)) return;
    if (isReady(j) && !j.seenAt) api.downloadSeen(j.id, profileId).catch(() => {});
    const item: HeroItem = {
      id: j.imdbId,
      imdbId: j.imdbId,
      type: j.type === 'show' ? 'show' : 'movie',
      title: j.title || j.label || '',
      poster: j.poster || null,
      source: 'stream',
    };
    navigation.push('Detail', {item});
  };
  const run = (a: DownloadAction, j: MyDownload) => {
    if (a === 'play') return play(j);
    if (a === 'title') return openTitle(j);
    if (a === 'retry') return retry(j);
    if (a === 'remove') return remove(j);
    if (a === 'cancel') return cancel(j);
    // 'confirmCancel': a download that is well under way asks first —
    // cancelling throws the bytes away (the site's rule: past 5%).
    openActions({
      title: `Cancel “${j.label || j.title}”?`,
      sub: `It's ${Math.round((j.progress || 0) * 100)}% down. Cancelling throws that away; you can always ask for it again.`,
      items: [
        {label: 'Keep going', onPress: () => {}},
        {label: 'Cancel the download', danger: true, onPress: () => cancel(j)},
      ],
    });
  };
  const LABEL: Record<DownloadAction, string> = {
    play: 'Play',
    title: 'Title page',
    retry: 'Try again',
    remove: 'Remove from this list',
    cancel: 'Cancel',
    confirmCancel: 'Cancel',
  };
  const menu = (j: MyDownload, list: DownloadAction[]) =>
    openActions({
      title: j.label || j.title || 'Download',
      sub: statusLine(j),
      items: list.map(a => ({label: LABEL[a], danger: a === 'remove' || a === 'cancel' || a === 'confirmCancel', onPress: () => run(a, j)})),
    });

  let first = true;
  const row = (j: MyDownload, own: boolean) => {
    const canPlay = isReady(j);
    const acts = downloadActions(j, own);
    const pct = ACTIVE.includes(j.status) ? Math.round((j.progress || 0) * 100) : null;
    const fresh = canPlay && !j.seenAt;
    const claim = first;
    first = false;
    // at the 44dp it is drawn (api.ts artSrc)
    const art = artSrc(j.poster, 44).src;
    return (
      <Focusable
        key={j.id}
        scaleTo={1.01}
        edgeLeft
        hasTVPreferredFocus={claim}
        highlightColor={colors.surfaceHover}
        onPress={() => (acts.press === 'menu' ? menu(j, acts.all) : acts.press ? run(acts.press, j) : null)}
        onLongPress={acts.all.length > 1 ? () => menu(j, acts.all) : undefined}
        style={[styles.row, j.status === 'done' && styles.rowDone]}>
        <View style={styles.poster}>
          {art ? <Image source={art as ImgSource} style={styles.posterImg} resizeMode="cover" fadeDuration={0} /> : null}
        </View>
        <View style={styles.info}>
          <View style={styles.titleLine}>
            <Text style={styles.title} numberOfLines={1}>
              {j.label || j.title}
            </Text>
            {fresh ? <Text style={styles.newTag}>NEW</Text> : null}
            {j.quality ? <Text style={styles.quality}>{j.quality}</Text> : null}
          </View>
          <Text style={styles.status} numberOfLines={1}>
            {`${j.auto === 'mylist' ? 'From My List · ' : j.smart ? 'Next episode, queued for you · ' : ''}${statusLine(j)}${j.sizeBytes ? ` · ${fmtBytes(j.sizeBytes)}` : ''}`}
          </Text>
          {pct != null ? (
            <View style={styles.bar}>
              <View style={[styles.barFill, {width: `${pct}%`}]} />
            </View>
          ) : null}
        </View>
        <Text style={styles.action}>{acts.label}</Text>
      </Focusable>
    );
  };
  const section = (title: string, list: MyDownload[], own: boolean) =>
    list.length ? (
      <View key={title} style={styles.section}>
        <Text style={styles.h2}>
          {title}
          <Text style={styles.count}>{`  ${list.length}`}</Text>
        </Text>
        {list.map(j => row(j, own))}
      </View>
    ) : null;

  return (
    <View style={styles.root}>
      <NavRail active="settings" />
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, {paddingBottom: safeBottom + spacing.xl}]}>
        <Text style={styles.h1}>My downloads</Text>
        {mine.length ? <Text style={styles.hint}>Hold OK on a row for everything you can do with it.</Text> : null}
        {jobs === null && !error ? <ActivityIndicator color={colors.text} style={{marginTop: spacing.xl, alignSelf: 'flex-start'}} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {jobs !== null && mine.length === 0 && others.length === 0 ? (
          <Empty
            glyph="⬇"
            message="Nothing yet. Press SAVE next to any source on a title's page and it lands here."
            actionLabel="Back"
            onAction={() => canNavigate(navigation) && navigation.goBack()}
          />
        ) : null}
        {section('Ready to play', ready, true)}
        {section('On its way', moving, true)}
        {section('Waiting for approval', waiting, true)}
        {section("Didn't make it", failed, true)}
        {section('Also on the server', others, false)}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  scroll: {flex: 1},
  content: {paddingLeft: spacing.contentLeft, paddingRight: spacing.pageX, paddingTop: 27},
  h1: {color: colors.text, fontSize: fontSize.title, fontWeight: '900', marginTop: spacing.md},
  h2: {color: colors.text, fontSize: fontSize.row, fontWeight: '800', marginBottom: spacing.sm},
  hint: {color: colors.textFaint, fontSize: fontSize.small, marginTop: 2},
  count: {color: colors.textFaint, fontSize: fontSize.small, fontWeight: '700'},
  section: {marginTop: spacing.lg, gap: spacing.sm},
  error: {color: '#ff8080', fontSize: fontSize.body, marginTop: spacing.lg},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.m,
    padding: 10,
    paddingRight: spacing.md,
  },
  rowDone: {borderColor: 'rgba(74,222,128,0.35)'},
  poster: {width: 44, height: 66, borderRadius: radius.s, backgroundColor: colors.bgRaised, overflow: 'hidden'},
  posterImg: {width: '100%', height: '100%'},
  info: {flex: 1, minWidth: 0},
  titleLine: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  title: {color: colors.text, fontSize: fontSize.body, fontWeight: '700', flexShrink: 1},
  newTag: {color: colors.bg, backgroundColor: '#4ade80', fontSize: 11, fontWeight: '900', borderRadius: 4, paddingHorizontal: 6, overflow: 'hidden'},
  quality: {color: '#60a5fa', fontSize: 12, fontWeight: '900', letterSpacing: 1},
  status: {color: colors.textDim, fontSize: fontSize.small, marginTop: 3},
  bar: {height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)', marginTop: 8, overflow: 'hidden'},
  barFill: {height: '100%', backgroundColor: colors.accent},
  action: {color: colors.text, fontSize: fontSize.small, fontWeight: '800', minWidth: 70, textAlign: 'right'},
});
