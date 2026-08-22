// Aurora TV API client — the single place that talks to the Aurora server.
// The base URL is set once from storage/setup; the profile token (when a
// protected profile is unlocked) rides on every request as X-Profile-Token,
// mirroring the web client.
let baseUrl = '';
let token: string | null = null;

// WHERE THE SERVER IS. In code, deliberately — there is no setup screen and the
// viewer is never asked. The LAN address is tried first; if it does not answer on
// the first try the remote one BECOMES the server for this run.
export const SERVER_CANDIDATES = [
  "http://10.0.0.1:4000",
  'https://nufurora.com',
];

export const setBaseUrl = (url: string) => {
  // normalize: no trailing slash
  baseUrl = url.replace(/\/+$/, '');
};
export const getBaseUrl = () => baseUrl;
export const setToken = (t: string | null) => {
  token = t || null;
};
// The Games screen seeds this into the WebView so the site doesn't show its own
// profile gate on top of ours.
export const getToken = () => token;

export type Profile = {
  id: string;
  name: string;
  color: string;
  avatar: string;
  hasPassword: boolean;
  locked?: boolean; // admin lockdown — can't be entered at all
};

export type HeroItem = {
  id: string;
  // Optional because Continue Watching sends EPISODES, and an episode row from
  // /api/home carries no `type` at all — it identifies itself with showId +
  // season + episode. Typing this as required made `item.type === 'show'` look
  // exhaustive when it wasn't, so episodes fell through to the movie layout.
  type?: 'movie' | 'show';
  title: string;
  year?: number;
  cover?: string | null;
  backdrop?: string | null;
  synopsis?: string;
  rating?: number | null;
  genres?: string[];
  source?: 'stream' | 'downloaded';
  imdbId?: string;
  // Discover/catalog/search items only: the LIBRARY id of the copy on disk, set
  // server-side by a normalized-title match (src/media/discover.js markLibrary).
  // Detail uses it as a fast path before doing its own library match.
  inLibrary?: string | null;
  poster?: string | null; // discover/trending items use `poster`, library uses `cover`
  // Episode fields, present on Continue Watching entries.
  showId?: string;
  showTitle?: string;
  season?: number;
  episode?: number;
  // Continue Watching entries carry the saved position as an OBJECT, not a
  // fraction — the bar has to divide it out, same as the web's card does.
  progress?: Progress;
  // Present on a saved `torrent|…` entry: its play URLs cannot be rebuilt from
  // the id, so they ride along on the item itself (see openItem.ts).
  videoUrl?: string;
  transcodeBase?: string;
  infoHash?: string;
  transcodeV?: 'copy' | 'h264';
  // Stored with the play-item; carried back on every save so resuming never
  // strips it from the entry (profiles.setProgress replaces the item wholesale).
  quality?: string;
  // When it landed in the library — the "Recently added" sort reads this.
  addedAt?: number;
  // Runtime in seconds; My List's "Longest" sort is the only reader.
  duration?: number;
  // Set by the server (src/profiles.js) on the "next episode to watch" entry it
  // synthesises for Continue Watching. The site labels those cards even when
  // they aren't in a wide row, so the card needs to see it.
  upNext?: boolean;
};

export type HomeRow = { id: string; title: string; items: HeroItem[] };
export type Home = { hero: HeroItem[]; rows: HomeRow[] };

export type SubtitleTrack = {
  label: string;
  url: string;
  lang?: string;
  // Set by the scanner (src/media/scanner.js) on tracks pulled out of the video
  // file itself. The site tags these in its subtitle menu.
  embedded?: boolean;
};
export type Progress = {
  position: number;
  duration: number;
  finished?: boolean;
  // When it was last touched. `profiles.js:356` sends it on every entry; My
  // List's "Last watched" sort and `watchState`'s `at` are the two readers.
  updatedAt?: number;
};
export type ProfileState = {
  progress: Record<string, Progress>;
  // The two maps a downloaded-only `progress` lookup misses entirely
  // (`profiles.js:138-139`): streamed EPISODES keyed `imdbId:season:episode`,
  // and streamed FILMS keyed by imdbId. See watchState.ts.
  episodeProgress?: Record<string, Progress>;
  streamProgress?: Record<string, Progress>;
  // The genres this profile said it likes; Home's server-side ranking uses them
  // and the Settings screen edits them.
  likedGenres?: string[];
};

