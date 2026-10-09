// Aurora on the TV's own home screen (HomeScreenModule.kt): the launcher's
// "Continue watching" row carries what this profile stopped in the middle of,
// and a row of Aurora's own carries its recommendations. Each entry is a link
// back into the app — `aurora://open?a=play|detail&d=<the item, as JSON>` —
// which Home hears (useHomeScreenLinks) and opens.
//
// The item rides in the link itself, whole: a part-watched stream cannot be
// rebuilt from its id (openItem.ts), and a link that needed the server to
// say what it meant would be a spinner where a film should be.
import {useEffect} from 'react';
import {Linking, NativeModules} from 'react-native';
import {api, assetUrl, getBaseUrl, getSession, getToken, HeroItem, HomeRow, MyDownload} from './api';

type Native = {
  setWatchNext: (items: object[]) => Promise<number>;
  setChannel: (name: string, items: object[], base: string | null, session: string | null) => Promise<number>;
  clear: () => Promise<boolean>;
  // 5.1.20+: who the background refresh job asks the server as, and a way to
  // run that job's work on demand. Optional — an older native build has neither.
  configure?: (base: string | null, session: string | null, profileId: string | null, profileToken: string | null) => Promise<boolean>;
  refreshNow?: () => Promise<string>;
  // 5.1.28+: "ready to watch" notifications (DownloadNotices.kt).
  announceDownload?: (jobJson: string, base: string | null, session: string | null) => Promise<boolean>;
  setDownloadNotices?: (on: boolean) => Promise<boolean>;
  askNotificationPermission?: (force: boolean) => Promise<boolean>;
};
const native = NativeModules.AuroraHomeScreen as Native | undefined;

const MAX_NEXT = 8;
const MAX_CHANNEL = 20;
// "New: …" entries: downloads that landed in the last week (HomeScreenRows MAX_NEW / NEW_MS)
const MAX_NEW = 6;
const NEW_MS = 7 * 24 * 60 * 60 * 1000;

// Only what opening the title needs — a link is not the place for a synopsis.
const KEEP: (keyof HeroItem)[] = [
  'id', 'type', 'title', 'year', 'cover', 'poster', 'backdrop', 'imdbId', 'inLibrary', 'source',
  'showId', 'showTitle', 'season', 'episode', 'progress', 'videoUrl', 'transcodeBase', 'infoHash', 'transcodeV', 'quality',
];
const slim = (item: HeroItem) => {
  const out: Record<string, unknown> = {};
  for (const k of KEEP) if (item[k] != null) out[k] = item[k];
  return out;
};
const linkFor = (action: 'play' | 'detail', item: HeroItem) =>
  `aurora://open?a=${action}&d=${encodeURIComponent(JSON.stringify(slim(item)))}`;

const isEpisode = (i: HeroItem) => !!i.showId && i.type !== 'show';

// A resume entry's picture, the way the app's own Continue Watching card picks
// it: the frame you stopped on when the server can cut it (a library file with
// a position), else the title's wide art, its cover, or the show's cover. An
// episode from /api/home often carries no picture of its own at all.
const resumeArt = (i: HeroItem): string | null => {
  const library = !!i.id && !String(i.id).startsWith('torrent|');
  if (library && (i.progress?.position || 0) > 20) return `/img/frame/${encodeURIComponent(i.id)}?t=${Math.floor(i.progress!.position)}`;
  return i.backdrop || i.cover || i.poster || (i.showId ? `/img/${i.showId}` : null);
};

let lastNext = '';
let lastChannel = '';
let lastConfig = '';
// What the row was last built from, so a download landing can rebuild it
// without waiting for Home to fetch again.
let lastRows: HomeRow[] | null = null;
let lastProfile: string | null = null;
let lastJobs: MyDownload[] = [];

// ---- a landed download → what opens it. THE SAME RULES AS HomeScreenRows.landedItem (Kotlin). ----
const isLandedEpisode = (j: MyDownload) => j.type === 'show' && j.season != null && j.episode != null;
const landedName = (j: MyDownload) => {
  const t = j.title || j.label || 'A download';
  return isLandedEpisode(j) ? `${t} S${j.season} E${j.episode}` : t;
};
const landedEpisodeTitle = (j: MyDownload) =>
  isLandedEpisode(j) && j.epTitle && !/^Episode \d+$/.test(j.epTitle) ? j.epTitle : null;
