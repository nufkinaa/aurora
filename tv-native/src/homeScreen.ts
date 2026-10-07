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
import {assetUrl, getBaseUrl, getSession, HeroItem, HomeRow} from './api';

type Native = {
  setWatchNext: (items: object[]) => Promise<number>;
  setChannel: (name: string, items: object[], base: string | null, session: string | null) => Promise<number>;
  clear: () => Promise<boolean>;
};
const native = NativeModules.AuroraHomeScreen as Native | undefined;

const MAX_NEXT = 8;
const MAX_CHANNEL = 20;

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

/** Publish this profile's rows to the launcher. Cheap to call: it only writes
 *  when a list has actually changed. */
export function syncHomeScreen(rows: HomeRow[] | undefined) {
  if (!native || !rows) {
    if (!native) console.log('[homescreen] no native module');
    return;
  }
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
  const row = [...resume, ...picks];
  const sigChannel = JSON.stringify(row.map(p => [p.id, Math.round(p.position / 30)]));
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

/** A profile leaves this TV: its rows leave the launcher with it. */
export function clearHomeScreen() {
  lastNext = '';
  lastChannel = '';
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