export type Episode = {
  id: string;
  season: number;
  episode: number;
  title?: string;
  duration?: number;
  sizeBytes?: number;
  // The scanner attaches these per episode (src/media/scanner.js), external and
  // embedded together. The episode list uses their presence for its CC badge.
  subtitles?: SubtitleTrack[];
};
// `number`, not `season` — /api/item really does key it that way (same shape as
// DiscoverSeason below). This type said `season` for a long time, and because
// nothing else referenced it TypeScript happily type-checked two reads of a
// field the server never sends: every season came back undefined, so Detail's
// pills all compared equal and all rendered as selected at once.
export type Season = { number: number; episodes: Episode[] };

// A library detail item. Movies/episodes carry videoUrl/subtitles/duration;
// shows carry seasons.
// What the scanner recorded about the actual media streams. `compatible` is the
// server's own verdict on whether the audio can be played as-is.
export type AudioInfo = { codec?: string; channels?: number; compatible?: boolean };
export type VideoInfo = { codec?: string; bitDepth?: number };

export type Item = HeroItem & {
  videoUrl?: string;
  downloadUrl?: string;
  transcodeBase?: string;
  // What the scanner recorded about the FILE. The detail page shows all three —
  // they are what tell you which copy you actually have (ui.js resBadge/fmtBytes).
  width?: number;
  height?: number;
  sizeBytes?: number;
  certificate?: string;
  audio?: AudioInfo;
  video?: VideoInfo;
  container?: string;
  duration?: number;
  subtitles?: SubtitleTrack[];
  seasons?: Season[];
  showId?: string;
  showTitle?: string;
  season?: number;
  episode?: number;
};

// Stream ref for watchlist toggles on non-library (Discover) titles. Genres
// and rating ride along because this ref is all My List ever knows about the
// title — without them its genre filter and rating sort skip stream entries.
export type StreamRef = {
  imdbId: string;
  type: 'movie' | 'show';
  title: string;
  poster?: string | null;
  year?: number | null;
  genres?: string[];
  rating?: number | null;
};

// A torrent source as ranked by the server (BEST/CAM/dubbed decided there).
export type Stream = {
  infoHash: string;
  fileIdx: number;
  filename: string;
  release: string;
  provider: string | null;
  quality: string; // "2160p" | "1080p" | "720p" | "480p" | "SD"
  qualityLabel: string;
  tags: string[];
  cam: boolean;
  dubbed: boolean;
  seeders: number;
  sizeString: string | null;
  sizeBytes: number;
  languages: string[];
  recommended?: boolean;
};

// A ready-to-play torrent item handed to the Player via nav params (avoids the
// /api/item "torrent|…" stub round-trip). videoUrl/transcodeBase are the
// server stream routes; season/episode/type/imdbId let the player fetch the
// matching OpenSubtitles tracks asynchronously.
export type TorrentPlayItem = {
  id: string; // `torrent|<infoHash>|<fileIdx>`
  title: string;
  videoUrl: string;
  transcodeBase: string;
  // Ported straight from the browser client (screens/discover-detail.js), which
  // solves both torrent playback problems without probing anything:
  //
  //   duration — the title's TRUE runtime from metadata. ExoPlayer cannot derive
  //     a duration for a file still downloading, so the scrubber was dead and the
  //     Streamer stamped a red LIVE chip on the picture. The web floors its
  //     scrubber on this exact value for the same reason.
  //   needsTranscode / transcodeV — decided from the release TAGS the server
  //     already ranks with, so a DTS/TrueHD/DD+ source starts on the remux
  //     instead of walking into a passthrough AudioTrack failure first.
  duration?: number;
  needsTranscode?: boolean;
  transcodeV?: 'copy' | 'h264';
  infoHash: string;
  fileIdx: number;
  isTorrent: true;
  type: 'movie' | 'show';
  imdbId?: string;
  season?: number;
  episode?: number;
  // Card metadata, carried purely so the player can hand it back to the server
  // with the saved position (Player's streamMeta / the web's streamMeta). A
  // `torrent|…` id is not in the library scanner, so profiles.setProgress needs
  // the play-item to be able to draw — and later resume — a Continue Watching
  // card at all. Without these the card would be a blank tile.
  year?: number | null;
  cover?: string | null;
  backdrop?: string | null;
  quality?: string;
};