// An episode opens straight in the player (openItem's episode case: no type,
// a showId); a film too (Home's openFromLauncher, action "play").
const landedItem = (j: MyDownload): HeroItem | null => {
  if (!j.libraryId) return null;
  const item: Record<string, unknown> = {id: j.libraryId};
  if (isLandedEpisode(j)) {
    item.title = j.epTitle || `Episode ${j.episode}`;
    if (j.poster) item.cover = j.poster;
    if (j.imdbId) item.imdbId = j.imdbId;
    item.inLibrary = true;
    if (j.showId) item.showId = j.showId;
    item.showTitle = j.title || '';
    item.season = j.season;
    item.episode = j.episode;
  } else {
    item.type = 'movie';
    item.title = j.title || j.label || '';
    if (j.poster) item.cover = j.poster;
    if (j.imdbId) item.imdbId = j.imdbId;
    item.inLibrary = true;
  }
  return item as unknown as HeroItem;
};
const doneMs = (j: MyDownload) => {
  const t = j.doneAt ? Date.parse(j.doneAt) : NaN;
  return Number.isFinite(t) ? t : 0;
};
// This profile's finished, unopened downloads of the last week, newest first.
// "This profile's" = the server's `mine`: what it asked for, and what its
// follows / smart downloads fetched (both are filed under the follower).
const landedEntries = (jobs: MyDownload[], skip: Set<string>) => {
  const now = Date.now();
  return jobs
    .filter(j => j.status === 'done' && j.mine && !j.seenAt && j.libraryId && !skip.has(j.libraryId))
    .filter(j => doneMs(j) > 0 && now - doneMs(j) <= NEW_MS)
    .sort((a, b) => doneMs(b) - doneMs(a))
    .slice(0, MAX_NEW)
    .map(j => {
      const item = landedItem(j)!;
      const ep = isLandedEpisode(j);
      const epTitle = landedEpisodeTitle(j);
      const wide = ep || !j.poster;
      return {
        id: `new-${j.id || j.libraryId}`,
        kind: ep ? 'show' : 'movie',
        title: `New: ${landedName(j)}` + (epTitle ? ` — ${epTitle}` : ''),
        description: 'Just downloaded — ready to watch',
        // an episode's own frame (wide); a film's poster when it has one
        art: assetUrl(wide ? `/img/still/${encodeURIComponent(j.libraryId!)}` : j.poster) || null,
        shape: wide ? 'wide' : 'poster',
        position: 0,
        duration: 0,
        link: linkFor('play', item),
      };
    });
};

// The rows are also refreshed natively every few hours while the app is closed
// (HomeScreenJob.kt). That job has no JS to ask, so the app tells the native
// side who it is — the same four things request() in api.ts works from: the
// server's address, the session (X-Session), the profile, and its unlock token
// (X-Profile-Token) when it has one. They are kept in the app's private
// storage and wiped by clearHomeScreen(). Only sent when one of them changed.
//
// THE MAPPING BELOW IS WRITTEN TWICE: here, and in Kotlin
// (HomeScreenRows.entriesFromHome) for that job. Change one, change the other
// — the link format and KEEP above all.
const configure = (profileId: string) => {
  if (!native?.configure) return;
  const cfg = [getBaseUrl() || null, getSession() || null, profileId, getToken() || null];
  const sig = JSON.stringify(cfg);
  if (sig === lastConfig) return;
  lastConfig = sig;
  native
    .configure(cfg[0], cfg[1], cfg[2], cfg[3])
    .then(ok => console.log('[homescreen] background refresh configured:', ok))
    .catch(() => {
      lastConfig = '';
    });
};

/** Runs the background job's work now and reports what it did (a test hook:
 *  `require('./src/homeScreen').refreshHomeScreenNow()` from the dev menu, or
 *  watch `adb logcat -s AuroraHomeScreen` when the system runs the job). */
