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
//   https://nufurora.com/#/search?q=<words>       Search on those words
//   https://nufurora.com/#/downloads, #/list, #/movies, #/shows, #/preferences
//   (aurora-phone://<same hash path> works too: aurora-phone://movie/<id>)
export type LinkItem = {id: string; title: string; type?: 'movie' | 'show'; imdbId?: string; source?: 'stream' | 'downloaded'} & Record<string, unknown>;
export type PhoneLink =
  | {kind: 'item'; action: 'play' | 'detail'; item: LinkItem}
  | {kind: 'party'; code: string}
  | {kind: 'search'; q: string}
  | {kind: 'screen'; name: 'Remote' | 'Downloads' | 'Settings'}
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
  // the website's hash routes, on one of its hosts — or on the app's own scheme
  let path: string | null = null;
  const web = /^https?:\/\/([^/?#]+)\/?(?:index\.html)?(?:\?[^#]*)?#\/?(.*)$/i.exec(u);
  if (web) {
    const host = web[1].toLowerCase().replace(/^www\./, '');
    if (!hosts.map(h => h.toLowerCase()).includes(host)) return null;
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
    case 'downloads':
      return {kind: 'screen', name: 'Downloads'};
    case 'preferences':
    case 'settings':
      return {kind: 'screen', name: 'Settings'};
    case 'search': {
      const q = (get(query, 'q') || '').trim().slice(0, 80);
      return q ? {kind: 'search', q} : {kind: 'tab', tab: 'search'};
    }
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