// A download-to-server job, as /api/downloads reports it (src/media/downloads.js
// publicJob). Only the fields the TV actually renders are typed here.
export type DownloadJob = {
  id: string;
  infoHash: string;
  fileIdx: number;
  status: 'pending' | 'approved' | 'downloading' | 'done' | 'error' | string;
  // While downloading, the engine reports which stage it is in: 'finding' means
  // it hasn't located the file in the swarm yet, 'copying' means it is moving the
  // finished file into the library.
  phase?: string | null;
  progress?: number; // 0..1
  copyProgress?: number | null; // 0..1
  downloadSpeed?: number;
  error?: string | null;
};

export type TorrentStatus = {
  ready: boolean;
  peers: number;
  progress: number;
  downloadSpeed: number;
  subtitles?: SubtitleTrack[];
};

// Stream-show metadata from Cinemeta (episodes have no library id — they are
// played by (season, episode) through the Sources screen).
export type DiscoverEpisode = {
  season: number;
  episode: number;
  title?: string;
  overview?: string;
  thumbnail?: string | null;
  released?: string | null;
};
export type DiscoverSeason = { number: number; episodes: DiscoverEpisode[] };
export type DiscoverMeta = HeroItem & {
  // "152 min" / "1h 52min" as Cinemeta reports it. Needed for the torrent
  // scrubber's total length (see TorrentPlayItem.duration).
  runtime?: string | number | null;
  seasons?: DiscoverSeason[] | null;
  episodeCount?: number | null;
  cast?: string[];
  // Age rating ("16+"). Comes from TMDB via the server, so it is present for
  // streamable titles too, not just the ones we hold on disk.
  certificate?: string | null;
};