export const refreshHomeScreenNow = (): Promise<string> =>
  native?.refreshNow ? native.refreshNow() : Promise.resolve('no native module');

/** Publish this profile's rows to the launcher. Cheap to call: it only writes
 *  when a list has actually changed. */
export function syncHomeScreen(rows: HomeRow[] | undefined, profileId?: string) {
  if (!native || !rows) {
    if (!native) console.log('[homescreen] no native module');
    return;
  }
  if (profileId) configure(profileId);
  const cont = (rows.find(r => r.id === 'continue')?.items || []).slice(0, MAX_NEXT);
  const next = cont.map(i => ({
    id: i.id,
    title: isEpisode(i) ? i.showTitle || i.title : i.title,
    episodeTitle: isEpisode(i) && !/^Episode \d+$/.test(i.title) ? i.title : null,
    season: isEpisode(i) ? i.season ?? null : null,
    episode: isEpisode(i) ? i.episode ?? null : null,
    art: assetUrl(i.backdrop || i.cover || i.poster) || null,
    position: i.progress?.position || 0,
    duration: i.progress?.duration || 0,
    link: linkFor('play', i),
  }));
  const sigNext = JSON.stringify(next.map(n => [n.id, Math.round(n.position / 30)]));
  if (sigNext !== lastNext) {
    lastNext = sigNext;
    native
      .setWatchNext(next)
      .then(n => console.log('[homescreen] continue watching:', n, 'of', next.length))
      .catch(e => {
        lastNext = '';
        console.log('[homescreen] continue watching failed:', (e as Error)?.message);
      });
  }

  // another profile's downloads never stand in for this one's
  if (profileId && profileId !== lastProfile) lastJobs = [];
  lastRows = rows;
  lastProfile = profileId || lastProfile;
  // The row waits for this profile's downloads (its "New: …" entries); if they
  // cannot be read, the last list known stands in.
  const pid = lastProfile;
  if (!pid) return writeChannel(rows, cont);
  api
    .myDownloads(pid)
    .then(jobs => {
      if (Array.isArray(jobs)) lastJobs = jobs;
    })
    .catch(() => {})
    .then(() => {
      if (lastRows === rows) writeChannel(rows, cont);
    });
}

function writeChannel(rows: HomeRow[], cont: HeroItem[]) {
  if (!native) return;
  // Aurora's own row. Measured on the Mi TV (Google TV home, 2026-10-08): the
  // launcher shows this row, with pictures, but keeps its own "Continue
  // watching" for partner apps — so what the viewer is part-way through leads
  // the row here, with its progress, and the recommendations follow. The
  // launcher draws wide tiles, so wide art is asked for first.
  const rec = rows.find(r => r.id === 'recommended') || rows.find(r => /recommend|for you/i.test(r.title));
  const resume = cont.map(i => ({
    id: `resume-${i.id}`,
    kind: isEpisode(i) ? 'show' : i.type === 'show' ? 'show' : 'movie',
    title: isEpisode(i) ? `${i.showTitle || i.title} · S${i.season} E${i.episode}` : i.title,
    description: isEpisode(i) && !/^Episode \d+$/.test(i.title) ? i.title : 'Continue watching',
    art: assetUrl(resumeArt(i)) || null,
    shape: 'wide',
    position: i.progress?.position || 0,
    duration: i.progress?.duration || 0,
    link: linkFor('play', i),
  }));
  const picks = (rec?.items || []).slice(0, MAX_CHANNEL).map(i => ({
    id: i.imdbId || i.id,
    kind: i.type === 'show' ? 'show' : 'movie',
    title: i.title,
    description: i.synopsis || null,
    art: assetUrl(i.backdrop || i.cover || i.poster) || null,
    shape: i.backdrop ? 'wide' : 'poster',
    position: 0,
    duration: 0,
    link: linkFor('detail', i),
  }));
  // what the viewer is part-way through, then what just landed, then picks
  const landed = landedEntries(lastJobs, new Set(cont.map(i => i.id)));
  const row = [...resume, ...landed, ...picks];
  // the title too: a "New: …" entry learns its episode name after indexing
  const sigChannel = JSON.stringify(row.map(p => [p.id, Math.round(p.position / 30), p.title]));
  if (row.length && sigChannel !== lastChannel) {
    lastChannel = sigChannel;
    native
      .setChannel('Aurora', row, getBaseUrl() || null, getSession() || null)
      .then(n => console.log('[homescreen] row:', n, 'of', row.length))
      .catch(e => {
        lastChannel = '';
        console.log('[homescreen] row failed:', (e as Error)?.message);
      });
  }
}

