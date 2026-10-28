// A title's page on the phone — the website's phone title page, glass look:
//
//   the picture       the title's key art across the top, the kicker (FILM /
//                     SERIES), the name, ★ score, year · length · genres, badges
//   the one button    white, full width: Play / Resume 0:42 (a film you hold),
//                     Save & watch (one you don't: the best source is saved AND
//                     played while it downloads — playBest.ts), Continue S1 E3 ·
//                     12:04 (a show); the line under it tells the download's story
//   the actions       round glass buttons with their word: Stream instead, Start
//                     over, My List, Recommend, X-Ray, Mark watched, Follow,
//                     Trailer, Share
//   the rest          synopsis (More), cast and director, "Recommended by …",
//                     the seasons and their episodes (a show), More like this
//
// The rules are the TV's title page (screens/Detail.tsx) — the same reads, the
// same one-press rule, the same marks, the same words — through the helpers
// both share (detailLogic.ts, playBest.ts, episodeRules.ts, householdRecs.ts).
// A press on an episode you don't hold saves its best source and the card
// carries the download; a long press gives its sources and marks.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Image, ScrollView, Share, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useIsFocused, useRoute, RouteProp} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  api,
  ApiError,
  DiscoverMeta,
  DownloadJob,
  Episode,
  getBaseUrl,
  HeroItem,
  Item,
  LIST_ADDED,
  MarkEntry,
  Progress,
  Stream,
  StreamRef,
} from '../../api';
import {useApp} from '../../AppContext';
import {canNavigate} from '../../navLock';
import {showToast} from '../../toast';
import {onMessage} from '../../realtime';
import {openActions, openRecommend, openTrailer, openXray} from '../../overlay';
import {autoPlayStep, fallbackSources, jobSource, pickBest, runningJobFor, streamPlayItem} from '../../playBest';
import {heroRelease, ReleaseStatus} from '../../releaseWords';
import {pickUp, startSeason} from '../../episodeRules';
import {bannerLine, notesOf, titleKey, WORDS as HH} from '../../householdRecs';
import {householdChanged} from '../../householdLive';
import {loadMe, patchMe, peekMe} from '../../navSection';
import {track} from '../../usage';
import {
  ACTIVE_JOB,
  Air,
  dlText,
  fmtAirDate,
  fmtClock,
  fmtDuration,
  isReplacement,
  libMatch,
  libNorm,
  parseRuntimeMin,
  resBadge,
  resolveAirStates,
  resolveImdb,
  unescapeHtml,
} from '../../detailLogic';
import type {RootStackParamList} from '../../navigation';
import {usePNav} from '../nav';
import {ActionCircle, ChipButton, PrimaryButton} from '../ui/Buttons';
import {artSrc, Bar, PosterCard} from '../ui/Cards';
import Icon from '../ui/Icon';
import Tap from '../ui/Tap';
import {BackBar} from '../ui/PageHead';
import {useTabBarSpace} from '../ui/TabBar';
import {shareLink} from '../linkParse';
import {phoneNative} from '../native';
import {pushPhone} from '../nav';
import {saveOffline, useOffline} from '../offline/store';
import {chooseQuality} from '../offline/choose';
import {Device, playOn, useDevices} from '../remote/controller';
import {colors, GUTTER, radius} from '../theme';

const isStream = (it: HeroItem) => it.source === 'stream' || !it.id;

type UiEp = {
  key: string;
  num: number;
  season: number;
  episode: number;
  label: string;
  overview?: string;
  thumb?: string | null;
  owned: boolean;
  epId?: string;
  position: number;
  touchedAt: number | null;
  watched: boolean;
  pct: number;
  durationMin?: number;
  airLabel: string;
  air: Air;
  hasSubs: boolean;
  upNext?: boolean;
  dl?: {status: string; progress: number};
  subs?: {label: string; lang?: string; url: string}[];
  durationSec?: number;
  phone?: 'done' | 'saving';
};
type UiSeason = {number: number; episodes: UiEp[]};

// ---------------------------------------------------------------- an episode
const EpisodeRow = React.memo(function EpisodeRow({ep, onPress, onLong}: {ep: UiEp; onPress: (ep: UiEp) => void; onLong: (ep: UiEp) => void}) {
  const still = ep.thumb ? artSrc(ep.thumb, 150).src : null;
  const kicker = [`EPISODE ${ep.num}`, ep.durationMin ? `${ep.durationMin} MIN` : null].filter(Boolean).join(' · ');
  const dim = ep.air !== 'aired';
  return (
    <Tap
      flat
      onPress={() => onPress(ep)}
      onLongPress={() => onLong(ep)}
      delayLongPress={380}
      accessibilityRole="button"
      accessibilityLabel={`${ep.label}, episode ${ep.num}${ep.watched ? ', watched' : ''}${ep.owned ? ', downloaded' : ''}`}
      style={[s.ep, ep.owned && s.epOwned, ep.upNext && s.epNext, dim && {opacity: 0.6}]}>
      <View style={s.epStill}>
        {still ? <Image source={still} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <Icon name="series" size={26} color={colors.textFaint} />}
        {ep.pct > 0 ? <Bar f={ep.pct / 100} style={s.epBar} /> : null}
        {ep.dl ? (
          <View style={s.epDl}>
            <Text style={s.epDlText}>{dlText(ep.dl)}</Text>
          </View>
        ) : null}
      </View>
      <View style={s.epBody}>
        <Text style={s.epKicker} numberOfLines={1}>
          {kicker}
        </Text>
        <Text style={s.epTitle} numberOfLines={2}>
          {unescapeHtml(ep.label)}
        </Text>
        <View style={s.epFoot}>
          {ep.owned ? <Icon name="play" size={13} color={colors.owned} /> : <Icon name="download" size={14} color={colors.textDim} />}
          <Text style={s.epFootText} numberOfLines={1}>
            {ep.air === 'tba' ? 'Not scheduled yet' : ep.air === 'upcoming' ? `Airs ${ep.airLabel}` : ep.airLabel || (ep.owned ? 'Downloaded' : 'Stream or save')}
          </Text>
          {ep.phone ? <Icon name="phone" size={14} color={ep.phone === 'done' ? colors.owned : colors.textDim} /> : null}
          {ep.hasSubs ? <Text style={s.cc}>CC</Text> : null}
          {ep.watched ? <Icon name="check" size={16} color={colors.textDim} /> : null}
        </View>
      </View>
    </Tap>
  );
});

