// What a link opens in the phone app — PURE (no imports of the app), tested.
//
//   aurora://open?a=play|detail&d=<item json>     a notification ("… is ready
//   aurora-phone://open?a=…&d=…                    to watch"), the TV's format
//   https://nufurora.com/#/movie/<id>             the website's own addresses,
//   https://nufurora.com/#/show/<id>              shared from the site or the
//   https://nufurora.com/#/discover/movie/<tt…>   app's share sheet
//   https://nufurora.com/#/discover/series/<tt…>
//   https://nufurora.com/#/party/<code>           join a watch party
//   https://nufurora.com/#/remote                 Your TVs
//   https://nufurora.com/#/search?q=<words>       Search on those words (and the
//   https://nufurora.com/#/search/<words>         website's own form of it)
//   https://nufurora.com/#/play/<id>              play it (the website's "… is ready" push)
//   https://nufurora.com/#/new, #/household[/sent], #/saved
//   #/wrapped, #/taste[/list]                     Your Aurora Wrapped, Swipe your taste (its Edit list)
//   #/pick, #/requests                            website-only pages: said so, nothing opened
//   https://nufurora.com/#/downloads, #/list, #/movies, #/shows, #/preferences
//   https://nufurora.com/link?code=<CODE>         a TV's sign-in QR: "Sign in this TV?"
//   https://nufurora.com/link, #/pair[/<CODE>]    the same, or its type-the-code field
//   (aurora-phone://<same hash path> works too: aurora-phone://movie/<id>, aurora-phone://pair/<CODE>)
export type LinkItem = {id: string; title: string; type?: 'movie' | 'show'; imdbId?: string; source?: 'stream' | 'downloaded'} & Record<string, unknown>;
export type PhoneLink =
  | {kind: 'item'; action: 'play' | 'detail'; item: LinkItem}
  | {kind: 'party'; code: string}
  | {kind: 'search'; q: string}
  | {kind: 'pair'; code: string | null}
  | {kind: 'play'; id: string}
  | {kind: 'screen'; name: 'Remote' | 'Downloads' | 'Settings' | 'WhatsNew' | 'Household' | 'Wrapped' | 'Taste' | 'TasteList'; params?: Record<string, unknown>}
  | {kind: 'web'; path: string}
  | {kind: 'tab'; tab: 'home' | 'movies' | 'shows' | 'list' | 'search'};

const get = (query: string, k: string): string | null => {
  const m = query.split('&').find(p => p.startsWith(`${k}=`));
  if (!m) return null;
  try {
    return decodeURIComponent(m.slice(k.length + 1).replace(/\+/g, ' '));
  } catch {
    return null;
  }
};

// A TV's pairing code (src/lib/devicepair.js): six of its alphabet — no 0 / O / 1 / I / L.
export const PAIR_CODE_LEN = 6;
const PAIR_CODE_OK = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/;
/** What a person typed (or a link carried) as a TV's code → the code, or null when it cannot be one. */
export function pairCode(raw: unknown): string | null {
  const c = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return PAIR_CODE_OK.test(c) ? c : null;
}
/** The field's own clean-up while typing: capitals, letters and digits, six at most. */
export const typedPairCode = (raw: string) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, PAIR_CODE_LEN);