export type Library = { movies: Item[]; shows: Item[] };
export type Discover = { movies: HeroItem[]; shows: HeroItem[] };

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!baseUrl) throw new ApiError(0, 'No server configured');
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['X-Profile-Token'] = token;
  let res: Response;
  try {
    res = await fetch(baseUrl + path, { ...options, headers });
  } catch {
    // Network-level failure (server down, wrong IP, wifi) — normalize to a
    // friendly, catchable shape instead of a raw TypeError.
    throw new ApiError(0, 'Cannot reach server');
  }
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${path}`);
  return res.json() as Promise<T>;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Health-check one candidate URL without touching the global baseUrl. Short
// timeout: a dead LAN IP can otherwise hang for many seconds of SYN retries.
//
// GUARANTEED to settle within timeoutMs. The obvious version — await a fetch
// carrying an AbortController that a timer aborts — does NOT hold that
// guarantee on this platform: measured on the Streamer, a candidate whose SYN
// is black-holed (no RST, e.g. a LAN IP behind a firewall or gone off the
// network) leaves react-native's fetch pending forever, and calling abort()
// does not reject it. resolveServer then awaits a promise that never settles
// and the app hangs on a black loading screen with no way forward. Racing the
// fetch against a timer that RESOLVES false removes that failure mode: the ping
// always answers in time whether or not the underlying socket ever does.
const pingUrl = (url: string, timeoutMs = 2000): Promise<boolean> => {
  const ctrl = new AbortController();
  const attempt = fetch(url.replace(/\/+$/, '') + '/api/home', {signal: ctrl.signal})
    .then(res => res.ok)
    .catch(() => false);
  const timeout = new Promise<boolean>(resolve =>
    setTimeout(() => {
      // Best-effort cancel so a slow socket does not linger; the race is already
      // decided regardless of whether this actually aborts.
      try {
        ctrl.abort();
      } catch {}
      resolve(false);
    }, timeoutMs),
  );
  return Promise.race([attempt, timeout]);
};

// Find a live server. Returns the working URL (normalized) or null when nothing
// answers.
//
// SERVER_CANDIDATES ORDER IS THE PRIORITY, ALWAYS. The saved URL does not
// reorder it, and this is not a detail: a previous version sorted the remembered
// address to the front, so one outage was enough to make the failover permanent.
// Measured on the Streamer — both servers were briefly down, boot saved the
// remote, and every launch afterwards ran over the internet with the LAN sitting
// there healthy. The remembered URL is kept only so the first request has a base
// before this resolves; it is never a preference.
//
// IN ORDER, one try each: "if the first does not answer on the first try, the
// fallback becomes the main URL" — for that run, and only that run. Not parallel
// — parallel would let the remote win a race the LAN should always win.
//
// The cost of a spurious failover (the TV's Wi-Fi still waking from power-save
// can fail a first ping) is that a session runs over the internet instead of the
// LAN. That is slower, not broken — and the next launch tries the LAN first again.
export const resolveServer = async (_savedUrl?: string | null): Promise<string | null> => {
  for (const candidate of SERVER_CANDIDATES) {
    const url = candidate.replace(/\/+$/, '');
    if (await pingUrl(url)) return url;
  }
  return null;
};

// Absolute URL for an image/stream path the server returns as root-relative
// (e.g. "/img/meta/x"). Remote http(s) URLs (metahub posters) pass through.
export function assetUrl(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return baseUrl + pathOrUrl;
}

export const api = {
  // Health check: /api/home with no profile is public and cheap.
  ping: () => request<Home>('/api/home'),
  profiles: () => request<Profile[]>('/api/profiles'),
  unlock: (id: string, password: string) =>
    post<{ ok?: boolean; token?: string; error?: string }>(
      `/api/profiles/${id}/unlock`,
      { password },
    ),
  // slim=1: no episode trees or track lists. A shelf draws posters and titles,
  // and Detail/Player fetch /api/item for the rest — so those fields were 60% of
  // a 450 KB payload that this device had to pull over wifi and parse on launch.
  home: (profileId: string) =>
    request<Home>(`/api/home?slim=1&profile=${encodeURIComponent(profileId)}`),
  library: () => request<Library>('/api/library'),
  setPreferences: (profileId: string, likedGenres: string[]) =>
    post<{ ok: boolean }>(`/api/profiles/${profileId}/preferences`, { likedGenres }),
  // The IMDb id for a LIBRARY title, so one detail page can offer both the local
  // copy and the stream sources (which are all keyed by IMDb id). Added to the
  // server in the same commit that unified the site's detail page.
  imdbFor: (type: 'movie' | 'show', title: string, year?: number | null) =>
    request<{ imdbId: string | null }>(
      `/api/imdb-for?type=${encodeURIComponent(type)}&title=${encodeURIComponent(title)}` +
      (year ? `&year=${encodeURIComponent(String(year))}` : ''),
    ),
  discover: () => request<Discover>('/api/discover'),
  // One page of a Browse category. Paged SERVER-side and per genre, which is the
  // whole point: the old client fetched a fixed slice of trending and filtered it
  // locally, so a niche genre came back with three titles and "load more" was a
  // lie. `page` is 0-based; `hasMore` says whether asking again is worth it.
  catalog: (params: {
    type: 'movie' | 'show';
    category: string;
    genre?: string | null;
    page?: number;
  }) => {
    const q = new URLSearchParams({
      type: params.type,
      category: params.category,
      page: String(params.page ?? 0),
    });
    if (params.genre) q.set('genre', params.genre);
    return request<{ items: HeroItem[]; page: number; hasMore: boolean }>(
      `/api/catalog?${q.toString()}`,
    );
  },
  // The genres the catalog can actually serve, so the picker never offers one
  // that comes back empty.
  catalogGenres: (type: 'movie' | 'show') =>
    request<{ genres: string[] }>(`/api/catalog/genres?type=${encodeURIComponent(type)}`),
  discoverSearch: (q: string) =>
    request<Discover>(`/api/discover/search?q=${encodeURIComponent(q)}`),
  discoverMeta: (type: 'movie' | 'series', imdbId: string) =>
    request<DiscoverMeta>(`/api/discover/meta/${type}/${imdbId}`),
  item: (id: string, profileId?: string) =>
    request<Item>(
      `/api/item/${encodeURIComponent(id)}` +
      (profileId ? `?profile=${encodeURIComponent(profileId)}` : ''),
    ),
  state: (profileId: string) =>
    request<ProfileState>(`/api/profiles/${profileId}/state`),
  // Hide a show's synthesized "up next" card. clearProgress can't (the card's
  // id is the NEXT episode's; the progress row lives under the previous one).
  dismissUpNext: (profileId: string, showId: string, episodeId: string) =>
    post<{ ok: boolean }>(`/api/profiles/${profileId}/upnext-dismiss`, {
      showId,
      episodeId,
    }),
  // "Back on the pile" — the site's Mark-unwatched.
  clearProgress: (profileId: string, itemId: string) =>
    request<{ ok: boolean }>(
      `/api/profiles/${profileId}/progress/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    ),
  saveProgress: (
    profileId: string,
    itemId: string,
    position: number,
    duration: number,
    // The play-item, for `torrent|…` ids only. The server keeps it in
    // `streamItems` and Continue Watching SKIPS any torrent entry that has none
    // (src/profiles.js) — so without this a stream watched on the TV never
    // reappeared anywhere, and one resumed from the web lost its poster the
    // moment the TV saved over it. Same `item` field the browser client sends.
    item?: Record<string, unknown>,
  ) =>
    post<{ ok: boolean }>(`/api/profiles/${profileId}/progress`, {
      itemId,
      position,
      duration,
      item,
    }),
  // Torrent sources for a title (movie) or episode (series). `title` is the
  // IMDb id; the server does the ranking (BEST/CAM/dubbed) and caps the list.
  torrentSources: (params: {
    type: 'movie' | 'series';
    title: string;
    year?: number | null;
    season?: number | null;
    episode?: number | null;
  }) => {
    const q = new URLSearchParams({ type: params.type, title: params.title });
    if (params.year) q.set('year', String(params.year));
    if (params.season) q.set('season', String(params.season));
    if (params.episode) q.set('episode', String(params.episode));
    return request<{ imdbId: string; streams: Stream[] }>(
      `/api/torrents/sources?${q.toString()}`,
    );
  },
  torrentStatus: (infoHash: string) =>
    request<TorrentStatus>(`/api/torrents/status/${infoHash}`),
  torrentSubtitles: (
    type: 'movie' | 'series',
    imdbId: string,
    season?: number | null,
    episode?: number | null,
  ) => {
    const q = new URLSearchParams();
    if (season) q.set('season', String(season));
    if (episode) q.set('episode', String(episode));
    const qs = q.toString();
    return request<{ subtitles: SubtitleTrack[] }>(
      `/api/torrents/subtitles/${type}/${imdbId}${qs ? `?${qs}` : ''}`,
    );
  },
  // Every download job the server knows about. The Sources screen keys these by
  // `infoHash:fileIdx` so a row can say "saved / downloading / queued" instead of
  // looking identical to the forty torrents around it.
  downloads: () => request<DownloadJob[]>('/api/downloads'),
  // Request a download-to-server. It starts immediately unless the server is
  // low on disk space, in which case `needsApproval` comes back true and an
  // admin has to approve it.
  requestDownload: (fields: Record<string, unknown>) =>
    post<{
      job?: unknown;
      error?: string;
      duplicate?: boolean;
      alreadyAvailable?: unknown;
      needsApproval?: boolean;
    }>('/api/downloads', fields),
  watchlist: (profileId: string) =>
    request<{ items: HeroItem[] }>(`/api/profiles/${profileId}/watchlist`),
  toggleWatchlist: (
    profileId: string,
    itemOrRef: string | StreamRef,
    add: boolean,
  ) =>
    post<{ watchlist: unknown }>(
      `/api/profiles/${profileId}/watchlist`,
      typeof itemOrRef === 'string'
        ? { itemId: itemOrRef, add }
        : { stream: itemOrRef, add },
    ),
};

export { ApiError };
