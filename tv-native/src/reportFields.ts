// What a report says about the client, PURE: the one shape every report from this
// app carries, "Report a problem" and "Problem with this copy?" alike. The second
// built its own context with only a route and a look, so a report filed from the
// TV's player read "tv · · v?" in the admin panel (Niso's report, 2026-10-31).
export const clientFields = (o: {
  phone: boolean;
  tvVersion: string;
  phoneVersion: string;
  release?: string | null;
  model?: string | null;
  online: boolean;
  errors: string[];
}) => {
  const version = o.phone ? o.phoneVersion : o.tvVersion;
  const kind = o.phone ? 'phone' : 'tv';
  return {
    look: kind,
    viewport: kind,
    ua: o.phone
      ? `Aurora for Android ${version} · Android ${o.release || ''} · ${o.model || 'phone'}`
      : `Aurora TV ${version} · Android ${o.release || ''} · ${o.model || 'TV'}`,
    version,
    online: o.online,
    errors: o.errors,
  };
};

// [report trail] Facts about this device and app, gathered when a report is
// sent (docs/report-trail.md) — the same names as the site's `env`. PURE: the
// values are handed in (clientContext.ts reads them); a missing one is left out.
export const originOf = (url?: string | null) => {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(String(url || ''));
  return m ? m[1] : undefined;
};
export const appFacts = (o: {
  phone: boolean;
  version: string;
  build?: number | null;
  release?: string | null;
  api?: number | string | null;
  brand?: string | null;
  model?: string | null;
  screen?: {width: number; height: number; scale: number; fontScale?: number} | null;
  window?: {width: number; height: number} | null;
  locale?: string | null;
  tz?: string | null;
  lowRam?: boolean | null;
  auth?: string | null;
  signedIn?: boolean | null;
  server?: string | null;
  socket?: boolean | null;
  upMs?: number | null;
}) => {
  const out: Record<string, string | number | boolean> = {app: o.phone ? 'phone' : 'tv', v: o.version};
  const put = (k: string, v: string | number | boolean | null | undefined) => {
    if (v != null && v !== '') out[k] = v;
  };
  put('build', o.build || null);
  put('os', o.release ? `Android ${o.release}${o.api != null ? ` (API ${o.api})` : ''}` : null);
  put('model', [o.brand, o.model].filter(Boolean).join(' ') || null);
  if (o.screen) put('screen', `${Math.round(o.screen.width * o.screen.scale)}×${Math.round(o.screen.height * o.screen.scale)} @${Math.round(o.screen.scale * 100) / 100}x${o.screen.fontScale && o.screen.fontScale !== 1 ? `, text ×${Math.round(o.screen.fontScale * 100) / 100}` : ''}`);
  if (o.window) put('viewport', `${Math.round(o.window.width)}×${Math.round(o.window.height)} dp`);
  put('lang', o.locale);
  put('tz', o.tz);
  put('lowRam', o.lowRam == null ? null : o.lowRam);
  put('auth', o.auth);
  put('signedIn', o.signedIn == null ? null : o.signedIn);
  put('server', originOf(o.server));
  put('socket', o.socket == null ? null : o.socket ? 'open' : 'closed');
  if (o.upMs != null) put('up', Math.round(o.upMs / 1000));
  return out;
};
