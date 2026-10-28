// The sources of a film or an episode, on the phone — the website's sources
// list: each release with its quality, size, who is sharing it, its tags and
// warnings; Save (to the server's library — the row's main action) and Stream
// (play it now from the swarm). A copy made before the film is out at home
// asks first, in the site's words (releaseWords.ts EARLY_CONFIRM). A row that
// is downloading, queued or already saved says so and sorts to the top, as on
// the TV (screens/Sources.tsx, whose rules these are).
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, FlatList, StyleSheet, Text, View} from 'react-native';
import {useRoute, RouteProp} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {api, DownloadJob, Stream, TorrentPlayItem} from '../../api';
import {useApp} from '../../AppContext';
import {fallbackSources, streamPlayItem} from '../../playBest';
import {EARLY_CONFIRM, heroRelease, isEarly, ReleaseStatus, sourceBadge} from '../../releaseWords';
import {openActions} from '../../overlay';
import {showToast} from '../../toast';
import type {RootStackParamList} from '../../navigation';
import {usePNav} from '../nav';
import Tap from '../ui/Tap';
import Icon from '../ui/Icon';
import {BackBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import {colors, GUTTER, radius} from '../theme';

const QUALITY_COLOR: Record<string, string> = {'2160p': '#c084fc', '1080p': '#60a5fa', '720p': '#34d399', '480p': '#fbbf24', SD: '#9aa1b5'};
const DL_ACTIVE = ['pending', 'approved', 'downloading'];
const DL_BADGE: Record<string, {text: string; owned?: boolean}> = {
  done: {text: '✓ DOWNLOADED', owned: true},
  downloading: {text: '⬇ DOWNLOADING'},
  approved: {text: '⏳ QUEUED'},
  pending: {text: '⏳ NEEDS APPROVAL'},
};
const dlKey = (h: string, i: number) => `${h}:${i}`;

export default function Sources() {
  const route = useRoute<RouteProp<RootStackParamList, 'Sources'>>();
  const {type, imdbId, title, year, season, episode, runtime, poster} = route.params;
  const navigation = usePNav();
  const {profileId} = useApp();
  const insets = useSafeAreaInsets();
  const bottom = useTabBarSpace();
  const [streams, setStreams] = useState<Stream[] | null>(null);
  const [release, setRelease] = useState<ReleaseStatus | null>(null);
  const [jobs, setJobs] = useState<Map<string, DownloadJob>>(new Map());
  const [error, setError] = useState('');
  const streamsRef = useRef<Stream[] | null>(null);
  const prev = useRef<Map<string, DownloadJob>>(new Map());

  useEffect(() => {
    let live = true;
    api
      .torrentSources({type, title: imdbId, year, season, episode})
      .then(r => {
        if (!live) return;
        let s = r.streams || [];
        if (s.some(x => x.seeders > 0)) s = s.filter(x => x.seeders > 0);
        streamsRef.current = s;
        setStreams(s);
        setRelease(heroRelease(r.release));
      })
      .catch(() => live && setError('Could not reach the source provider.'));
    return () => {
      live = false;
    };
  }, [type, imdbId, year, season, episode]);

  const pull = useCallback(async () => {
    try {
      const list = await api.downloads();
      const map = new Map<string, DownloadJob>();
      for (const j of list) if (!map.has(dlKey(j.infoHash, j.fileIdx))) map.set(dlKey(j.infoHash, j.fileIdx), j);
      for (const [k, j] of map) {
        const was = prev.current.get(k)?.status;
        if (was && was !== j.status && j.status === 'done') showToast('Saved to your library — it plays instantly now', '✅');
        if (was && was !== j.status && j.status === 'error') showToast(j.error || 'That download failed', '⚠');
      }
      prev.current = map;
      setJobs(map);
      return [...map.values()].some(j => DL_ACTIVE.includes(j.status));
    } catch {
      return false;
    }
  }, []);
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const active = await pull();
      if (live && active) t = setTimeout(tick, 3000);
    };
    tick();
    return () => {
      live = false;
      if (t) clearTimeout(t);
    };
  }, [pull]);

  const ordered = useMemo(() => {
    if (!streams) return null;
    const seen = new Set<string>();
    const uniq = streams.filter(s => {
      const k = dlKey(s.infoHash, s.fileIdx);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const w = (st?: string) => (st === 'done' ? 0 : st && DL_ACTIVE.includes(st) ? 1 : 2);
    return uniq
      .map((st, i) => ({st, i}))
      .sort((a, b) => w(jobs.get(dlKey(a.st.infoHash, a.st.fileIdx))?.status) - w(jobs.get(dlKey(b.st.infoHash, b.st.fileIdx))?.status) || a.i - b.i)
      .map(x => x.st);
  }, [streams, jobs]);

  const askFirst = (s: Stream, what: 'download' | 'play', go: () => void) => {
    if (!isEarly(s)) return go();
    openActions({
      title: EARLY_CONFIRM.title,
      body: EARLY_CONFIRM.text(s),
      items: [
        {label: EARLY_CONFIRM[what], onPress: go},
        {label: EARLY_CONFIRM.cancel, onPress: () => {}},
      ],
    });
  };
  const play = (s: Stream) => {
    const ctx = {type: (type === 'series' ? 'series' : 'movie') as 'series' | 'movie', imdbId, title, year, season, episode, runtime, poster};
    const item: TorrentPlayItem = streamPlayItem(s, ctx);
    item.alts = fallbackSources(streams, s).map(a => streamPlayItem(a, ctx));
    navigation.push('Player', {id: item.id, title, stream: item});
  };
  const save = async (s: Stream) => {
    try {
      const res = await api.requestDownload({
        infoHash: s.infoHash,
        fileIdx: s.fileIdx,
        type: type === 'series' ? 'show' : 'movie',
        imdbId,
        title,
        label: season ? `${title} · S${season} E${episode}` : title,
        year,
        quality: s.quality,
        sizeBytes: s.sizeBytes,
        provider: s.provider,
        seeders: s.seeders,
        season: season || undefined,
        episode: episode || undefined,
        profile: profileId,
      });
      showToast(
        res.alreadyAvailable
          ? "Already yours — it's in the library"
          : res.duplicate
          ? 'Already queued. Patience.'
          : res.needsApproval
          ? 'Download requested — the server is low on space, so it needs admin approval.'
          : 'Downloading now! Go grab some popcorn.',
        '⬇',
      );
      pull();
      setTimeout(pull, 3000);
    } catch {
      showToast("Couldn't request the download", '⚠');
    }
  };

  const render = ({item: s}: {item: Stream}) => {
    const job = jobs.get(dlKey(s.infoHash, s.fileIdx));
    const badge = job ? DL_BADGE[job.status] : undefined;
    const warn = sourceBadge(s);
    const seedColor = s.seeders >= 30 ? '#34d399' : s.seeders >= 5 ? '#fbbf24' : colors.textDim;
    const pct = job?.status === 'downloading' ? Math.round((job.progress || 0) * 100) : null;
    return (
      <View style={[st.row, badge?.owned && st.rowOwned, s.recommended && st.rowBest]}>
        <View style={st.top}>
          <Text style={[st.q, {backgroundColor: QUALITY_COLOR[s.quality] || QUALITY_COLOR.SD}]}>{s.qualityLabel || s.quality}</Text>
          {s.recommended ? <Text style={st.best}>★ BEST</Text> : null}
          {warn ? <Text style={st.warn}>{warn}</Text> : null}
          {badge ? <Text style={[st.dl, badge.owned && {color: colors.owned}]}>{pct != null ? `⬇ ${pct}%` : badge.text}</Text> : null}
        </View>
        <Text style={st.name} numberOfLines={2}>
          {s.release || s.filename}
        </Text>
        <Text style={st.facts} numberOfLines={1}>
          {[s.sizeString, s.provider, (s.languages || []).slice(0, 3).join(' ')].filter(Boolean).join(' · ')}
          {'  '}
          <Text style={{color: seedColor, fontWeight: '800'}}>{`▲ ${s.seeders}`}</Text>
        </Text>
        {s.tags?.length ? (
          <Text style={st.tags} numberOfLines={1}>
            {s.tags.join(' · ')}
          </Text>
        ) : null}
        {s.badHere ? <Text style={st.bad}>{`Reported here: ${s.badHere.label}`}</Text> : null}
        <View style={st.btns}>
          <Tap onPress={() => askFirst(s, 'download', () => save(s))} style={st.save} accessibilityRole="button" accessibilityLabel={`Save ${s.qualityLabel || s.quality}`}>
            <Icon name="download" size={18} color={colors.bg} />
            <Text style={st.saveText}>{job?.status === 'done' ? 'Saved' : job && DL_ACTIVE.includes(job.status) ? 'Saving…' : 'Save'}</Text>
          </Tap>
          <Tap onPress={() => askFirst(s, 'play', () => play(s))} style={st.stream} accessibilityRole="button" accessibilityLabel={`Stream ${s.qualityLabel || s.quality}`}>
            <Icon name="play" size={16} color={colors.text} />
            <Text style={st.streamText}>Stream</Text>
          </Tap>
        </View>
      </View>
    );
  };

  const head = (
    <View style={{paddingTop: insets.top + 70, paddingHorizontal: GUTTER, paddingBottom: 8}}>
      <Text style={st.h1} numberOfLines={2}>
        Sources
      </Text>
      <Text style={st.sub}>{season && episode ? `${title} · S${season} E${episode}` : title}</Text>
      {release?.line ? <Text style={st.release}>{release.line}</Text> : null}
      {release?.note ? <Text style={st.sub}>{release.note}</Text> : null}
    </View>
  );
  return (
    <View style={st.root}>
      <FlatList
        data={ordered || []}
        keyExtractor={s => dlKey(s.infoHash, s.fileIdx)}
        renderItem={render}
        ListHeaderComponent={head}
        contentContainerStyle={{paddingBottom: bottom + 16}}
        ListEmptyComponent={
          <View style={st.empty}>
            {ordered === null && !error ? <ActivityIndicator color={colors.text} /> : <Text style={st.sub}>{error || 'No sources with active peers yet. Try again later.'}</Text>}
          </View>
        }
        initialNumToRender={8}
        windowSize={7}
      />
      <BackBar />
    </View>
  );
}

const st = StyleSheet.create({
  root: {flex: 1},
  h1: {color: colors.text, fontSize: 30, fontWeight: '900'},
  sub: {color: colors.textDim, fontSize: 15, marginTop: 4},
  release: {color: '#ffcf8a', fontSize: 15, fontWeight: '700', marginTop: 10},
  empty: {padding: 40, alignItems: 'center'},
  row: {marginHorizontal: GUTTER, marginBottom: 10, padding: 14, borderRadius: radius.l, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassEdge},
  rowOwned: {borderColor: 'rgba(111,224,176,0.45)', backgroundColor: 'rgba(80,200,150,0.10)'},
  rowBest: {borderColor: 'rgba(139,123,255,0.55)'},
  top: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap'},
  q: {color: '#0b0c14', fontSize: 12, fontWeight: '900', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: 'hidden'},
  best: {color: colors.accent, fontSize: 12, fontWeight: '900'},
  warn: {color: '#ffcf8a', fontSize: 11, fontWeight: '900', borderWidth: 1, borderColor: '#ffcf8a', borderRadius: 5, paddingHorizontal: 5},
  dl: {color: colors.text, fontSize: 12, fontWeight: '800'},
  name: {color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 19},
  facts: {color: colors.textDim, fontSize: 13, marginTop: 6},
  tags: {color: colors.textFaint, fontSize: 12, marginTop: 4},
  bad: {color: '#ffb3b3', fontSize: 12, marginTop: 4},
  btns: {flexDirection: 'row', gap: 10, marginTop: 12},
  save: {flex: 1, height: 44, borderRadius: 22, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, overflow: 'hidden'},
  saveText: {color: colors.bg, fontSize: 15, fontWeight: '800'},
  stream: {flex: 1, height: 44, borderRadius: 22, backgroundColor: 'rgba(12,14,30,0.55)', borderWidth: 1, borderColor: colors.glassEdge, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, overflow: 'hidden'},
  streamText: {color: colors.text, fontSize: 15, fontWeight: '800'},
});
