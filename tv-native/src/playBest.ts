// ONE PRESS ON PLAY — what it picks and what it hands the player. Pure: no
// React, no network (the callers in Detail.tsx / Home.tsx / Sources.tsx do
// the asking), so __tests__/logic/play-best.test.ts holds it to its rules.
//
// Dor (2026-10-17): "on Android TV if we can get on a click to play the first
// download with the default subtitle of the user that would be amazing".
// Until then, Play on a title not on disk SAVED the best source and stopped
// there (a toast, a progress line); watching it meant waiting for the
// download, or holding Play for the list and pressing Stream on a row. Now
// the one press does both: the best source is saved AND played at once,
// streamed from the swarm while the download runs (the server streams any
// torrent it is asked for — /stream/torrent — independently of the download
// engine; the website's "Stream it meanwhile" is the same thing). The
// subtitle is the player's own choice, made the way it always is
// (Player.tsx autoTrack: the person's last pick / default language) — this
// path only hands the player a source and changes nothing about subtitles.
//
// Unchanged, by the owner's ruling (2026-10-10): pressing an EPISODE CARD you
// don't hold downloads its best source and opens its sources in place,
// without moving focus. Only the Play button plays as well.
import type {Stream, TorrentPlayItem} from './api';

/** What a job needs to say for Play to play it (api.ts DownloadJob / MyDownload). */
export type JobLike = {
  status: string;
  infoHash: string;
  fileIdx: number;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  quality?: string;
  release?: string | null; // the torrent's file name (server 1.6.101+, fix-subs)
};

// The tags that mean "this device will not play it as-is" (the browser
// client's, screens/discover-detail.js): the remux is chosen up front instead
// of after ExoPlayer walks into a passthrough AudioTrack failure.
export const VIDEO_TRANSCODE_TAGS = ['H.265', 'AV1'];
export const AUDIO_TRANSCODE_TAGS = ['DTS', 'DTS-HD', 'TrueHD', 'Atmos', 'DD+'];

/** Cinemeta runtime ("152 min", "1h 52min", 152) -> seconds; 0 unknown. */
export const runtimeToSeconds = (runtime?: string | number | null): number => {
  if (!runtime) return 0;
  const str = String(runtime);
  const h = str.match(/(\d+)\s*h/i);
  const m = str.match(/(\d+)\s*m/i);
  if (h || m) return ((h ? +h[1] : 0) * 60 + (m ? +m[1] : 0)) * 60;
  const n = parseInt(str, 10);
  return isNaN(n) ? 0 : n * 60; // a bare number is minutes
};

/** THE pick (one copy of the rule the title page always used): the server's
 *  recommended source among those with peers, else the best-seeded (the
 *  server lists them best first), else whatever there is. */
export const pickBest = (streams: Stream[] | null | undefined): Stream | null => {
  const all = streams || [];
  const alive = all.filter(x => x.seeders > 0);
  return alive.find(x => x.recommended) || alive[0] || all[0] || null;
};

/** What the title is, for the play item. */
export type PlayCtx = {
  type: 'movie' | 'series';
  imdbId: string;
  title: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  runtime?: string | number | null;
  poster?: string | null;
};

/** A source as the player takes it (the Sources screen's Stream button builds
 *  the same thing). */
export const streamPlayItem = (
  s: Pick<Stream, 'infoHash' | 'fileIdx' | 'quality'> & {tags?: string[] | null; filename?: string | null; release?: string | null},
  c: PlayCtx,
): TorrentPlayItem => {
  const tags = s.tags || [];
  const needsVideo = tags.some(t => VIDEO_TRANSCODE_TAGS.includes(t));
  const needsAudio = tags.some(t => AUDIO_TRANSCODE_TAGS.includes(t));
  return {
    id: `torrent|${s.infoHash}|${s.fileIdx}`,
    title: c.title,
    videoUrl: `/stream/torrent/${s.infoHash}/${s.fileIdx}`,
    transcodeBase: `/stream/torrent/hls/${s.infoHash}/${s.fileIdx}`,
    infoHash: s.infoHash,
    fileIdx: s.fileIdx,
    isTorrent: true,
    type: c.type === 'series' ? 'show' : 'movie',
    imdbId: c.imdbId,
    season: c.season || undefined,
    episode: c.episode || undefined,
    // the release's own name: the server ranks subtitle files against it
    // (websubs.rank, api.torrentSubtitles `release`)
    release: s.filename || s.release || undefined,
    needsTranscode: needsVideo || needsAudio,
    transcodeV: needsVideo ? 'h264' : 'copy',
    duration: runtimeToSeconds(c.runtime),
    year: c.year ?? null,
    cover: c.poster ?? null,
    quality: s.quality,
  };
};

const LIVE = ['pending', 'approved', 'downloading'];
/** The download already on its way for this film / episode, if any — Play on
 *  it plays what it is fetching. */
export const runningJobFor = <J extends JobLike>(
  jobs: J[],
  imdbId: string,
  season?: number | null,
  episode?: number | null,
): J | null =>
  jobs.find(
    j =>
      j.imdbId === imdbId &&
      LIVE.includes(j.status) &&
      !!j.infoHash &&
      (season && episode ? j.season === season && j.episode === episode : !j.season && !j.episode),
  ) || null;

/** The source a running job is fetching, from the list when it is there (its
 *  tags decide the remux), else from the job itself. */
export const jobSource = (job: JobLike, streams: Stream[] | null | undefined) =>
  (streams || []).find(s => s.infoHash === job.infoHash && s.fileIdx === job.fileIdx) || {
    infoHash: job.infoHash,
    fileIdx: job.fileIdx,
    quality: job.quality || '',
    tags: null,
    ...(job.release ? {release: job.release} : {}),
  };

// ---- the title page pressing Play for you ---------------------------------
// Home's hero and a title opened with `play` (navigation.tsx Detail.play):
// the title page opens and presses its own Play once it knows enough to make
// the same choice a person's press would — never earlier (a guess would
// stream a film that is on disk, or download what is already on its way).
export const AUTO_PLAY_GIVE_UP_MS = 12000;
export type AutoPlayFacts = {
  /** the admin's torrents switch has been read */
  torrentsKnown: boolean;
  /** whether the title is on disk has been settled (library read or matched) */
  libraryKnown: boolean;
  /** the first read of the downloads list landed (or there was nothing to read) */
  jobsKnown: boolean;
  /** what Play stands for exists (a film: always; a show: its episode) */
  target: boolean;
  /** a show: the watch state is read, so Play is the right episode */
  stateKnown: boolean;
  /** ms since the page opened */
  elapsed: number;
};
/** 'press' now, 'wait', or 'drop' (too long: leave the page as it is). */
export const autoPlayStep = (f: AutoPlayFacts): 'press' | 'wait' | 'drop' => {
  const ready = f.torrentsKnown && f.libraryKnown && f.jobsKnown && f.target && f.stateKnown;
  if (ready) return 'press';
  return f.elapsed >= AUTO_PLAY_GIVE_UP_MS ? 'drop' : 'wait';
};
