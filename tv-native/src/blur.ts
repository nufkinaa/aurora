// Blur-up placeholders — the site's public/js/blur.js, for the TV.
//
// A GET that says `X-Blur: 1` (api.ts request) gets one extra top-level field
// beside its answer: `_blur`, a map of picture address → a 16-pixel-wide WebP
// of that picture as a data: URI, about 150 bytes each (src/lib/blurup.js on
// the server). They are kept here, by address, so anything that draws a
// picture can ask for its placeholder without being handed it.
//
// THE KEY IS THE ADDRESS AS THE SERVER WROTE IT in the JSON — item.cover,
// item.poster, item.backdrop — not the absolute URL imgSrc() makes of it.
const map = new Map<string, string>();
const MAX = 3000;

/** Takes `_blur` out of an answer (so no screen ever sees it) and keeps it. */
export const takeBlur = <T>(body: T): T => {
  const b = body as unknown as {_blur?: Record<string, unknown>} | null;
  if (!b || typeof b !== 'object' || !b._blur) return body;
  try {
    for (const [u, uri] of Object.entries(b._blur)) {
      if (typeof uri === 'string' && uri.startsWith('data:image/')) map.set(u, uri);
    }
    // oldest out first: a Map keeps the order things were put in
    if (map.size > MAX) for (const k of [...map.keys()].slice(0, map.size - MAX)) map.delete(k);
  } catch {}
  delete b._blur;
  return body;
};

export const blurOf = (u: string | null | undefined): string | null => (u && map.get(u)) || null;

// Pictures this run has already drawn once, by absolute address. One of those
// is in the image pipeline's cache and appears within a frame, so a card that
// shows it again (rows mount their cards as they scroll) skips the
// placeholder altogether — no extra view to make and take away again.
const drawn = new Set<string>();
export const wasDrawn = (uri: string) => drawn.has(uri);
export const markDrawn = (uri: string) => {
  if (drawn.size > 4000) drawn.clear();
  drawn.add(uri);
};
