// Blur-up placeholders: the tiny pictures the server sends beside a JSON
// answer (`_blur`, src/lib/blurup.js), kept by picture address so anything
// that draws a picture can ask for its placeholder without being handed it.
const map = new Map();
const MAX = 3000;

export const takeBlur = (body) => {
  if (!body || typeof body !== "object" || !body._blur) return body;
  try {
    for (const [u, uri] of Object.entries(body._blur)) {
      if (typeof uri === "string" && uri.startsWith("data:image/")) map.set(u, uri);
    }
    if (map.size > MAX) for (const k of [...map.keys()].slice(0, map.size - MAX)) map.delete(k);
  } catch {}
  delete body._blur;
  return body;
};

export const blurOf = (u) => (u && map.get(u)) || null;
