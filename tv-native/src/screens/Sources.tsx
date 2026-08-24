// Torrent sources for a title/episode. The server already ranks these (BEST,
// CAM and dubbed flags, quality, seeders) and caps the list — we just render
// them. Selecting one builds a torrent play-item and hands it to the Player
// (ExoPlayer streams /stream/torrent/… directly; hardware decode = no server
// transcode). A secondary action requests a download-to-server.
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Image, StyleSheet, ActivityIndicator, FlatList} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Focusable from '../components/Focusable';
import Icon from '../components/Icon';
import Svg, {Circle} from 'react-native-svg';
import {api, imgSrc, DownloadJob, Stream, TorrentPlayItem} from '../api';
import {canNavigate} from '../navLock';
import {useApp} from '../AppContext';
import {RootStackParamList} from '../navigation';
import theme from '../theme';

const {colors, radius, fontSize, spacing} = theme;

// The same two ramps the detail page uses (tools/gen_side_scrim.py). Sources is
// reached FROM a page made of artwork, and landing on a flat black list loses
// the thread of what you are choosing for.
const HERO_SIDE = require('../assets/hero-side.png');
const HERO_VEIL = require('../assets/ambient-veil-tall.png');

// Ported from the browser client (screens/discover-detail.js). The server
// already tags each source; these are the tags that mean "this device will not
// play it as-is", so the remux is chosen up front instead of after ExoPlayer
// walks into a passthrough AudioTrack failure and recovers from it.
const VIDEO_TRANSCODE_TAGS = ['H.265', 'AV1'];
const AUDIO_TRANSCODE_TAGS = ['DTS', 'DTS-HD', 'TrueHD', 'Atmos', 'DD+'];

// Cinemeta runtime ("152 min", "1h 52min") -> seconds. A torrent is still
// downloading, so ExoPlayer can derive no duration; this is what gives the
// scrubber a real total length instead of leaving it dead.
const runtimeToSeconds = (runtime?: string | number | null): number => {
  if (!runtime) return 0;
  const str = String(runtime);
  const h = str.match(/(\d+)\s*h/i);
  const m = str.match(/(\d+)\s*m/i);
  if (h || m) return ((h ? +h[1] : 0) * 60 + (m ? +m[1] : 0)) * 60;
  const n = parseInt(str, 10);
  return isNaN(n) ? 0 : n * 60; // a bare number is minutes
};

// What a source's download button shows, ported from the browser client's
// dlFace(). Each state is a different question the viewer is asking, so they get
// different answers rather than one perpetual hourglass.
type DlFace = {face: string; pct: number | null; hint: string};
const dlFace = (job?: DownloadJob): DlFace => {
  switch (job?.status) {
    case 'done':
      return {face: '✓', pct: null, hint: 'In your library — plays instantly'};
    case 'pending':
      return {
        face: '⏳',
        pct: null,
        hint: 'Waiting for admin approval (the server is low on disk)',
      };
    case 'approved':
      return {
        face: '⋯',
        pct: null,
        hint: 'Queued — starts when the current downloads finish',
      };
    case 'downloading': {
      // Before any bytes move the engine is still locating the file, and "0%"
      // there reads as a download that isn't working.
      if (job.phase === 'finding') {
        return {face: '⋯', pct: null, hint: 'Finding the file on the network…'};
      }
      if (job.phase === 'copying') {
        const c = job.copyProgress != null ? Math.round(job.copyProgress * 100) : null;
        return {
          face: '→',
          pct: c ?? 100,
          hint: `Saving to your library${c != null ? ` — ${c}%` : ''}`,
        };
      }
      const pct = Math.round((job.progress || 0) * 100);
      return {
        face: String(pct),
        pct,
        hint:
          `Downloading — ${pct}%` +
          (job.downloadSpeed ? ` at ${(job.downloadSpeed / 1e6).toFixed(1)} MB/s` : ''),
      };
    }
    case 'error':
      return {
        face: '!',
        pct: null,
        hint: job.error || 'The download failed — press to try again',
      };
    default:
      return {
        face: '',
        pct: null,
        hint: 'Download for better playback (will take more time)',
      };
  }
};

const DL_ACTIVE = ['pending', 'approved', 'downloading'];