// ---------------------------------------------------------------- the page
export default function Detail() {
  const route = useRoute<RouteProp<RootStackParamList, 'Detail'>>();
  const navigation = usePNav();
  const isFocused = useIsFocused();
  const {item, play: autoPlay} = route.params;
  const {profileId} = useApp();
  const insets = useSafeAreaInsets();
  const bottom = useTabBarSpace();
  const {width, height} = useWindowDimensions();
  const stream = isStream(item);
  const isShow = item.type === 'show';
  const imdbKind: 'movie' | 'show' = isShow ? 'show' : 'movie';

  const [full, setFull] = useState<Item | null>(null);
  const [meta, setMeta] = useState<DiscoverMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [libSettled, setLibSettled] = useState(!stream);
  const [libImdb, setLibImdb] = useState<string | null>(item.imdbId || null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [epProgress, setEpProgress] = useState<Record<string, Progress>>({});
  const [stateRead, setStateRead] = useState(false);
  const [inList, setInList] = useState(false);
  const [following, setFollowing] = useState(false);
  const [torrentsOff, setTorrentsOff] = useState(false);
  const [torrentsKnown, setTorrentsKnown] = useState(false);
  const [libraryTick, setLibraryTick] = useState(0);
  const [jobs, setJobs] = useState<Record<string, {status: string; progress: number}>>({});
  const [jobsRead, setJobsRead] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [heroRel, setHeroRel] = useState<ReleaseStatus | null>(null);
  const [note, setNote] = useState<{text: string; tone: 'live' | 'warn' | 'ok' | 'hint'} | null>(null);
  const [similar, setSimilar] = useState<HeroItem[] | null>(null);
  const [moreText, setMoreText] = useState(false);
  const [seasonPick, setSeasonPick] = useState<number | null>(null);
  const [hhFrom, setHhFrom] = useState<{id: string; name: string; note?: string}[]>([]);
  const [hhHidden, setHhHidden] = useState(false);
  const inflight = useRef(new Set<string>());
  const scrollRef = useRef<ScrollView>(null);
  // copies saved on this phone (phone/offline/store.ts)
  const saved = useOffline();
  // [phone-remote] the profile's TVs that are on: "Play on TV"
  const tvs = useDevices().filter(d => d.caps?.playItem !== false);
  const phoneState = useCallback(
    (id: string): 'done' | 'saving' | undefined => {
      const c = saved.find(x => x.id === id);
      return !c ? undefined : c.state === 'done' ? 'done' : c.state === 'failed' ? undefined : 'saving';
    },
    [saved],
  );

  // ---- reads (the TV's, in the same order) ----
  const refused = useCallback(
    (e: unknown) => {
      if (!(e instanceof ApiError) || e.status !== 403 || e.passwordResetRequired) return false;
      showToast(e.message || "This title isn't available on this profile", '🚫');
      if (navigation.isFocused()) navigation.goBack();
      return true;
    },
    [navigation],
  );
  useEffect(() => {
    api.torrentsOff().then(off => {
      setTorrentsOff(off);
      setTorrentsKnown(true);
    });
  }, []);
  // the library record (a library card, or a link to one)
  useEffect(() => {
    if (!item.id || stream) {
      if (!stream) setLoading(false);
      return;
    }
    let live = true;
    api
      .item(item.id, profileId, libraryTick > 0)
      .then(f => live && setFull(f))
      .catch(e => live && refused(e))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [item.id, stream, profileId, libraryTick, refused]);
  // a catalogue card can still be a title on disk (the TV's libMatch)
  useEffect(() => {
    if (!stream) return;
    let live = true;
    (async () => {
      try {
        let libId = item.inLibrary || null;
        if (!libId) {
          const l = await api.library();
          if (!live) return;
          libId = libMatch(isShow ? l.shows : l.movies, item.title, item.year)?.id || null;
        }
        if (libId) {
          const f = await api.item(libId, profileId);
          if (live) setFull(f);
        }
      } catch {}
      if (live) setLibSettled(true);
    })();
    return () => {
      live = false;
    };
  }, [stream, item.inLibrary, isShow, item.title, item.year, profileId, libraryTick]);
  // the IMDb id (what sources, X-Ray, follow and the catalogue are keyed by)
  useEffect(() => {
    if (stream) return;
    const known = item.imdbId || full?.imdbId;
    if (known) return setLibImdb(known);
    if (!item.title && !full?.title) return;
    let live = true;
    resolveImdb(imdbKind, full?.title || item.title, full?.year || item.year).then(id => live && id && setLibImdb(id));
    return () => {
      live = false;
    };
  }, [stream, imdbKind, item.imdbId, item.title, item.year, full?.imdbId, full?.title, full?.year]);
  const imdb = stream ? item.imdbId || item.id : libImdb;
  // the catalogue's page (episodes, cast, runtime, trailers)
  useEffect(() => {
    if (!imdb) return;
    let live = true;
    api
      .discoverMeta(isShow ? 'series' : 'movie', imdb)
      .then(m => live && setMeta(m))
      .catch(e => live && stream && refused(e))
      .finally(() => live && stream && setLoading(false));
    return () => {
      live = false;
    };
  }, [imdb, isShow, stream, refused]);
  useEffect(() => {
    if (stream && !item.imdbId && !item.id) setLoading(false);
  }, [stream, item.imdbId, item.id]);
  // watch state, again every time the page is shown (back from the player)
  useEffect(() => {
    if (!isFocused) return;
    let live = true;
    api
      .state(profileId)
      .then(st => {
        if (!live) return;
        setProgress(st.progress || {});
        setEpProgress(st.episodeProgress || {});
      })
      .catch(() => {})
      .finally(() => live && setStateRead(true));
    return () => {
      live = false;
    };
  }, [isFocused, profileId]);
  useEffect(() => {
    let live = true;
    api
      .watchlist(profileId)
      .then(w => live && setInList((w.items || []).some(x => (x.id && x.id === item.id) || (x.imdbId && x.imdbId === (item.imdbId || item.id)))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profileId, item.id, item.imdbId]);
  const followImdb = isShow ? imdb : null;
  useEffect(() => {
    if (!followImdb) return;
    setFollowing(!!peekMe(profileId)?.follows?.includes(followImdb));
    loadMe(profileId, 60000).then(me => me && setFollowing(!!me.follows?.includes(followImdb)));
  }, [profileId, followImdb]);
  // [household] who recommended it to you
  const hhKey = titleKey(item, imdb);
  useEffect(() => {
    if (!hhKey) return;
    let live = true;
    api
      .householdFor(profileId, hhKey)
      .then(r => {
        if (!live || !r || r.dismissed || !(r.from || []).length) return;
        setHhFrom(r.from);
        householdChanged();
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profileId, hhKey]);

  // ---- this title's downloads ----
  const loadJobs = useCallback(async (): Promise<boolean> => {
    if (!imdb) {
      setJobsRead(true);
      return false;
    }
    try {
      const list = await api.downloads();
      const next: Record<string, {status: string; progress: number}> = {};
      for (const j of list) {
        if (j.imdbId !== imdb || isReplacement(j) || !ACTIVE_JOB.includes(j.status)) continue;
        const k = j.season && j.episode ? `${j.season}x${j.episode}` : 'film';
        if (!next[k]) next[k] = {status: j.status, progress: j.progress || 0};
      }
      setJobs(prev => {
        const ended = Object.keys(prev).some(k => !next[k]);
        if (ended) setTimeout(() => setLibraryTick(t => t + 1), 1500);
        return next;
      });
      setJobsRead(true);
      return Object.keys(next).length > 0;
    } catch {
      setJobsRead(true);
      return false;
    }
  }, [imdb]);
  useEffect(() => {
    if (!isFocused) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const running = await loadJobs();
      if (live && running) timer = setTimeout(tick, 4000);
    };
    tick();
    const off = onMessage('download_update', d => {
      const j = d.job as DownloadJob | undefined;
      if (!j || !imdb || j.imdbId !== imdb) return;
      const k = j.season && j.episode ? `${j.season}x${j.episode}` : 'film';
      if (!ACTIVE_JOB.includes(j.status)) {
        setJobs(prev => {
          const n = {...prev};
          delete n[k];
          return n;
        });
        if (j.status === 'done') setTimeout(() => setLibraryTick(t => t + 1), 1200);
        return;
      }
      setJobs(prev => ({...prev, [k]: {status: j.status, progress: j.progress || 0}}));
      if (!timer) timer = setTimeout(tick, 4000);
    });
    const offLib = onMessage('library_updated', () => setLibraryTick(t => t + 1));
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
      offLib();
    };
  }, [isFocused, loadJobs, imdb]);

  // ---- what the page shows ----
  const title = full?.showTitle || full?.title || meta?.title || item.title || '';
  const ownedMovieId = !isShow ? (!stream ? item.id : full?.videoUrl ? full.id : null) : null;
  const movieProg = ownedMovieId ? progress[ownedMovieId] : undefined;
  const movieWatched = !!movieProg?.finished;
  const movieResume = movieProg && !movieProg.finished && movieProg.position > 10 ? movieProg.position : 0;
  const genres = [full?.genres, meta?.genres, item.genres].find(g => g && g.length) || [];
  const synopsis = unescapeHtml(full?.synopsis || meta?.synopsis || item.synopsis || '');
  const year = full?.year || meta?.year || item.year;
  const rating = item.rating ?? meta?.rating ?? null;
  const keyArt = imdb ? `https://images.metahub.space/background/medium/${imdb}/img` : null;
  const art = artSrc(keyArt || item.backdrop || meta?.backdrop || item.cover || item.poster, width).src;

  // a film you don't hold: is there a good copy yet? (releaseWords.ts — the site's words)
  useEffect(() => {
    setHeroRel(null);
    if (isShow || !imdb || ownedMovieId || torrentsOff) return;
    let live = true;
    api
      .torrentSources({type: 'movie', title: imdb, year: year ?? undefined})
      .then(r => live && setHeroRel(pickBest(r.streams) ? null : heroRelease(r.release)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [isShow, imdb, ownedMovieId, torrentsOff, year]);

  const seasons: UiSeason[] = useMemo(() => {
    if (!isShow) return [];
    const runtimeMin = parseRuntimeMin(meta?.runtime);
    const local = new Map<string, Episode>();
    for (const se of full?.seasons || []) for (const ep of se.episodes) local.set(`${se.number}x${ep.episode}`, ep);
    const build = (sn: number, en: number, label: string | undefined, overview: string | undefined, thumb: string | null | undefined, released: string | null | undefined, air: Air): UiEp => {
      const ep = local.get(`${sn}x${en}`);
      const pr = ep ? progress[ep.id] : (imdb && (epProgress[`${imdb}:${sn}:${en}`] || progress[`stream|${imdb}|${sn}|${en}`])) || undefined;
      return {
        key: `${sn}x${en}`,
        num: en,
        season: sn,
        episode: en,
        label: label || ep?.title || `Episode ${en}`,
        overview,
        thumb: thumb || (ep ? `/img/still/${ep.id}` : null),
        owned: !!ep,
        epId: ep?.id,
        position: ep && pr ? pr.position : 0,
        touchedAt: ep && pr ? pr.updatedAt || 0 : null,
        watched: !!pr?.finished,
        pct: pr && pr.duration > 0 && !pr.finished ? Math.min(100, Math.round((pr.position / pr.duration) * 100)) : 0,
        durationMin: ep?.duration ? Math.round(ep.duration / 60) : runtimeMin,
        airLabel: fmtAirDate(released),
        air,
        hasSubs: !!ep?.subtitles?.length,
        dl: ep ? undefined : jobs[`${sn}x${en}`],
        subs: (ep?.subtitles || []).filter(t => !!t.url).map(t => ({label: t.label, lang: t.lang, url: t.url})),
        durationSec: ep?.duration,
        phone: ep ? phoneState(ep.id) : undefined,
      };
    };
    if (meta?.seasons?.length) {
      return meta.seasons.map(se => {
        const airs = resolveAirStates(se.episodes.map(ep => ({episode: ep.episode, released: ep.released, local: local.has(`${se.number}x${ep.episode}`)})));
        const eps = se.episodes.map((ep, i) => build(se.number, ep.episode, ep.title, ep.overview, ep.thumbnail, ep.released, airs[i]));
        if (eps.some(e => e.watched)) {
          const nx = eps.find(e => e.air === 'aired' && !e.watched);
          if (nx) nx.upNext = true;
        }
        return {number: se.number, episodes: eps};
      });
    }
    return (full?.seasons || []).map(se => ({number: se.number, episodes: se.episodes.map(ep => build(se.number, ep.episode, ep.title, undefined, null, null, 'aired'))}));
  }, [isShow, full, meta, progress, epProgress, jobs, imdb, phoneState]);

  const nextUp = useMemo(() => {
    const hit = pickUp(seasons.flatMap(se => se.episodes));
    if (!hit) return null;
    return {ep: hit.ep, resume: hit.resumed, at: hit.mid ? hit.ep.position || 0 : 0};
  }, [seasons]);
  const firstAired = useMemo(() => seasons.flatMap(se => se.episodes).find(e => e.air === 'aired') || null, [seasons]);
  const heroEp = nextUp?.ep || firstAired;
  const seasonNo = startSeason(
    seasons.map(se => se.number),
    seasonPick,
    heroEp?.season,
    seasons[0]?.number,
  );
  const season = seasons.find(se => se.number === seasonNo) || null;

  // ---- presses ----
  const sayTorrentsOff = useCallback(() => {
    if (!torrentsOff) return false;
    showToast("That isn't on this server yet — downloads are switched off here", '📭');
    return true;
  }, [torrentsOff]);
  const playEpisode = useCallback(
    (ep: UiEp) => {
      if (!ep.epId || !canNavigate(navigation as never)) return;
      navigation.push('Player', {id: ep.epId, title: `${title} · S${ep.season} E${ep.episode}`, epTitle: /^Episode \d+$/.test(ep.label) ? undefined : ep.label});
    },
    [navigation, title],
  );
  const openSources = useCallback(
    (s?: number, e?: number) => {
      if (sayTorrentsOff() || !imdb) return;
      navigation.push('Sources', {
        type: isShow ? 'series' : 'movie',
        imdbId: imdb,
        title,
        year: year ?? null,
        season: s ?? null,
        episode: e ?? null,
        runtime: meta?.runtime ?? null,
        poster: item.cover ?? item.poster ?? meta?.poster ?? null,
      });
    },
    [sayTorrentsOff, imdb, navigation, isShow, title, year, meta?.runtime, meta?.poster, item.cover, item.poster],
  );
  const streamNow = useCallback(
    (src: Parameters<typeof streamPlayItem>[0], s?: number, e?: number, list?: Stream[] | null) => {
      if (!navigation.isFocused() || !imdb) return false;
      const ctx = {type: (s && e ? 'series' : 'movie') as 'series' | 'movie', imdbId: imdb, title, year, season: s, episode: e, runtime: meta?.runtime ?? null, poster: item.cover ?? item.poster ?? null};
      const pi = streamPlayItem(src, ctx);
      pi.alts = fallbackSources(list, src as Stream).map(a => streamPlayItem(a, ctx));
      navigation.push('Player', {id: pi.id, title, stream: pi});
      return true;
    },
    [navigation, imdb, title, year, meta?.runtime, item.cover, item.poster],
  );
  const streamRunning = useCallback(
    async (s?: number, e?: number) => {
      if (!imdb) return false;
      try {
        const job = runningJobFor(await api.downloads(), imdb, s, e);
        if (!job) return false;
        const list = await api
          .torrentSources(s && e ? {type: 'series', title: imdb, year: year ?? undefined, season: s, episode: e} : {type: 'movie', title: imdb, year: year ?? undefined})
          .catch(() => ({streams: [] as Stream[]}));
        return streamNow(jobSource(job, list.streams), s, e, list.streams);
      } catch {
        return false;
      }
    },
    [imdb, year, streamNow],
  );
  // ONE PRESS (playBest.ts): save the best source; with `play`, play it while it downloads
  const saveBest = useCallback(
    async (s: number | null, e: number | null, play: boolean, air: Air = 'aired') => {
      const key = s && e ? `${s}x${e}` : 'film';
      const name = s && e ? `S${s} E${e}` : title;
      if (s && e && air !== 'aired') {
        showToast(air === 'tba' ? 'Not scheduled yet' : 'Not aired yet', '⏳');
        return;
      }
      if (sayTorrentsOff()) return;
      if (jobs[key] || inflight.current.has(key)) {
        if (play && jobs[key] && (await streamRunning(s || undefined, e || undefined))) return;
        showToast(`${name} is already on its way${jobs[key] ? ` · ${dlText(jobs[key]).toLowerCase()}` : ''} — long-press for its sources`, '⏳');
        return;
      }
      if (!imdb) {
        showToast('Could not match this title to a source catalogue', '⚠');
        return;
      }
      inflight.current.add(key);
      setBusyKey(key);
      setNote({text: `Getting ${name}  ·  finding the best source…`, tone: 'live'});
      try {
        const {streams, release} = await api.torrentSources(s && e ? {type: 'series', title: imdb, year: year ?? undefined, season: s, episode: e} : {type: 'movie', title: imdb, year: year ?? undefined});
        const pick = pickBest(streams);
        if (!pick) {
          const said = !s ? heroRelease(release) : null;
          if (said) {
            setHeroRel(said);
            setNote({text: `${said.line}  ·  long-press for the list`, tone: 'warn'});
            showToast(said.line || '', '🎬');
          } else if ((streams || []).length) {
            setNote({text: 'No copy to pick for you yet  ·  long-press for the list', tone: 'warn'});
            showToast('No copy to pick for you yet — long-press Play for the list', '⚠');
          } else {
            setNote({text: `No sources for ${name} yet  ·  try again later`, tone: 'warn'});
            showToast('No sources for this title yet', '⚠');
          }
          return;
        }
        const playing = play && streamNow(pick, s || undefined, e || undefined, streams);
        const res = await api.requestDownload({
          infoHash: pick.infoHash,
          fileIdx: pick.fileIdx,
          type: s && e ? 'show' : 'movie',
          imdbId: imdb,
          title,
          label: s && e ? `${title} · S${s} E${e}` : title,
          year: year ?? undefined,
          quality: pick.quality,
          sizeBytes: pick.sizeBytes,
          provider: pick.provider,
          seeders: pick.seeders,
          ...(s && e ? {season: s, episode: e} : {}),
          profile: profileId,
        });
        if (res.alreadyAvailable) {
          showToast("Already yours — it's in the library", '✅');
          setNote({text: 'Ready — press Play', tone: 'ok'});
          setLibraryTick(t => t + 1);
          return;
        }
        if (res.duplicate) showToast(`${name} is already on its way`, '⏳');
        else if (res.needsApproval) showToast(`Requested ${pick.quality} · ${pick.sizeString || ''} — waiting for approval`, '⬇');
        else showToast(`Saving ${pick.quality} · ${pick.sizeString || ''} — ${playing ? 'playing it while it downloads' : 'the card shows the progress'}`, '⬇');
        setNote(null);
        setJobs(prev => (prev[key] ? prev : {...prev, [key]: {status: res.needsApproval ? 'pending' : 'approved', progress: 0}}));
        setTimeout(loadJobs, 1500);
      } catch (err) {
        showToast((err as Error)?.message || "Couldn't request the download", '⚠');
        setNote({text: `Couldn't get ${name}  ·  long-press Play for other sources`, tone: 'warn'});
      } finally {
        inflight.current.delete(key);
        setBusyKey(null);
      }
    },
    [title, sayTorrentsOff, jobs, streamRunning, imdb, year, streamNow, profileId, loadJobs],
  );
  const onEpisode = useCallback(
    (ep: UiEp) => {
      phoneNative.haptic('tick');
      if (ep.owned) playEpisode(ep);
      else saveBest(ep.season, ep.episode, false, ep.air);
    },
    [playEpisode, saveBest],
  );

  // ---- saving to this phone (the website's offline copies) ----
  const saveEpisodeToPhone = useCallback(
    (ep: UiEp) => {
      if (!ep.epId) return;
      if (ep.phone === 'done') return pushPhone('OfflinePlayer', {id: ep.epId});
      saveOffline(
        {id: ep.epId, title: ep.label, showId: full?.id || item.id, showTitle: title, season: ep.season, episode: ep.episode, year, cover: item.cover || item.poster || full?.cover || null, duration: ep.durationSec, subtitles: ep.subs},
        chooseQuality(`${title} · S${ep.season} E${ep.episode}`),
      );
    },
    [full, item.id, item.cover, item.poster, title, year],
  );
  const saveFilmToPhone = () => {
    if (!ownedMovieId) return;
    if (phoneState(ownedMovieId) === 'done') return pushPhone('OfflinePlayer', {id: ownedMovieId});
    saveOffline(
      {id: ownedMovieId, title, year, cover: full?.cover || item.cover || item.poster || null, duration: full?.duration, subtitles: (full?.subtitles || []).filter(t => !!t.url).map(t => ({label: t.label, lang: t.lang, url: t.url}))},
      chooseQuality(title),
    );
  };

  // ---- Play on TV (the website's button): the film, or the episode Play stands for ----
  const playOnTv = () => {
    const target =
      !isShow && ownedMovieId
        ? {id: ownedMovieId, title, type: 'movie', imdbId: imdb, cover: full?.cover || item.cover || item.poster || null, duration: full?.duration || null, position: movieResume || null}
        : isShow && heroEp?.epId
        ? {id: heroEp.epId, title: heroEp.label, showId: full?.id || item.id, showTitle: title, season: heroEp.season, episode: heroEp.episode, imdbId: imdb, cover: item.cover || item.poster || null, duration: heroEp.durationSec || null, position: nextUp?.at || null}
        : null;
    if (!target) return showToast('Only what is on the server plays on a TV — save it first', 'ℹ️');
    const go = (d: Device) => playOn(d, target, {position: target.position});
    if (tvs.length === 1) return go(tvs[0]);
    openActions({title: 'Play on…', items: tvs.map(d => ({label: d.name, tag: d.mine === false && d.profile ? d.profile.name : undefined, onPress: () => go(d)}))});
  };

  // MARK WATCHED IS NOT WATCHING (the TV's rule): the server's mark route, and what
  // each row looked like before THIS page marked it is sent back on unwatched
  const markSnap = useRef(new Map<string, Progress | null>());
  const markEntry = useCallback((itemId: string, watched: boolean, duration: number, seen: Progress | undefined, metaItem?: Record<string, unknown>): MarkEntry => {
    const e: MarkEntry = {itemId, watched, duration, item: metaItem};
    if (watched) {
      if (!markSnap.current.has(itemId)) markSnap.current.set(itemId, seen ? {position: seen.position, duration: seen.duration, finished: !!seen.finished, updatedAt: seen.updatedAt || 0} : null);
    } else if (markSnap.current.has(itemId)) {
      e.restore = markSnap.current.get(itemId) ?? null;
      markSnap.current.delete(itemId);
    }
    return e;
  }, []);
  const reloadState = useCallback(async () => {
    const st = await api.state(profileId);
    setProgress(st.progress || {});
    setEpProgress(st.episodeProgress || {});
  }, [profileId]);
  const toggleMovieWatched = async () => {
    if (!ownedMovieId) return;
    const dur = full?.duration || movieProg?.duration || 1;
    const next = !movieWatched;
    setProgress(p => ({...p, [ownedMovieId]: next ? {position: dur, duration: dur, finished: true} : {position: 0, duration: dur, finished: false}}));
    try {
      await api.markWatched(profileId, [markEntry(ownedMovieId, next, dur, movieProg)]);
      showToast(next ? 'Marked watched' : 'Marked unwatched', '✓');
      await reloadState();
    } catch {}
  };
  const setEpisodeWatched = useCallback(
    async (eps: UiEp[], watched: boolean) => {
      const items = eps.map(ep => {
        const dur = (ep.durationMin || 45) * 60;
        if (ep.epId) return markEntry(ep.epId, watched, dur, progress[ep.epId]);
        const id = `stream|${imdb}|${ep.season}|${ep.episode}`;
        return markEntry(id, watched, dur, epProgress[`${imdb}:${ep.season}:${ep.episode}`], {imdbId: imdb, type: 'show', title, season: ep.season, episode: ep.episode, poster: item.cover || item.poster || null});
      });
      await api.markWatched(profileId, items);
      await reloadState();
    },
    [markEntry, progress, epProgress, imdb, title, item.cover, item.poster, profileId, reloadState],
  );
  const episodeActions = useCallback(
    (ep: UiEp) => {
      phoneNative.haptic('long');
      openActions({
        title: unescapeHtml(ep.label),
        sub: `${title} · S${ep.season} E${ep.episode}`,
        body: ep.overview ? unescapeHtml(ep.overview) : undefined,
        items: [
          ...(ep.owned ? [{label: 'Play', onPress: () => playEpisode(ep)}] : [{label: 'Save and play', tag: 'the best source, played while it downloads', onPress: () => saveBest(ep.season, ep.episode, true, ep.air)}]),
          ...(ep.owned ? [{label: ep.phone === 'done' ? 'Play the copy on this phone' : ep.phone ? 'Saving to this phone…' : 'Save to this phone', tag: ep.phone ? undefined : 'watch it with no connection', onPress: () => saveEpisodeToPhone(ep)}] : []),
          ...(!ep.owned ? [{label: 'Sources', tag: 'streams and downloads', onPress: () => openSources(ep.season, ep.episode)}] : []),
          {
            label: ep.watched ? 'Mark unwatched' : 'Mark watched',
            tag: ep.watched ? 'back to unseen' : 'ticks it off',
            onPress: () =>
              setEpisodeWatched([ep], !ep.watched)
                .then(() => showToast(ep.watched ? `S${ep.season} E${ep.episode} marked unwatched` : `S${ep.season} E${ep.episode} marked watched`, '✓'))
                .catch(() => showToast("Couldn't save that", '⚠')),
          },
        ],
      });
    },
    [title, playEpisode, saveBest, openSources, setEpisodeWatched, saveEpisodeToPhone],
  );
  // one quality for the whole season (asked once), then each episode in turn
  const saveSeasonToPhone = async (eps: UiEp[]) => {
    let q: string | null = null;
    let stop = false;
    for (const ep of eps) {
      if (!ep.epId) continue;
      await saveOffline(
        {id: ep.epId, title: ep.label, showId: full?.id || item.id, showTitle: title, season: ep.season, episode: ep.episode, year, cover: item.cover || item.poster || null, duration: ep.durationSec, subtitles: ep.subs},
        async options => {
          if (!q) q = await chooseQuality(`${title} · Season ${ep.season}`)(options);
          if (!q) stop = true;
          return q;
        },
      );
      if (stop) break;
    }
  };
  const markSeason = () => {
    if (!season) return;
    const aired = season.episodes.filter(e => e.air === 'aired');
    const all = aired.length > 0 && aired.every(e => e.watched);
    setEpisodeWatched(aired, !all)
      .then(() => showToast(all ? `Season ${season.number} marked unwatched` : `Season ${season.number} marked watched`, '✓'))
      .catch(() => showToast("Couldn't save that", '⚠'));
  };
  const toggleList = async () => {
    const next = !inList;
    setInList(next);
    phoneNative.haptic('confirm');
    try {
      if (stream && !full) {
        const ref: StreamRef = {imdbId: imdb || item.id, type: item.type || 'movie', title, poster: item.cover || item.poster, year, genres: genres.length ? genres : undefined, rating: rating ?? undefined};
        await api.toggleWatchlist(profileId, ref, next);
      } else {
        await api.toggleWatchlist(profileId, full?.id || item.id, next);
      }
      if (next && hhFrom.length) {
        track('feat', {f: 'hhrec-add'});
        householdChanged();
      }
      showToast(next ? LIST_ADDED : 'Removed from My List', '✓');
    } catch {
      setInList(!next);
    }
  };
  const toggleFollow = async () => {
    if (!followImdb) return;
    const next = !following;
    setFollowing(next);
    try {
      const r = await api.follow(profileId, followImdb, next, title);
      if (r.error) throw new Error(r.error);
      patchMe(profileId, {follows: r.follows || []});
      setFollowing((r.follows || []).includes(followImdb));
      showToast(next ? `Following ${title} — new episodes will download by themselves` : `Stopped following ${title}`, next ? '🔔' : '🔕');
    } catch (err) {
      setFollowing(!next);
      showToast((err as Error)?.message || "Couldn't save that", '⚠');
    }
  };
  const hhNotForMe = async () => {
    if (!hhKey) return;
    const undo = hhHidden;
    setHhHidden(!undo);
    try {
      await api.householdDismiss(profileId, hhKey, undo);
      householdChanged();
      if (!undo) showToast(HH.hidden, '✓');
    } catch {
      setHhHidden(undo);
    }
  };
  const share = () => {
    const url = shareLink(getBaseUrl(), {id: full?.id || item.id, imdbId: imdb, type: item.type, source: full ? 'downloaded' : item.source});
    if (!url) return;
    Share.share({message: `${title}${year ? ` (${year})` : ''} on Aurora — ${url}`, url, title}).catch(() => {});
  };

  // ---- the page presses its own Play (Home's billboard: one press from the couch) ----
  const autoT0 = useRef(Date.now());
  const autoDone = useRef(!autoPlay);
  const [, setAutoTick] = useState(0);
  useEffect(() => {
    if (autoDone.current) return;
    const step = autoPlayStep({
      torrentsKnown,
      libraryKnown: libSettled && !loading,
      jobsKnown: jobsRead,
      target: isShow ? !!heroEp : true,
      stateKnown: !isShow || stateRead,
      elapsed: Date.now() - autoT0.current,
    });
    if (step === 'wait') {
      const t = setTimeout(() => setAutoTick(n => n + 1), 400);
      return () => clearTimeout(t);
    }
    autoDone.current = true;
    if (step === 'press') primary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // ---- the one button ----
  const filmJob = jobs.film;
  const primary = () => {
    phoneNative.haptic('tick');
    if (isShow) {
      if (!heroEp) return;
      if (heroEp.owned) playEpisode(heroEp);
      else saveBest(heroEp.season, heroEp.episode, true, heroEp.air);
      return;
    }
    if (ownedMovieId) {
      if (canNavigate(navigation as never)) navigation.push('Player', {id: ownedMovieId, title});
      return;
    }
    if (heroRel) return openSources();
    saveBest(null, null, true);
  };
  const primaryLabel = (() => {
    if (busyKey) return 'Finding the best source…';
    if (isShow) {
      if (!heroEp) return loading ? 'Loading…' : 'No episodes yet';
      if (nextUp?.resume) return `Continue S${heroEp.season} E${heroEp.episode}${nextUp.at ? ` · ${fmtClock(nextUp.at)}` : ''}`;
      return heroEp.owned ? `Play S${heroEp.season} E${heroEp.episode}` : `Save & watch S${heroEp.season} E${heroEp.episode}`;
    }
    if (ownedMovieId) return movieResume ? `Resume ${fmtClock(movieResume)}` : 'Play';
    if (filmJob) return 'Watch while it downloads';
    if (heroRel) return 'See the sources';
    return 'Save & watch';
  })();
  const primaryIcon = isShow ? (heroEp && !heroEp.owned ? 'download' : 'play') : ownedMovieId || filmJob ? 'play' : heroRel ? 'search' : 'download';
  const statusLine = (() => {
    const key = isShow ? heroEp?.key : 'film';
    const job = key ? jobs[key] : null;
    if (job) return {text: job.status === 'pending' ? 'Requested · waiting for approval' : `Downloading · best source · ${Math.round((job.progress || 0) * 100)}%`, tone: 'live' as const, pct: job.progress || 0};
    if (note) return {...note, pct: null};
    if (!isShow && heroRel?.line) return {text: heroRel.line, tone: 'warn' as const, pct: null};
    return null;
  })();
  const primaryStill = isShow && heroEp?.thumb ? artSrc(heroEp.thumb, 80).src : null;

  // ---- more like this ----
  useEffect(() => {
    if (similar !== null || (!imdb && !genres.length && loading)) return;
    let live = true;
    (async () => {
      const selfTitle = libNorm(title);
      const seen = new Set<string>();
      const pool: HeroItem[] = [];
      const take = (items: HeroItem[]) => {
        for (const x of items) {
          const k = x.imdbId || libNorm(x.title);
          if (!k || seen.has(k) || (imdb && x.imdbId === imdb) || libNorm(x.title) === selfTitle) continue;
          seen.add(k);
          pool.push({...x, source: 'stream'});
        }
      };
      try {
        if (imdb) take(((await api.similar(isShow ? 'series' : 'movie', imdb, profileId).catch(() => ({items: [] as HeroItem[]}))).items || []).filter(x => !!x.imdbId && !!x.poster));
        if (pool.length < 4) {
          for (const [i, g] of genres.slice(0, 2).entries()) {
            const r = await api.catalog({type: imdbKind, category: i === 0 ? 'top' : 'trending', genre: g, page: 0}).catch(() => ({items: [] as HeroItem[]}));
            take(r.items || []);
          }
        }
      } catch {}
      if (live) setSimilar(pool.slice(0, 18));
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imdb, genres.length, loading]);

  // ---- draw ----
  // landscape / a tablet: a shorter picture, and the page's body in a readable column
  const wide = width > height && width >= 700;
  const artH = Math.round(wide ? height * 0.62 : Math.min(height * 0.56, width * 1.25));
  const column = wide ? {maxWidth: 820, width: '100%' as const, alignSelf: 'center' as const} : null;
  const facts = [year, fmtDuration(full?.duration) || (meta?.runtime ? String(meta.runtime) : null), isShow && seasons.length ? `${seasons.length} season${seasons.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
  const badges = [full?.certificate || meta?.certificate, resBadge(full?.height, full?.width), full?.subtitles?.length ? 'CC' : null].filter(Boolean) as string[];
  const cast = (meta?.cast || []).slice(0, 6);
  const trailers = meta?.trailers || [];
  const aired = season?.episodes.filter(e => e.air === 'aired') || [];
  const seasonAllWatched = aired.length > 0 && aired.every(e => e.watched);
  return (
    <View style={s.root}>
      <ScrollView ref={scrollRef} contentContainerStyle={{paddingBottom: bottom + 24}} showsVerticalScrollIndicator={false}>
        <View style={{height: artH}}>
          {art ? <Image source={art} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={200} /> : null}
          <View style={s.artFade} pointerEvents="none" />
          <View style={s.lockup}>
            <View style={[s.kicker, {borderColor: isShow ? 'rgba(127,209,232,0.45)' : 'rgba(240,198,126,0.45)'}]}>
              <Text style={[s.kickerText, {color: isShow ? colors.kindSeries : colors.kindFilm}]}>{isShow ? 'SERIES' : 'FILM'}</Text>
            </View>
            <Text style={s.title} numberOfLines={3}>
              {unescapeHtml(title)}
            </Text>
            {typeof rating === 'number' && rating > 0 ? <Text style={s.score}>★ {rating.toFixed(1)}</Text> : null}
            {facts ? <Text style={s.facts}>{facts}</Text> : null}
            {badges.length ? (
              <View style={s.badges}>
                {badges.map(b => (
                  <Text key={b} style={s.badge}>
                    {b}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        </View>

        <View style={[s.body, column]}>
          {loading && !full && !meta ? <ActivityIndicator color={colors.text} style={{marginVertical: 12}} /> : null}
          <PrimaryButton
            testID="phone.detail.play"
            icon={primaryIcon as never}
            label={primaryLabel}
            busy={!!busyKey}
            onPress={primary}
            onLongPress={() => {
              phoneNative.haptic('long');
              if (isShow && heroEp && !heroEp.owned) openSources(heroEp.season, heroEp.episode);
              else if (!isShow && !ownedMovieId) openSources();
            }}
            style={s.primary}
            leading={primaryStill ? <Image source={primaryStill} style={s.primaryStill} /> : null}
          />
          {statusLine ? (
            <View style={s.status}>
              <Text style={[s.statusText, statusLine.tone === 'warn' && {color: '#ffcf8a'}, statusLine.tone === 'ok' && {color: colors.owned}]}>{statusLine.text}</Text>
              {statusLine.pct != null ? <Bar f={statusLine.pct} bead={false} style={{marginTop: 6}} /> : null}
            </View>
          ) : null}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.actions}>
            {tvs.length && (ownedMovieId || heroEp?.owned) ? <ActionCircle icon="cast" label={tvs.length === 1 ? `Play on ${tvs[0].name}` : 'Play on TV'} onPress={playOnTv} /> : null}
            {!isShow && !ownedMovieId && imdb ? <ActionCircle icon="play" label="Stream instead" onPress={() => openSources()} /> : null}
            {ownedMovieId ? (
              <ActionCircle
                icon="downloadDevice"
                label={phoneState(ownedMovieId) === 'done' ? 'On this phone' : phoneState(ownedMovieId) ? 'Saving…' : 'Save to phone'}
                on={phoneState(ownedMovieId) === 'done'}
                onPress={saveFilmToPhone}
              />
            ) : null}
            {ownedMovieId && movieResume ? <ActionCircle icon="refresh" label="Start over" onPress={() => navigation.push('Player', {id: ownedMovieId, title, restart: true})} /> : null}
            {isShow ? <ActionCircle icon="series" label="All episodes" onPress={() => scrollRef.current?.scrollTo({y: artH + 160, animated: true})} /> : null}
            <ActionCircle icon={inList ? 'check' : 'plus'} label="My List" on={inList} onPress={toggleList} />
            <ActionCircle icon="send" label="Recommend" onPress={() => openRecommend(item, imdb)} />
            {isShow && followImdb ? <ActionCircle icon={following ? 'check' : 'bell'} label={following ? 'Following' : 'Follow'} on={following} onPress={toggleFollow} /> : null}
            {imdb || full ? (
              <ActionCircle
                icon="xray"
                label="X-Ray"
                onPress={() => openXray({query: full && !isShow ? {itemId: full.id} : {type: isShow ? 'series' : 'movie', imdbId: imdb}, title})}
              />
            ) : null}
            {ownedMovieId ? <ActionCircle icon="check" label={movieWatched ? 'Watched' : 'Mark watched'} on={movieWatched} onPress={toggleMovieWatched} /> : null}
            {trailers.length || imdb ? <ActionCircle icon="film" label="Trailer" onPress={() => openTrailer(trailers, title, {imdbId: imdb, type: isShow ? 'show' : 'movie', year})} /> : null}
            <ActionCircle icon="share" label="Share" onPress={share} />
          </ScrollView>

          {hhFrom.length && !hhHidden ? (
            <View style={s.hh}>
              <Text style={s.hhLine}>{bannerLine(hhFrom)}</Text>
              {notesOf(hhFrom).map(n => (
                <Text key={n} style={s.hhNote}>
                  {n}
                </Text>
              ))}
              <Tap flat onPress={hhNotForMe} style={{alignSelf: 'flex-start', marginTop: 6}}>
                <Text style={s.link}>{HH.notForMe}</Text>
              </Tap>
            </View>
          ) : null}

          {synopsis ? (
            <Tap flat onPress={() => setMoreText(m => !m)} style={s.synopsisBox} accessibilityLabel={synopsis}>
              <Text style={s.synopsis} numberOfLines={moreText ? undefined : 3}>
                {synopsis}
              </Text>
              {synopsis.length > 140 ? <Text style={s.more}>{moreText ? 'Less' : 'More'}</Text> : null}
            </Tap>
          ) : null}
          {genres.length ? <Text style={s.line}>{genres.join(' · ')}</Text> : null}
          {cast.length ? (
            <Text style={s.line}>
              <Text style={s.lineKey}>Cast </Text>
              {cast.map(unescapeHtml).join(' · ')}
            </Text>
          ) : null}
          {meta?.director ? (
            <Text style={s.line}>
              <Text style={s.lineKey}>Director </Text>
              {unescapeHtml(meta.director)}
            </Text>
          ) : null}
        </View>

        {isShow && seasons.length ? (
          <View style={[s.episodes, column]}>
            <Text style={s.h2}>Episodes</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.pills}>
              {seasons.map(se => (
                <ChipButton key={se.number} label={`Season ${se.number}`} active={se.number === seasonNo} onPress={() => setSeasonPick(se.number)} />
              ))}
              {season && season.episodes.some(e => e.owned && !e.phone) ? (
                <ChipButton
                  label={`Save season offline (${season.episodes.filter(e => e.owned && !e.phone).length})`}
                  icon="downloadDevice"
                  onPress={() => saveSeasonToPhone(season.episodes.filter(e => e.owned && !e.phone))}
                />
              ) : null}
              {aired.length ? <ChipButton label={seasonAllWatched ? 'Mark season unwatched' : 'Mark season watched'} icon="check" onPress={markSeason} /> : null}
            </ScrollView>
            {(season?.episodes || []).map(ep => (
              <EpisodeRow key={ep.key} ep={ep} onPress={onEpisode} onLong={episodeActions} />
            ))}
          </View>
        ) : null}

        {similar && similar.length ? (
          <View style={{marginTop: 26}}>
            <Text style={[s.h2, {paddingHorizontal: GUTTER}]}>More like this</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.shelf}>
              {similar.map((x, i) => (
                <PosterCard key={`${x.imdbId || x.id}-${i}`} item={x} onPress={it => navigation.push('Detail', {item: it})} />
              ))}
            </ScrollView>
          </View>
        ) : null}
      </ScrollView>
      <View style={[s.topFade, {height: insets.top + 64}]} pointerEvents="none" />
      <BackBar />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  artFade: {
    ...StyleSheet.absoluteFill,
    experimental_backgroundImage: 'linear-gradient(180deg, rgba(8,9,16,0.45) 0%, rgba(8,9,16,0) 25%, rgba(8,9,16,0.1) 45%, rgba(8,9,16,0.85) 82%, rgba(8,9,16,1) 100%)',
  },
  topFade: {position: 'absolute', top: 0, left: 0, right: 0, experimental_backgroundImage: 'linear-gradient(180deg, rgba(8,9,16,0.55), rgba(8,9,16,0))'},
  lockup: {position: 'absolute', left: GUTTER, right: GUTTER, bottom: 14},
  kicker: {alignSelf: 'flex-start', paddingHorizontal: 12, height: 28, borderRadius: 14, borderWidth: 1, backgroundColor: 'rgba(8,9,16,0.4)', justifyContent: 'center', marginBottom: 10},
  kickerText: {fontSize: 12, fontWeight: '900', letterSpacing: 1.5},
  title: {color: '#fff', fontSize: 32, fontWeight: '900', letterSpacing: -0.4, lineHeight: 36},
  score: {color: colors.star, fontSize: 16, fontWeight: '800', marginTop: 10},
  facts: {color: 'rgba(255,255,255,0.88)', fontSize: 16, fontWeight: '600', marginTop: 6},
  badges: {flexDirection: 'row', gap: 6, marginTop: 8},
  badge: {color: colors.text, fontSize: 12, fontWeight: '800', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1},
  body: {paddingHorizontal: GUTTER, paddingTop: 6},
  primary: {height: 56, marginTop: 6},
  primaryStill: {width: 64, height: 36, borderRadius: 6, marginRight: 2},
  status: {marginTop: 10},
  statusText: {color: colors.textDim, fontSize: 14, fontWeight: '600'},
  actions: {gap: 6, paddingVertical: 18},
  hh: {padding: 14, borderRadius: radius.l, backgroundColor: 'rgba(139,123,255,0.12)', borderWidth: 1, borderColor: 'rgba(139,123,255,0.35)', marginBottom: 12},
  hhLine: {color: colors.text, fontSize: 15, fontWeight: '800'},
  hhNote: {color: colors.textDim, fontSize: 14, marginTop: 4, fontStyle: 'italic'},
  link: {color: colors.accent, fontSize: 14, fontWeight: '700'},
  synopsisBox: {paddingVertical: 4},
  synopsis: {color: colors.text, fontSize: 16, lineHeight: 24},
  more: {color: colors.text, fontSize: 15, fontWeight: '800', marginTop: 6},
  line: {color: colors.text, fontSize: 15, lineHeight: 22, marginTop: 10},
  lineKey: {color: colors.textDim, fontWeight: '700'},
  episodes: {marginTop: 26},
  h2: {color: colors.text, fontSize: 20, fontWeight: '800', paddingHorizontal: GUTTER},
  pills: {paddingHorizontal: GUTTER, paddingVertical: 12, gap: 8},
  ep: {
    flexDirection: 'row',
    gap: 12,
    marginHorizontal: GUTTER,
    marginBottom: 10,
    padding: 8,
    borderRadius: radius.l,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: 'rgba(226,229,238,0.18)',
  },
  epOwned: {backgroundColor: 'rgba(80,200,150,0.10)', borderColor: 'rgba(111,224,176,0.32)'},
  epNext: {borderColor: 'rgba(139,123,255,0.6)'},
  epStill: {width: 136, height: 77, borderRadius: radius.s, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center'},
  epBar: {position: 'absolute', left: 6, right: 6, bottom: 5},
  epDl: {position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(8,9,16,0.75)', paddingVertical: 2},
  epDlText: {color: colors.owned, fontSize: 10, fontWeight: '900', textAlign: 'center', letterSpacing: 0.5},
  epBody: {flex: 1, justifyContent: 'center'},
  epKicker: {color: colors.textDim, fontSize: 11, fontWeight: '900', letterSpacing: 1},
  epTitle: {color: colors.text, fontSize: 16, fontWeight: '800', marginTop: 2},
  epFoot: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4},
  epFootText: {color: colors.textDim, fontSize: 13, flexShrink: 1},
  cc: {color: colors.textDim, fontSize: 10, fontWeight: '900', borderWidth: 1, borderColor: colors.textFaint, borderRadius: 3, paddingHorizontal: 3},
  shelf: {paddingHorizontal: GUTTER, gap: 8, paddingTop: 12},
});
