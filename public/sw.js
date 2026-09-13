// Aurora service worker: the app keeps working on a phone with no server
// in reach — the page and its code come from here, the last good answers
// to the few API calls the shell needs come from here, and titles saved
// for offline play from the media cache with proper Range support.
//
// Strategy, by path:
//   /offline/media/<id>   the saved copy (put there by js/offline.js) — cache
//                         only, Range-aware, never touches the network
//   /stream/*, /api/admin/*, /proxy/*, /avatars/*   untouched (live only)
//   /api/*  (GET)         network first; a short allow-list of answers is
//                         kept for offline (profiles, state, library, home…)
//   /img/*                cache first (posters don't change; fills as you go)
//   everything else       network first, cache fallback (the app shell)
const VERSION = "v1";
const SHELL = `aurora-shell-${VERSION}`;
const API = `aurora-api-${VERSION}`;
const IMG = `aurora-img-${VERSION}`;
const MEDIA = "aurora-media"; // never versioned away: it holds the saved films

const API_KEEP = [
  /^\/api\/me$/, /^\/api\/server-info$/, /^\/api\/profiles$/, /^\/api\/profiles\/[^/]+\/state$/,
  /^\/api\/library$/, /^\/api\/item\//, /^\/api\/home/, /^\/api\/changelog$/, /^\/api\/downloads/,
  /^\/api\/library\/for/, /^\/api\/party$/,
];
const LIVE_ONLY = [/^\/stream\//, /^\/api\/admin\//, /^\/proxy/, /^\/avatars\//, /^\/offline\/file\//, /^\/api\/offline\//, /^\/api\/torrents\//];

// Precache the whole shell from the server's manifest — every JS module and
// stylesheet, plus "/" — bypassing the HTTP cache so what lands here is what
// the server has now. Re-run whenever the manifest's version moves (the
// page pings "precache" on every load; a deploy costs one refetch).
const precache = async () => {
  const res = await fetch("/sw-manifest.json", { cache: "no-store" });
  if (!res.ok) return;
  const manifest = await res.json();
  const c = await caches.open(SHELL);
  const stamp = await c.match("/__shell-version");
  if (stamp && (await stamp.text()) === manifest.version) return;
  await Promise.all(
    (manifest.files || []).map((f) =>
      fetch(new Request(f, { cache: "reload" })).then((r) => (r.ok ? c.put(f, r) : null)).catch(() => null),
    ),
  );
  await c.put("/__shell-version", new Response(manifest.version));
};

self.addEventListener("install", (e) => {
  e.waitUntil(precache().catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && k !== API && k !== IMG && k !== MEDIA).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "precache") e.waitUntil(precache().catch(() => {}));
});

// A 206 sliced out of a cached full response, for <video> seeking.
const rangeResponse = async (cached, rangeHeader) => {
  const blob = await cached.blob();
  const size = blob.size;
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader || "");
  if (!m) {
    return new Response(blob, { status: 200, headers: { "Content-Type": blob.type || "video/mp4", "Content-Length": String(size), "Accept-Ranges": "bytes" } });
  }
  let start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10));
  let end = m[1] && m[2] ? parseInt(m[2], 10) : size - 1;
  if (isNaN(start) || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  end = Math.min(end, size - 1);
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": blob.type || "video/mp4",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
};

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;

  if (p.startsWith("/offline/media/")) {
    e.respondWith(
      caches.open(MEDIA).then(async (c) => {
        const hit = await c.match(p);
        if (!hit) return new Response("Not saved on this device", { status: 404 });
        return rangeResponse(hit, req.headers.get("range"));
      }),
    );
    return;
  }
  if (LIVE_ONLY.some((re) => re.test(p))) return;

  if (p.startsWith("/api/")) {
    const keep = API_KEEP.some((re) => re.test(p));
    e.respondWith(
      fetch(req)
        .then((res) => {
          // clone NOW: by the time caches.open resolves the page may have
          // consumed the body, and a late clone() throws (silently, here)
          if (keep && res.ok) {
            const copy = res.clone();
            caches.open(API).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const hit = keep ? await caches.match(req) : null;
          return hit || new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } });
        }),
    );
    return;
  }

  if (p.startsWith("/img/")) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(IMG).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          }),
      ),
    );
    return;
  }

  // the shell: html, css, js — fresh when the server is there, cached when not
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.mode === "navigate" || /\.(js|css|html)$/.test(p) || p === "/")) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = (await caches.match(req, { ignoreSearch: true })) || (await caches.match(p));
        if (hit) return hit;
        if (req.mode === "navigate") return (await caches.match("/")) || Response.error();
        return Response.error();
      }),
  );
});
