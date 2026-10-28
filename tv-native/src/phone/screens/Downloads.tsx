// Downloads on the phone — two lists, the website's two pages in one:
//
//   On this phone   the copies saved here (play them with no server at all),
//                   the ones on their way (preparing on the server, saving,
//                   waiting for Wi-Fi) with Cancel, and the ones that failed
//   My downloads    what you asked the SERVER to fetch — ready to play, on its
//                   way, waiting on an admin, didn't make it — then what the
//                   rest of the house has moving. Live over the socket.
//
// A server row's actions are the TV's and the site's (downloadsLogic.ts); its
// words are shared with the TV page (downloadsWords.ts).
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Image, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useIsFocused} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {api, ApiError, HeroItem, MyDownload} from '../../api';
import {useApp} from '../../AppContext';
import {canNavigate} from '../../navLock';
import {isOpen, onMessage} from '../../realtime';
import {showToast} from '../../toast';
import {openActions} from '../../overlay';
import {DownloadAction, downloadActions, isReady, rowStatus, startedBy} from '../../downloadsLogic';
import {ACTIVE, fmtBytes, statusLine} from '../../downloadsWords';
import {pushPhone, usePNav} from '../nav';
import {BackBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import Tap from '../ui/Tap';
import Icon from '../ui/Icon';
import {artSrc, Bar} from '../ui/Cards';
import {cancelOffline, removeOffline, Saved, useOffline, useOfflineUsage} from '../offline/store';
import {ACTIVE_STATES, fmtSize, stateLine} from '../offline/rules';
import {colors, GUTTER, radius} from '../theme';

const LABEL: Record<DownloadAction, string> = {play: 'Play', title: 'Title page', retry: 'Try again', remove: 'Remove from this list', cancel: 'Cancel', confirmCancel: 'Cancel'};

function Row({pic, title, line, sub, pct, right, onPress, onLongPress, tone}: {pic?: string | null; title: string; line: string; sub?: string | null; pct?: number | null; right?: React.ReactNode; onPress?: () => void; onLongPress?: () => void; tone?: 'ok' | 'warn' | 'live'}) {
  const src = pic ? artSrc(pic, 60).src : null;
  return (
    <Tap flat onPress={onPress} onLongPress={onLongPress} disabled={!onPress && !onLongPress} style={s.row} accessibilityRole="button" accessibilityLabel={`${title}, ${line}`}>
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
      </View>
      {right}
    </Tap>
  );
}

export default function Downloads() {
  const navigation = usePNav();
  const live = useIsFocused();
  const {profileId} = useApp();
  const insets = useSafeAreaInsets();
  const bottom = useTabBarSpace();
  const phone = useOffline();
  const usage = useOfflineUsage();
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
      const res = await api.requestDownload({infoHash: j.infoHash, fileIdx: j.fileIdx, type: j.type, imdbId: j.imdbId, title: j.title, label: j.label, poster: j.poster, quality: j.quality, sizeBytes: j.sizeBytes || 0, season: j.season || null, episode: j.episode || null, provider: j.provider || null, profile: profileId});
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
    if (a === 'cancel') return cancel(j);
    openActions({
      title: `Cancel “${j.label || j.title}”?`,
      sub: `It's ${Math.round((j.progress || 0) * 100)}% down. Cancelling throws that away; you can always ask for it again.`,
      items: [
        {label: 'Keep going', onPress: () => {}},
        {label: 'Cancel the download', danger: true, onPress: () => cancel(j)},
      ],
    });
  };
  const menu = (j: MyDownload, list: DownloadAction[]) =>
    openActions({title: j.label || j.title || 'Download', sub: statusLine(j), items: list.map(a => ({label: LABEL[a], danger: a === 'remove' || a === 'cancel' || a === 'confirmCancel', onPress: () => run(a, j)}))});
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
      />
    );
  };

  // ---- a phone copy's actions ----
  const phoneRow = (c: Saved) => {
    const active = ACTIVE_STATES.includes(c.state);
    const name = c.showTitle && c.season != null ? `${c.showTitle} · S${c.season} E${c.episode}` : c.title;
    return (
      <Row
        key={`p-${c.id}`}
        pic={c.cover}
        title={name}
        line={stateLine(c)}
        sub={c.state === 'done' ? c.quality === 'original' ? 'Original quality' : `${c.quality}p` : null}
        pct={active ? c.pct : null}
        tone={c.state === 'done' ? 'ok' : c.state === 'failed' ? 'warn' : 'live'}
        onPress={() => {
          if (c.state === 'done') pushPhone('OfflinePlayer', {id: c.id});
          else if (active) openActions({title: name, sub: stateLine(c), items: [{label: 'Cancel', danger: true, onPress: () => cancelOffline(c.id)}]});
          else openActions({title: name, sub: stateLine(c), items: [{label: 'Remove', danger: true, onPress: () => removeOffline(c.id)}]});
        }}
        onLongPress={() =>
          openActions({
            title: name,
            sub: stateLine(c),
            items: [
              ...(c.state === 'done' ? [{label: 'Play', onPress: () => pushPhone('OfflinePlayer', {id: c.id})}] : []),
              {label: active ? 'Cancel' : 'Remove from this phone', danger: true, onPress: () => (active ? cancelOffline(c.id) : removeOffline(c.id))},
            ],
          })
        }
        right={c.state === 'done' ? <Icon name="play" size={22} color={colors.text} /> : active ? <Text style={s.act}>Cancel</Text> : null}
      />
    );
  };

  const ready = mine.filter(isReady).sort((a, b) => (a.seenAt ? 1 : 0) - (b.seenAt ? 1 : 0));
  const moving = mine.filter(j => ACTIVE.includes(j.status) || (j.status === 'done' && !isReady(j)));
  const waiting = mine.filter(j => j.status === 'pending');
  const failed = mine.filter(j => ['error', 'declined', 'canceled'].includes(j.status));
  return (
    <View style={s.root}>
      <ScrollView
        contentContainerStyle={{paddingTop: insets.top + 70, paddingBottom: bottom + 24}}
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
        <Text style={s.h2}>On this phone</Text>
        <Text style={s.hint}>{usage.count ? `${usage.count} saved · ${fmtSize(usage.bytes)} · ${fmtSize(usage.free)} free` : 'Save a film or an episode from its page to watch it with no connection.'}</Text>
        {phone.map(phoneRow)}

        <Text style={s.h2}>My downloads</Text>
        <Text style={s.hint}>What you asked the server to fetch. Tap a row; hold it for everything you can do.</Text>
        {error ? <Text style={s.err}>{error}</Text> : null}
        {jobs && !mine.length ? <Text style={s.empty}>Nothing yet. Tap Save next to any source on a title's page and it lands here.</Text> : null}
        {ready.length ? <Text style={s.h3}>Ready to play</Text> : null}
        {ready.map(j => serverRow(j, true))}
        {moving.length ? <Text style={s.h3}>On its way</Text> : null}
        {moving.map(j => serverRow(j, true))}
        {waiting.length ? <Text style={s.h3}>Waiting for approval</Text> : null}
        {waiting.map(j => serverRow(j, true))}
        {failed.length ? <Text style={s.h3}>Didn't make it</Text> : null}
        {failed.map(j => serverRow(j, true))}
        {others.length ? <Text style={s.h2}>Downloading for the rest of the house</Text> : null}
        {others.map(j => serverRow(j, false))}
      </ScrollView>
      <BackBar />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  h1: {color: colors.text, fontSize: 32, fontWeight: '900', paddingHorizontal: GUTTER},
  h2: {color: colors.text, fontSize: 20, fontWeight: '800', paddingHorizontal: GUTTER, marginTop: 22},
  h3: {color: colors.textDim, fontSize: 13, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: GUTTER, marginTop: 14, marginBottom: 6},
  hint: {color: colors.textDim, fontSize: 14, paddingHorizontal: GUTTER, marginTop: 4, marginBottom: 10},
  empty: {color: colors.textDim, fontSize: 15, paddingHorizontal: GUTTER, paddingVertical: 12},
  err: {color: '#ffb3b3', fontSize: 15, paddingHorizontal: GUTTER},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: GUTTER, marginBottom: 8, padding: 10, borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge},
  pic: {width: 52, height: 78, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center'},
  title: {color: colors.text, fontSize: 15, fontWeight: '800'},
  line: {color: colors.textDim, fontSize: 13, marginTop: 3},
  sub: {color: colors.textFaint, fontSize: 12, marginTop: 2},
  act: {color: colors.accent, fontSize: 14, fontWeight: '800'},
});
