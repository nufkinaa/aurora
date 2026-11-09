// "Keep the next episodes on this phone" (Settings → Saved on this phone; OFF unless
// turned on): when an episode starts playing — streamed or a saved copy — the next 2
// episodes of that show are saved to the phone, on Wi-Fi only, through the same
// saveOffline flow a tap on "Save to this phone" uses. Only episodes already on the
// server are saved: nothing is ever downloaded on the server for it (elia removed the
// server-side My List downloads, 2026-10-26). A full space limit skips it; nothing is
// removed to make room. The rules are offline/storage.ts's (tested).
import {NativeModules} from 'react-native';
import {api, getActiveProfile} from '../../api';
import {listOffline, offlinePrefs, saveOffline} from './store';
import {keepNextNow, keepNextQuality, nextToKeep, type Ep} from './storage';
import type {OfflineQuality} from './rules';

const N = (NativeModules as {AuroraOffline?: {network(): Promise<string>}}).AuroraOffline;
const busy = new Set<string>(); // shows being looked at now (one pass per show at a time)

/** An episode (its library id) has started playing. Never throws; quiet. */
export async function keepNextAfter(episodeId: string): Promise<number> {
  const p = offlinePrefs();
  if (!p.keepNext || !N || !episodeId) return 0;
  const profileId = getActiveProfile();
  if (!profileId) return 0;
  try {
    if (!keepNextNow(p.keepNext, await N.network())) return 0;
    const ep = await api.item(episodeId, profileId);
    if (!ep?.showId || ep.season == null || ep.episode == null) return 0;
    if (busy.has(ep.showId)) return 0;
    busy.add(ep.showId);
    try {
      const show = await api.item(ep.showId, profileId);
      const all: (Ep & {title?: string; duration?: number; subtitles?: {label: string; lang?: string; url?: string}[]})[] = (show.seasons || []).flatMap(se =>
        (se.episodes || []).map(e => ({...e, season: e.season ?? se.number})),
      );
      const have = new Set(listOffline().filter(c => c.state !== 'failed').map(c => c.id));
      const todo = nextToKeep(all, {season: ep.season, episode: ep.episode}, have);
      let n = 0;
      for (const e of todo) {
        const r = await saveOffline(
          {
            id: e.id,
            title: e.title || `Episode ${e.episode}`,
            showId: show.id,
            showTitle: show.title,
            season: e.season,
            episode: e.episode,
            year: show.year ?? null,
            cover: show.cover || show.poster || null,
            duration: e.duration,
            subtitles: (e.subtitles || []).filter(t => !!t.url).map(t => ({label: t.label, lang: t.lang, url: t.url as string})),
          },
          async () => null,
          {auto: {quality: keepNextQuality(p.quality) as OfflineQuality}},
        );
        if (r === 'started') n++;
        if (r === 'full') break;
      }
      return n;
    } finally {
      busy.delete(ep.showId);
    }
  } catch {
    return 0;
  }
}
