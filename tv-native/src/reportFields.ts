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