export function parsePhoneLink(url: string | null | undefined, hosts: string[] = ['nufurora.com']): PhoneLink | null {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  // the TV's (and the notifications') item links
  const open = /^(aurora|aurora-phone):\/\/open\?(.*)$/i.exec(u);
  if (open) {
    const d = get(open[2], 'd');
    if (!d) return null;
    try {
      const item = JSON.parse(d) as LinkItem;
      if (!item || typeof item.id !== 'string' || typeof item.title !== 'string') return null;
      return {kind: 'item', action: get(open[2], 'a') === 'play' ? 'play' : 'detail', item};
    } catch {
      return null;
    }
  }
  const hostOk = (h: string) => hosts.map(x => x.toLowerCase().replace(/^www\./, '')).includes(h.toLowerCase().replace(/^www\./, ''));
  // the TV's sign-in QR: {server}/link?code=XXXXXX (and {server}/link, where the TV
  // says "no camera handy? open … and type this code") — the server's /link redirect
  // to #/pair, answered here without the browser
  const link = /^https?:\/\/([^/?#]+)\/link\/?(?:\?([^#]*))?(?:#.*)?$/i.exec(u);
  if (link) return hostOk(link[1]) ? {kind: 'pair', code: pairCode(get(link[2] || '', 'code'))} : null;
  const ownLink = /^aurora-phone:\/\/link\/?(?:\?(.*))?$/i.exec(u);
  if (ownLink) return {kind: 'pair', code: pairCode(get(ownLink[1] || '', 'code'))};
  // the website's hash routes, on one of its hosts — or on the app's own scheme
  let path: string | null = null;
  const web = /^https?:\/\/([^/?#]+)\/?(?:index\.html)?(?:\?[^#]*)?#\/?(.*)$/i.exec(u);
  if (web) {
    if (!hostOk(web[1])) return null;
    path = web[2];
  } else {
    const own = /^aurora-phone:\/\/(.*)$/i.exec(u);
    if (own) path = own[1].replace(/^#\/?/, '');
  }
  if (path == null) return null;
  const [p, query = ''] = path.split('?');
  const parts = p.split('/').filter(Boolean).map(x => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  });
  const id = /^[A-Za-z0-9._|:-]{1,120}$/;
  const tt = /^tt\d{3,12}$/;
  switch (parts[0] || '') {
    case '':
    case 'home':
      return {kind: 'tab', tab: 'home'};
    case 'movie':
      return parts[1] && id.test(parts[1]) ? {kind: 'item', action: 'detail', item: {id: parts[1], title: '', type: 'movie', source: 'downloaded'}} : null;
    case 'show':
      return parts[1] && id.test(parts[1]) ? {kind: 'item', action: 'detail', item: {id: parts[1], title: '', type: 'show', source: 'downloaded'}} : null;
    case 'discover':
      if ((parts[1] === 'movie' || parts[1] === 'series') && parts[2] && tt.test(parts[2])) {
        return {kind: 'item', action: 'detail', item: {id: parts[2], imdbId: parts[2], title: '', type: parts[1] === 'series' ? 'show' : 'movie', source: 'stream'}};
      }
      return null;
    case 'party':
      return parts[1] && /^[A-Za-z0-9]{3,12}$/.test(parts[1]) ? {kind: 'party', code: parts[1].toUpperCase()} : null;
    case 'remote':
      return {kind: 'screen', name: 'Remote'};
    case 'pair':
      return {kind: 'pair', code: pairCode(parts[1])};
    case 'downloads':
      return {kind: 'screen', name: 'Downloads'};
    case 'preferences':
    case 'settings':
      return {kind: 'screen', name: 'Settings'};
    case 'search': {
      const q = (get(query, 'q') || parts.slice(1).join(' ') || '').trim().slice(0, 80);
      return q ? {kind: 'search', q} : {kind: 'tab', tab: 'search'};
    }
    case 'play':
      return parts[1] && id.test(parts[1]) ? {kind: 'play', id: parts[1]} : null;
    case 'new':
      return {kind: 'screen', name: 'WhatsNew'};
    case 'household':
      return {kind: 'screen', name: 'Household', params: parts[1] === 'sent' ? {tab: 'sent'} : undefined};
    case 'saved':
      return {kind: 'screen', name: 'Downloads'};
    case 'wrapped':
      return {kind: 'screen', name: 'Wrapped'};
    case 'taste':
      return {kind: 'screen', name: parts[1] === 'list' ? 'TasteList' : 'Taste'};
    case 'pick':
    case 'requests':
      return {kind: 'web', path: parts[0]};
    case 'list':
      return {kind: 'tab', tab: 'list'};
    case 'movies':
      return {kind: 'tab', tab: 'movies'};
    case 'shows':
      return {kind: 'tab', tab: 'shows'};
    default:
      return null;
  }
}

/** The website's address of a title, for the share sheet (what parsePhoneLink opens again). */
export function shareLink(base: string, it: {id?: string | null; imdbId?: string | null; type?: string | null; source?: string | null}): string | null {
  const root = (base || 'https://nufurora.com').replace(/\/+$/, '');
  const show = it.type === 'show' || it.type === 'series';
  if (it.source !== 'stream' && it.id && !String(it.id).startsWith('torrent|') && !String(it.id).startsWith('tt')) return `${root}/#/${show ? 'show' : 'movie'}/${it.id}`;
  if (it.imdbId) return `${root}/#/discover/${show ? 'series' : 'movie'}/${it.imdbId}`;
  return null;
}
