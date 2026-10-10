// The hosts /img/ext may fetch from (routes/stream.js) — the STRICT allow-list
// that keeps the artwork proxy from becoming an open one (the /proxy SSRF
// lesson): exact host match, https only. Redirects are checked against the
// same list, hop by hop.
//
// In a module of its own so the health endpoint can say what was ADDED after
// TV builds were already in the field (routes/auth.js /api/ping `imgHosts`),
// without loading the stream routes.

// What every client build has always been able to assume.
const BASE_HOSTS = [
  "image.tmdb.org",
  "images.metahub.space",
  "live.metahub.space",
  "static.tvmaze.com",
  // X-Ray portraits for films (media/xray.js): Commons' FilePath redirect
  // and the upload host it lands on
  "commons.wikimedia.org",
  "upload.wikimedia.org",
  "thumb.wikimedia.org",
];

// Added later. A TV build sends one of these through /img/ext only when the
// server it is talking to lists it in /api/ping — an older server would
// answer 403 and the picture would simply be missing.
//  - episodes.metahub.space: Cinemeta's episode stills (the `thumbnail` of
//    every episode in /api/discover/meta/series/…). A 301 to image.tmdb.org,
//    which is on the list. Proxied, the TV gets a cached 448-px WebP at LAN
//    speed instead of fetching a 780-px JPEG from the internet per episode
//    card and re-encoding it on the box.
const ADDED_HOSTS = ["episodes.metahub.space"];

const EXT_IMG_HOSTS = new Set([...BASE_HOSTS, ...ADDED_HOSTS]);

const extAllowed = (u) => {
  try {
    return typeof u === "string" && u.startsWith("https://") && EXT_IMG_HOSTS.has(new URL(u).host);
  } catch {
    return false;
  }
};

module.exports = { EXT_IMG_HOSTS, ADDED_HOSTS, extAllowed };