// The badge a row carries once it has a job. This is the whole point of the
// rework on the site: a downloaded episode used to look exactly like the forty
// torrents around it, so people re-streamed what they already had.
const DL_BADGE: Record<string, {text: string; owned?: boolean}> = {
  done: {text: '✓ DOWNLOADED', owned: true},
  downloading: {text: '⬇ DOWNLOADING'},
  approved: {text: '⏳ QUEUED'},
  pending: {text: '⏳ NEEDS APPROVAL'},
};

const dlKey = (infoHash: string, fileIdx: number) => `${infoHash}:${fileIdx}`;

// #4ade80 — the site's "this is yours" green.
const OWNED = '#4ade80';

// .dl-ring — the live progress ring around the download button's percentage.
// The site draws it with a conic-gradient masked into a ring; RN has neither, so
// this is an SVG circle with a dash offset, which is the same picture.
function DlRing({pct}: {pct: number}) {
  const R = 19;
  const C = 2 * Math.PI * R;
  const done = Math.max(0, Math.min(100, pct)) / 100;
  return (
    <Svg width={44} height={44} style={styles.dlRing}>
      <Circle cx={22} cy={22} r={R} stroke="rgba(255,255,255,0.14)" strokeWidth={4} fill="none" />
      <Circle
        cx={22}
        cy={22}
        r={R}
        stroke={colors.accent}
        strokeWidth={4}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${C * done} ${C}`}
        // Start the sweep at 12 o'clock rather than 3, like the conic-gradient.
        transform="rotate(-90 22 22)"
      />
    </Svg>
  );
}

const QUALITY_COLOR: Record<string, string> = {
  '2160p': '#c084fc',
  '1080p': '#60a5fa',
  '720p': '#34d399',
  '480p': '#fbbf24',
  SD: '#9aa1b5',
};

// The sources list, as a COMPONENT rather than a screen.
//
// It was only ever a screen because it was written as one; nothing in here needs
// a route. Detail now renders it in a panel beside the title (a whole page for
// one list is a waste of a 960dp screen), and the screen below is a nine-line
// wrapper that keeps the old route working for anything still pushing it.
export type SourcesPanelProps = {
  type: 'movie' | 'series';
  imdbId: string;
  title: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  runtime?: string | number | null;
  poster?: string | null;
  onPlay: (item: TorrentPlayItem) => void;
  onBack: () => void;
  // The copy already IN THE LIBRARY for this title/episode, when the host page
  // has resolved one (Detail ports the site's findInLibrary). Two things hang
  // off it, both straight from the browser client (discover-detail.js):
  //   • an "owned" row pinned above every torrent — your copy, plays instantly;
  //   • any torrent row whose download job is done PLAYS THE LIBRARY FILE
  //     instead of re-streaming the torrent. That redirect is the whole point
  //     of having downloaded it, and its absence here is why the TV kept
  //     streaming things the server already had on disk.
  owned?: {id: string; label?: string} | null;
  // How the host plays a library item (a plain Player push by library id).
  // Without it the owned row is not drawn and done-rows keep torrent playback —
  // the pre-rework behaviour, kept for any caller that cannot resolve a copy.
  onPlayLibrary?: (id: string) => void;
  // A download just finished (or the server said the title is already in the
  // library): the host should re-resolve `owned`, so the new copy is offered
  // without leaving the page. Mirrors the site's download_update → loadLibrary.
  onOwnershipChange?: () => void;
  // Drawn inside another screen: no full-bleed artwork of its own, no page
  // margins, and the Back row is dropped because the host owns dismissal.
  embedded?: boolean;
};

export function SourcesPanel({
  type,
  imdbId,
  title,
  year,
  season,
  episode,
  runtime,
  poster,
  onPlay,
  onBack,
  owned,
  onPlayLibrary,
  onOwnershipChange,
  embedded,
}: SourcesPanelProps) {
  const {profileId} = useApp();
  const [streams, setStreams] = useState<Stream[] | null>(null);
  // infoHash:fileIdx -> newest job for that exact source.
  const [jobs, setJobs] = useState<Map<string, DownloadJob>>(new Map());
  // Last poll's jobs, for spotting status TRANSITIONS (see the poll below).
  const prevJobs = useRef<Map<string, DownloadJob>>(new Map());
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const mounted = useRef(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read through a ref by the poll below — the poll effect mounts once, and a
  // caller is allowed to hand in a new callback identity per render.
  const ownershipCb = useRef(onOwnershipChange);
  ownershipCb.current = onOwnershipChange;
  // The current source list, for the poll (it mounts once, before sources land).
  const streamsRef = useRef<Stream[] | null>(null);
  // Lets requestDownload restart a poll chain that has gone idle.
  const pullRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    // Re-set on mount, not just cleared on unmount: StrictMode mounts, cleans
    // up and remounts, and a one-way flag would leave every toast a no-op.
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    let live = true;
    api
      .torrentSources({type, title: imdbId, year, season, episode})
      .then(r => {
        if (!live) return;
        // Drop dead torrents when seeder counts are present (mirrors web).
        let s = r.streams || [];
        if (s.some(x => x.seeders > 0)) s = s.filter(x => x.seeders > 0);
        streamsRef.current = s;
        setStreams(s);
      })
      .catch(() => live && setError('Could not reach the source provider.'));
    return () => {
      live = false;
    };
  }, [type, imdbId, year, season, episode]);

  // Download states for these sources. The site fetches them once on load and
  // then repaints from a WebSocket; the TV has no socket client, so it polls —
  // but only while something is actually in flight, so a settled list costs one
  // request and then nothing. requestDownload restarts an idle chain through
  // pullRef — without that, pressing SAVE on a quiet panel started a download
  // the UI never showed (no badge, no ring, no completion), because the one
  // mount-time pull had already found nothing active and stopped for good.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wasActive = false;
    const schedule = (ms: number) => {
      if (!live) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(pull, ms);
    };
    const pull = async () => {
      try {
        const list = await api.downloads();
        if (!live) return;
        const map = new Map<string, DownloadJob>();
        // Newest first from the server; keep the newest job per source.
        for (const j of list) {
          const k = dlKey(j.infoHash, j.fileIdx);
          if (!map.has(k)) map.set(k, j);
        }
        // Announce a job that JUST finished. Without this a download completed in
        // silence: the row restyled itself green only if you happened to be
        // looking, and nothing told you otherwise. The site gets this from its
        // WebSocket feed; the TV compares consecutive polls.
        //
        // ONLY for jobs that belong to THIS panel's sources — /api/downloads is
        // server-wide, and someone else's finishing episode must not flash
        // "saved to your library" over an unrelated film (nor refetch the host
        // page's library resolution for nothing).
        //
        // The comparison reads a REF, not the state updater — an updater has to
        // be pure, and firing a toast from inside one would run twice under
        // StrictMode and announce every completion in duplicate.
        const mine = streamsRef.current
          ? new Set(streamsRef.current.map(s => dlKey(s.infoHash, s.fileIdx)))
          : null;
        for (const [k, j] of map) {
          if (mine && !mine.has(k)) continue;
          const was = prevJobs.current.get(k)?.status;
          if (was && was !== j.status) {
            if (j.status === 'done') {
              flashToast('Saved to your library — it plays instantly now');
              // The library has a new file: let the host re-resolve `owned` so
              // the finished download is offered as the copy it now is (the
              // site's download_update → loadLibrary re-render).
              ownershipCb.current?.();
            } else if (j.status === 'error') {
              flashToast(j.error || 'That download failed');
            }
          }
        }
        prevJobs.current = map;
        setJobs(map);
        wasActive = [...map.values()].some(j => DL_ACTIVE.includes(j.status));
        if (wasActive) schedule(3000);
      } catch {
        // One transient failure must not end the chain for good — a download
        // that was mid-flight keeps being watched, just at a gentler pace.
        if (wasActive) schedule(5000);
      }
    };
    // The restart hook pulls twice: once now, once shortly after — a job POSTed
    // a moment ago may not be listed on the immediate pull yet, and one empty
    // pull would end the chain again (the exact bug this restart exists for).
    pullRef.current = () => {
      pull();
      setTimeout(() => {
        if (live) pull();
      }, 3000);
    };
    pull();
    return () => {
      live = false;
      pullRef.current = null;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Anything already downloaded floats to the top, then anything in flight —
  // the same ordering the site applies. Everything else keeps the server's rank.
  // De-duplicated by infoHash:fileIdx first: that pair IS the row's identity
  // (the FlatList keys on it), and a provider occasionally lists the same file
  // twice.
  const ordered = useMemo(() => {
    if (!streams) return null;
    const seen = new Set<string>();
    const uniq = streams.filter(s => {
      const k = dlKey(s.infoHash, s.fileIdx);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const weight = (st?: string) => (st === 'done' ? 0 : st && DL_ACTIVE.includes(st) ? 1 : 2);
    return uniq
      .map((st, i) => ({st, i}))
      .sort((a, b) => {
        const wa = weight(jobs.get(dlKey(a.st.infoHash, a.st.fileIdx))?.status);
        const wb = weight(jobs.get(dlKey(b.st.infoHash, b.st.fileIdx))?.status);
        return wa - wb || a.i - b.i;
      })
      .map(x => x.st);
  }, [streams, jobs]);

  const play = (s: Stream) => {
    // A source that is already downloaded plays the LIBRARY file, not the
    // torrent: the whole point of having downloaded it is that it starts
    // instantly and seeks anywhere. Streaming it again would be the confusing
    // option — and it is exactly what this used to do. Same conjunction as the
    // site (discover-detail.js): a done job with no resolved library copy still
    // falls through to torrent playback rather than erroring.
    const job = jobs.get(dlKey(s.infoHash, s.fileIdx));
    if (job?.status === 'done' && owned && onPlayLibrary) {
      onPlayLibrary(owned.id);
      return;
    }
    const tags = s.tags || [];
    const needsVideo = tags.some(t => VIDEO_TRANSCODE_TAGS.includes(t));
    const needsAudio = tags.some(t => AUDIO_TRANSCODE_TAGS.includes(t));
    const item: TorrentPlayItem = {
      id: `torrent|${s.infoHash}|${s.fileIdx}`,
      title,
      videoUrl: `/stream/torrent/${s.infoHash}/${s.fileIdx}`,
      transcodeBase: `/stream/torrent/hls/${s.infoHash}/${s.fileIdx}`,
      infoHash: s.infoHash,
      fileIdx: s.fileIdx,
      isTorrent: true,
      type: type === 'series' ? 'show' : 'movie',
      imdbId,
      season: season || undefined,
      episode: episode || undefined,
      // The same three decisions the browser client makes when it builds a play
      // item: whether the remux is needed, which flavour, and the true runtime.
      needsTranscode: needsVideo || needsAudio,
      transcodeV: needsVideo ? 'h264' : 'copy',
      duration: runtimeToSeconds(runtime),
      // Card metadata, so the Continue Watching entry the player saves has a
      // poster and a year rather than being a blank tile (see TorrentPlayItem).
      year: year ?? null,
      cover: poster ?? null,
      quality: s.quality,
    };
    onPlay(item);
  };

  const flashToast = (msg: string) => {
    if (!mounted.current) return;
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => mounted.current && setToast(''), 4000);
  };

  const requestDownload = async (s: Stream) => {
    setToast('Requesting…');
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
      // Same wording the browser client uses for these outcomes.
      flashToast(
        res.alreadyAvailable
          ? "Already yours — it's in the library"
          : res.duplicate
          ? 'Already queued. Patience.'
          : res.needsApproval
          ? 'Download requested — the server is low on space, so it needs admin approval.'
          : 'Downloading now! Go grab some popcorn.',
      );
      // The server just said the library already holds this title — make the
      // host resolve that copy so the owned row appears right away.
      if (res.alreadyAvailable) ownershipCb.current?.();
      // A new job exists (or a duplicate is in flight): restart the poll chain
      // so its badge, ring and completion actually show up.
      pullRef.current?.();
    } catch {
      flashToast("Couldn't request the download");
    }
  };

  // Whether the pinned copy-row is drawn — it wins the first focus when it is.
  const hasOwnedRow = !!(owned && onPlayLibrary);
  // The focus CLAIM is latched once, when there is first something to show
  // (owned known, or the source list landed). An owned row that appears LATER —
  // a download finished mid-session and the host resolved the copy — must not
  // yank focus from wherever the viewer is in the list.
  const claimOwned = useRef<boolean | null>(null);
  if (claimOwned.current === null && (hasOwnedRow || streams)) {
    claimOwned.current = hasOwnedRow;
  }
  // The stream row that claims first focus, latched by IDENTITY, not position:
  // `ordered` re-sorts when a job completes, and handing the claim to
  // "whatever is index 0 now" flips hasTVPreferredFocus true on an
  // already-mounted row — which Fabric honours, yanking focus mid-list.
  const firstClaimKey = useRef<string | null>(null);
  if (firstClaimKey.current === null && ordered && ordered.length) {
    firstClaimKey.current = dlKey(ordered[0].infoHash, ordered[0].fileIdx);
  }

  const renderStream = useCallback(
    ({item: s}: {item: Stream}) => {
      const qColor = QUALITY_COLOR[s.quality] || QUALITY_COLOR.SD;
      const seedColor = s.seeders >= 30 ? '#34d399' : s.seeders >= 5 ? '#fbbf24' : '#9aa1b5';
      const job = jobs.get(dlKey(s.infoHash, s.fileIdx));
      const badge = job ? DL_BADGE[job.status] : undefined;
      const isDone = job?.status === 'done';
      // "Done" restyles the row green either way, but it only PLAYS the copy
      // when the host resolved one — the same conjunction play() applies.
      const playsCopy = isDone && !!owned && !!onPlayLibrary;
      const {face, pct, hint} = dlFace(job);
      // The site puts these in a hover tooltip; a remote has no hover, so a row
      // with a live job says what is happening in its own meta line instead —
      // "Downloading — 47% at 3.2 MB/s", "Queued — starts when the current
      // downloads finish". Seeders stop being the story once a job owns the row.
      const jobLine = job && !isDone ? hint : null;
      return (
        <View style={styles.rowWrap}>
          {/* noScale: this row spans the screen, so a 4% scale grows it by ~60dp
              and half of that lands on the download button beside it. */}
          <Focusable
            scaleTo={1.01}
            hasTVPreferredFocus={
              claimOwned.current !== true &&
              dlKey(s.infoHash, s.fileIdx) === firstClaimKey.current
            }
            onPress={() => play(s)}
            style={[styles.row, isDone && styles.rowOwned]}
            highlightColor={colors.surfaceHover}>
            {/* .source-quality.owned-chip — the quality pill turns green once the
                file is actually yours. */}
            <View
              style={[
                styles.qBadge,
                {borderColor: isDone ? OWNED : qColor},
                isDone && styles.qBadgeOwned,
              ]}>
              <Text style={[styles.qText, {color: isDone ? OWNED : qColor}]}>
                {s.quality}
              </Text>
            </View>
            <View style={styles.info}>
              <View style={styles.titleLine}>
                <Text style={styles.release} numberOfLines={1}>
                  {s.release || s.filename}
                </Text>
                {/* The badges hold their ground and the NAME ellipsizes — the
                    site had to fix exactly this, where a long release name cut
                    "✓ DOWNLOADED · ★ BEST" off the end of the row. */}
                {badge ? (
                  <Text style={badge.owned ? styles.ownedTag : styles.gettingTag}>
                    {badge.text}
                  </Text>
                ) : null}
                {s.recommended ? <Text style={styles.best}>★ BEST</Text> : null}
                {s.cam ? <Text style={styles.cam}>CAM</Text> : null}
                {s.dubbed ? <Text style={styles.dub}>DUB</Text> : null}
              </View>
              <View style={styles.metaLine}>
                {playsCopy ? (
                  // A downloaded source plays off the disk, so seeders and swarm
                  // health stopped being the story for this row (.owned-note).
                  <Text style={styles.ownedNote}>Plays your copy · instant</Text>
                ) : jobLine ? (
                  <Text
                    style={job?.status === 'error' ? styles.jobLineFailed : styles.jobLine}
                    numberOfLines={1}>
                    {jobLine}
                  </Text>
                ) : (
                  <Text style={[styles.seeds, {color: seedColor}]}>● {s.seeders}</Text>
                )}
                {s.sizeString ? <Text style={styles.meta}>{s.sizeString}</Text> : null}
                {jobLine || playsCopy ? null : (
                  <>
                    {s.languages?.length ? (
                      <Text style={styles.meta}>{s.languages.join(' · ')}</Text>
                    ) : null}
                    {s.provider ? <Text style={styles.meta}>{s.provider}</Text> : null}
                  </>
                )}
              </View>
            </View>
            <Icon name="play" size={22} color={colors.text} />
          </Focusable>
          {/* A finished download is nothing to press; anything else can be
              (re)requested, including a failed one. */}
          <Focusable
            scaleTo={1.03}
            onPress={() => !isDone && requestDownload(s)}
            style={[
              styles.dlBtn,
              // .source-dl.done / .source-dl.failed — the whole button reports
              // the outcome, not just the glyph inside it.
              isDone && styles.dlBtnDone,
              job?.status === 'error' && styles.dlBtnFailed,
            ]}
            highlightColor={colors.surfaceHover}>
            {pct != null ? <DlRing pct={pct} /> : null}
            {face ? (
              <Text
                style={[
                  styles.dlFace,
                  pct != null && styles.dlFaceSmall,
                  isDone && styles.dlFaceOwned,
                  job?.status === 'error' && styles.dlFaceFailed,
                ]}>
                {face}
              </Text>
            ) : (
              // Icon PLUS a word. On the site this button explains itself with a
              // hover tooltip ("Download for better playback"); a remote has no
              // hover, so an unlabelled glyph in a dark box read as an empty
              // panel and the download option looked like it wasn't there.
              <>
                <Icon name="download" size={24} color={colors.text} />
                <Text style={styles.dlCaption}>SAVE</Text>
              </>
            )}
          </Focusable>
        </View>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [type, imdbId, title, year, season, episode, runtime, poster, profileId, jobs, owned, onPlayLibrary, onPlay],
  );

  const art = imgSrc(poster);
  const count = ordered?.length || 0;
  // Drawn only when it can actually be played — `owned` without a play route
  // would be a row that does nothing.
  const ownedRow = owned && onPlayLibrary ? owned : null;

  return (
    <View style={embedded ? styles.rootEmbedded : styles.root}>
      {/* The title's own artwork, heavily softened — this is a list screen, so
          the art is atmosphere rather than subject, but losing it entirely made
          Sources feel like a different application. Embedded, the host page
          already has the artwork and a second copy would double-darken it. */}
      {art && !embedded ? (
        <Image
          source={art}
          style={styles.art}
          resizeMode="cover"
          resizeMethod="resize"
          fadeDuration={0}
          blurRadius={32}
        />
      ) : null}
      {embedded ? null : (
        <>
          <View style={styles.artDim} />
          <Image source={HERO_SIDE} style={styles.artSide} resizeMode="stretch" />
          <Image source={HERO_VEIL} style={styles.artVeil} resizeMode="stretch" />
        </>
      )}

      <View style={embedded ? styles.pageEmbedded : styles.page}>
        <View style={styles.headRow}>
          {art ? (
            <Image source={art} style={styles.headPoster} resizeMode="cover" fadeDuration={0} />
          ) : null}
          <View style={styles.headText}>
            <Text style={styles.heading} numberOfLines={1}>
              {title}
              {season ? `  ·  S${season} E${episode}` : ''}
            </Text>
            <Text style={styles.sub}>
              {count
                ? `${count} source${count === 1 ? '' : 's'} — ★ is the best pick`
                : 'Choose a source — ★ is the best pick'}
            </Text>
          </View>
          <Focusable
            round
            hasTVPreferredFocus={(!streams || streams.length === 0) && !ownedRow}
            onPress={onBack}
            style={styles.back}>
            <Text style={styles.backText}>‹ Back</Text>
          </Focusable>
        </View>
        {toast ? <Text style={styles.toast}>{toast}</Text> : null}

      {/* The copy already on disk — pinned ABOVE every torrent and OUTSIDE the
          scrolling list, so it can never be sorted away or scrolled past
          (discover-detail.js's ownedRow, drawn for the same reason). It renders
          even while sources are still loading: your copy can play right now. */}
      {ownedRow ? (
        <View style={styles.ownedRowWrap}>
          <Focusable
            scaleTo={1.01}
            hasTVPreferredFocus={claimOwned.current === true}
            onPress={() => onPlayLibrary!(ownedRow.id)}
            style={[styles.row, styles.rowOwned]}
            highlightColor={colors.surfaceHover}>
            <View style={[styles.qBadge, {borderColor: OWNED}, styles.qBadgeOwned]}>
              <Text style={[styles.qText, {color: OWNED}]}>YOURS</Text>
            </View>
            <View style={styles.info}>
              <View style={styles.titleLine}>
                <Text style={styles.release} numberOfLines={1}>
                  {ownedRow.label || 'Your downloaded copy'}
                </Text>
                <Text style={styles.ownedTag}>✓ DOWNLOADED</Text>
              </View>
              <View style={styles.metaLine}>
                <Text style={styles.ownedNote}>
                  Starts instantly · seek anywhere · full quality
                </Text>
              </View>
            </View>
            <Icon name="play" size={22} color={colors.text} />
          </Focusable>
        </View>
      ) : null}

      {!streams && !error ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.text} size="large" />
          <Text style={styles.finding}>Finding sources…</Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {streams && streams.length === 0 ? (
        <Text style={styles.error}>No sources with active peers.</Text>
      ) : null}

      {/* FlatList (not ScrollView): Android TV scrolls the focused row into
          view natively for lists, so D-pad movement and the viewport never
          drift apart on long source lists. */}
      <FlatList
        data={ordered || []}
        // The source's own identity, WITHOUT the index. `ordered` re-sorts when
        // a job's status changes; with the index in the key, one status
        // transition changed the key of every row below it, so FlatList
        // remounted them all — dropping focus and scroll position mid-list.
        keyExtractor={s => dlKey(s.infoHash, s.fileIdx)}
        style={styles.listFill}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        renderItem={renderStream}
      />
      </View>
    </View>
  );
}

// The route wrapper. Detail renders the panel inline now, but the screen stays
// so deep links and anything still pushing 'Sources' keep working.
export default function Sources({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParamList, 'Sources'>) {
  return (
    <SourcesPanel
      {...route.params}
      onPlay={item =>
        navigation.push('Player', {id: item.id, title: route.params.title, stream: item})
      }
      // The route carries no library resolution (`owned` stays unset), but the
      // play route is wired so a host that ever adds one gets the redirect.
      onPlayLibrary={id =>
        canNavigate(navigation) && navigation.push('Player', {id, title: route.params.title})
      }
      onBack={() => canNavigate(navigation) && navigation.goBack()}
    />
  );
}

const styles = StyleSheet.create({
  // No backgroundColor: android:windowBackground already paints it, and painting
  // it again cost a second full-screen fill every frame.
  rootEmbedded: {flex: 1},
  pageEmbedded: {flex: 1, paddingTop: 0, paddingHorizontal: 0},
  root: {flex: 1},
  art: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%'},
  artDim: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(6,7,14,0.72)'},
  artSide: {position: 'absolute', top: 0, left: 0, bottom: 0, width: '78%', height: '100%'},
  artVeil: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%'},
  page: {flex: 1, paddingHorizontal: spacing.pageX, paddingTop: 34, paddingBottom: spacing.md},
  // Poster, title + count, then Back pushed to the right. Back sat first before,
  // which put the one control you rarely want under the first press.
  headRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md},
  headPoster: {width: 46, aspectRatio: 2 / 3, borderRadius: radius.s, flexShrink: 0},
  headText: {flex: 1, minWidth: 0},
  back: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 8,
    paddingHorizontal: 18,
    flexShrink: 0,
  },
  backText: {color: colors.text, fontSize: fontSize.small, fontWeight: '700'},
  heading: {color: colors.text, fontSize: fontSize.title, fontWeight: '900'},
  sub: {color: colors.textDim, fontSize: fontSize.small, fontWeight: '600', marginTop: 2},
  toast: {color: colors.accent, fontSize: fontSize.body, fontWeight: '700', marginBottom: spacing.sm},
  center: {alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: spacing.md},
  finding: {color: colors.textDim, fontSize: fontSize.body},
  error: {color: '#ff8080', fontSize: fontSize.body, marginTop: spacing.lg},
  // Vertical FlatLists need flex here: on TV the list is wrapped in a focus
  // guide that mirrors this style (see the virtualized-lists patch); without
  // it the list sizes to its content and overflows the screen instead of
  // scrolling inside it.
  listFill: {flex: 1},
  list: {paddingBottom: spacing.xl, gap: spacing.sm},
  rowWrap: {flexDirection: 'row', gap: spacing.sm},
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    // Translucent, not the flat surface colour: these sit on artwork now, and a
    // solid slab reads as a hole punched in the picture.
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.m,
    padding: spacing.md,
  },
  qBadge: {borderWidth: 1, borderRadius: radius.s, paddingVertical: 4, paddingHorizontal: 10, minWidth: 66, alignItems: 'center'},
  qText: {fontSize: fontSize.small, fontWeight: '800'},
  info: {flex: 1, minWidth: 0},
  titleLine: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  release: {color: colors.text, fontSize: fontSize.body, fontWeight: '700', flexShrink: 1},
  best: {color: '#f5c542', fontSize: fontSize.small, fontWeight: '900'},
  cam: {color: '#ff8080', fontSize: fontSize.small, fontWeight: '900'},
  dub: {color: '#fbbf24', fontSize: fontSize.small, fontWeight: '900'},
  metaLine: {flexDirection: 'row', gap: spacing.md, marginTop: 4, flexWrap: 'wrap'},
  seeds: {fontSize: fontSize.small, fontWeight: '800'},
  meta: {color: colors.textDim, fontSize: fontSize.small, fontWeight: '600'},
  // .source-row.owned — a green edge and a wash, so a downloaded source is
  // obvious before you read a word of it.
  // .source-row.owned. The site fades the green out to the left over 60% of the
  // row rather than tinting the whole thing flat; RN 0.76+ understands the CSS
  // gradient shorthand, so this is that rule verbatim.
  rowOwned: {
    borderColor: 'rgba(74,222,128,0.45)',
    borderWidth: 1,
    experimental_backgroundImage:
      'linear-gradient(90deg, rgba(74,222,128,0.12), #17181f 60%)',
  },
  qBadgeOwned: {backgroundColor: 'rgba(74,222,128,0.12)'},
  // The pinned owned row: same geometry as a source row, held out of the list.
  ownedRowWrap: {flexDirection: 'row', marginBottom: spacing.sm},
  // .owned-note — green, because this row's story is "yours", not swarm health.
  ownedNote: {color: OWNED, fontSize: fontSize.small, fontWeight: '700'},
  // The live-job line that replaces seeders while a download owns the row —
  // the same informative blue as the ⬇ DOWNLOADING badge, red once it failed.
  jobLine: {color: '#60a5fa', fontSize: fontSize.small, fontWeight: '700', flexShrink: 1},
  jobLineFailed: {color: '#f87171', fontSize: fontSize.small, fontWeight: '700', flexShrink: 1},
  // .source-owned / .source-getting
  ownedTag: {color: colors.bg, backgroundColor: OWNED, fontSize: 11, fontWeight: '900', letterSpacing: 0.8, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden', flexShrink: 0},
  gettingTag: {color: '#60a5fa', borderWidth: 1, borderColor: 'rgba(96,165,250,0.45)', fontSize: 11, fontWeight: '900', letterSpacing: 0.8, borderRadius: 4, paddingHorizontal: 5, flexShrink: 0},
  // .dl-face — the percentage sits inside the ring, so it shrinks when one is up.
  dlRing: {position: 'absolute'},
  dlFace: {color: colors.text, fontSize: fontSize.body, fontWeight: '800'},
  dlFaceSmall: {fontSize: 13, fontWeight: '900'},
  dlFaceOwned: {color: OWNED},
  dlFaceFailed: {color: '#f87171'},
  dlBtnDone: {borderColor: 'rgba(74,222,128,0.4)', backgroundColor: 'rgba(74,222,128,0.10)'},
  dlBtnFailed: {borderColor: 'rgba(248,113,113,0.45)', backgroundColor: 'rgba(248,113,113,0.08)'},
  dlCaption: {color: colors.textDim, fontSize: 10, fontWeight: '900', letterSpacing: 1, marginTop: 2},
  // Widened for the ring: the site went 54 -> 84 for exactly this reason, the
  // ring and the percentage inside it were fighting for the same few pixels.
  dlBtn: {width: 76, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderRadius: radius.m},
});