/**
 * The socket said a download is done (SessionWiring.tsx): the row is rebuilt
 * with it, and — when it is this profile's and new — the TV posts "… is ready
 * to watch". Which downloads get a notification, and the record of which
 * already did, is the native side's (DownloadNotices.kt), shared with the
 * background job so nothing is announced twice.
 */
export function onDownloadLanded(job: MyDownload) {
  if (!job || job.status !== 'done') return;
  if (noticesOn && job.mine && job.libraryId && native?.announceDownload) {
    native
      .announceDownload(JSON.stringify(job), getBaseUrl() || null, getSession() || null)
      .then(ok => ok && console.log('[homescreen] announced:', landedName(job)))
      .catch(() => {});
  }
  if (!lastRows) return;
  const i = lastJobs.findIndex(j => j.id === job.id);
  lastJobs = i >= 0 ? lastJobs.map(j => (j.id === job.id ? job : j)) : [job, ...lastJobs];
  const cont = (lastRows.find(r => r.id === 'continue')?.items || []).slice(0, MAX_NEXT);
  writeChannel(lastRows, cont);
}

// The Settings switch "Tell me when a download lands" (storage.ts downloadNotices).
let noticesOn = true;
/** The Settings switch: kept here for the socket path, and mirrored natively for the background job. */
export const setDownloadNotices = (on: boolean) => {
  noticesOn = on;
  native?.setDownloadNotices?.(on).catch(() => {});
};

/** Android 13+: ask once (or again when `force`) to post notifications. Resolves whether they are allowed. */
export const askNotificationPermission = (force: boolean): Promise<boolean> =>
  native?.askNotificationPermission ? native.askNotificationPermission(force).catch(() => false) : Promise.resolve(false);

/** A profile leaves this TV: its rows leave the launcher with it. */
export function clearHomeScreen() {
  lastNext = '';
  lastChannel = '';
  lastConfig = '';
  lastRows = null;
  lastProfile = null;
  lastJobs = [];
  // native clear() also forgets what configure() stored and cancels the job
  native?.clear().catch(() => {});
}

const parse = (url: string | null): {action: 'play' | 'detail'; item: HeroItem} | null => {
  if (!url || !url.startsWith('aurora://open')) return null;
  try {
    const q = url.split('?')[1] || '';
    const get = (k: string) => {
      const m = q.split('&').find(p => p.startsWith(`${k}=`));
      return m ? decodeURIComponent(m.slice(k.length + 1)) : null;
    };
    const d = get('d');
    if (!d) return null;
    const item = JSON.parse(d) as HeroItem;
    if (!item || typeof item.id !== 'string' || typeof item.title !== 'string') return null;
    return {action: get('a') === 'play' ? 'play' : 'detail', item};
  } catch {
    return null;
  }
};

let initialTaken = false;

/** Home listens for the launcher's links: the one the app was opened with
 *  (once per run), and any that arrive while it is already open. */
export function useHomeScreenLinks(open: (action: 'play' | 'detail', item: HeroItem) => void) {
  useEffect(() => {
    let on = true;
    if (!initialTaken) {
      initialTaken = true;
      Linking.getInitialURL()
        .then(u => {
          const p = parse(u);
          // a breath, so the navigator under Home is ready to take a push
          if (on && p) setTimeout(() => on && open(p.action, p.item), 600);
        })
        .catch(() => {});
    }
    const sub = Linking.addEventListener('url', e => {
      const p = parse(e.url);
      if (p) open(p.action, p.item);
    });
    return () => {
      on = false;
      sub.remove();
    };
  }, [open]);
}
