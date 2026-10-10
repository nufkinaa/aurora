// The fixed vocabularies of the telemetry contract (docs/analytics.md). A
// value that is not on one of these lists is dropped by the server, whatever
// a client sends — which is what keeps titles, names and typed text out by
// construction rather than by good behaviour.
"use strict";

// ---- who is reporting
const DEVICES = new Set(["phone", "tablet", "desktop", "tv"]);
const NET_TIERS = new Set(["slow", "ok", "fast"]);
const AUTH_MODES = new Set(["open", "transition", "closed"]);
const INPUTS = new Set(["remote", "touch", "mouse", "keyboard", "pen"]);
// "look:glass", "lite", "lowram", "impl:n", "exp:rail2" … — letters, and at
// most two digits at the very end (an id has more, and has them anywhere)
const FLAG_RE = /^[a-z][a-z_:.-]{0,18}\d{0,2}$/;
// A screen: the site's route PATTERN ("/movie/:id") or the TV's screen name
// ("tv:browse/movie"). No digits and no capitals, so an id cannot pass.
const SCREEN_RE = /^(?:tv:)?[a-z/:_-]{1,40}$/;
const DIM_RE = SCREEN_RE;

// ---- error reports
// js       an uncaught error            promise  an unhandled rejection
// console  console.error / console.warn http     a request answered ≥ 400, or that never arrived
// img      pictures that would not load media    the video element / hls.js / ExoPlayer
// sw       service worker and update    stall    the main thread or the player stood still
// crash    the last run ended badly     mem      the system asked for memory back
// ws       the live socket              update   the TV's self-update
const ERROR_KINDS = new Set(["js", "promise", "console", "http", "img", "media", "sw", "stall", "crash", "mem", "ws", "update"]);
// the few numbers a report may carry
const CTX_KEYS = ["status", "code", "ms", "level", "attempt", "online", "fatal"];

// Known-benign reports: counted, but born "ignored" (the admin can un-ignore).
const BENIGN = [
  [/ResizeObserver loop/i, "the browser's own layout notice; nothing breaks"],
  [/^Script error\.?$/i, "an error in a script from another origin; nothing readable in it"],
  [/AbortError|The user aborted a request|The operation was aborted|signal is aborted/i, "a request cancelled by leaving the page"],
  [/play\(\) request was interrupted|play\(\) failed because the user didn't interact|NotAllowedError/i, "autoplay refused by the browser"],
  [/Transition was (?:aborted|skipped)|Skipped ViewTransition/i, "a page cross-fade that was cut short"],
  [/Non-Error promise rejection captured/i, "a rejection with nothing in it"],
  [/Require cycle:|VirtualizedList: You have a large list|new NativeEventEmitter/i, "a React Native development notice"],
  // an answer that is a person's own slip, not a fault: a wrong password, PIN or code
  [/^POST \/api\/(?:profiles\/:id\/unlock|auth\/(?:login|password|claim|device\/approve)|kids\/(?:enter|exit))(?:\?\S*)? → (?:401|403|429)$/, "a wrong password, PIN or code — somebody's answer, not a fault"],
];

// ---- timings: name -> { label, max ms, dims, from }
// `dims`: the metric's own split — a fixed list, or "screen" (SCREEN_RE).
// `from: "server"`: measured here; a client cannot send it.
const PATHS = ["direct", "remux", "transcode", "torrent", "offline"];
const MIN = 60 * 1000;
const TIMINGS = {
  app_start_home: { label: "App start → Home usable", max: 5 * MIN },
  gate_home: { label: "Profile picked → Home usable", max: 5 * MIN },
  nav_paint: { label: "Screen change → first content", max: 2 * MIN, dims: "screen" },
  title_content: { label: "Title page → content shown", max: 2 * MIN, dims: ["library", "catalogue"] },
  title_backdrop: { label: "Title page → backdrop shown", max: 2 * MIN, dims: ["library", "catalogue"] },
  grid_first_poster: { label: "Grid → first poster", max: 2 * MIN, dims: "screen" },
  search_results: { label: "Search keystroke → results", max: 2 * MIN, dims: ["library", "catalogue"] },
  play_first_frame: { label: "Play pressed → first frame", max: 10 * MIN, dims: PATHS },
  seek_resume: { label: "Seek → playing again", max: 5 * MIN, dims: PATHS },
  ws_reconnect: { label: "Live socket lost → back", max: 30 * MIN },
  update_check: { label: "TV update check", max: 2 * MIN },
  update_download: { label: "TV update download", max: 60 * MIN },
  update_installed: { label: "TV update offered → running it", max: 7 * 24 * 60 * MIN },
  srv_home: { label: "Server: /api/home", max: 5 * MIN, from: "server" },
  srv_search: { label: "Server: /api/search", max: 5 * MIN, from: "server" },
  srv_suggest: { label: "Server: /api/search/suggest", max: 5 * MIN, from: "server" },
  srv_item: { label: "Server: /api/item/:id", max: 5 * MIN, from: "server" },
  srv_library: { label: "Server: /api/library", max: 5 * MIN, from: "server" },
  srv_catalog: { label: "Server: /api/catalog", max: 5 * MIN, from: "server" },
  srv_discover: { label: "Server: /api/discover/meta", max: 5 * MIN, from: "server" },
  srv_img: { label: "Server: /img/*", max: 5 * MIN, dims: ["variant", "original"], from: "server" },
  dl_wait_approval: { label: "Download: asked → approved", max: 14 * 24 * 60 * MIN, dims: ["auto", "asked"], from: "server" },
  dl_wait_slot: { label: "Download: approved → started", max: 14 * 24 * 60 * MIN, from: "server" },
  dl_transfer: { label: "Download: started → in the library", max: 14 * 24 * 60 * MIN, from: "server" },
  dl_total: { label: "Download: asked → in the library", max: 14 * 24 * 60 * MIN, from: "server" },
};

// ---- controls: id -> which apps have it ("w" the site, "t" the TV app)
// One id per control, the same id on both apps where both have it. A control
// is tagged where it is built (`data-ui="…"` on the site, `uiId="…"` on the
// TV); test/tel-contract.test.js fails when a tag is not on this list, or an
// id here is tagged nowhere.
const CONTROLS = require("./controls-vocab");

// ---- address shapes: the path words the server itself has, so a request
// address can be reduced to its route ("/api/item/:id") — any other word in a
// path is an id or a name, and becomes ":id". Extensions (".m3u8") and query
// keys ("?w") are on the same list. test/tel-contract.test.js checks it
// against the routes in src/routes.
const SEGMENTS = new Set((
  "actions admin ai alerts analytics api approve aria2-limits auth auth-mode auto avatar-image avatars backups ban bans broadcast cancel catalog changelog " +
  "claim claimable clear clear-caches clients collection css decline describe device discover disk dismiss download downloads email embedded enter exit ext " +
  "fetch file follow for force-reset frame genres google google-check heal healer health healthz hls home imdb-for img intro intros item jit keep key kick " +
  "kids kids-pin library link lock log login logout logs mark me meta mylist netprobe offline options overview party password pending pending-counts people " +
  "perf-mark person ping play-mark poll popular poster preferences prepare probe profile-access profile-requests profile-token profiles progress proxy pull push " +
  "rating recommend reject remove report reports requests rescan restart run runs search searches seen segments server server-info sessions settings signin " +
  "signout-everywhere signup similar sources start state stats status still stream sub subtitle subtitles suggest taste telemetry timeseries today torrent " +
  "torrents trailer transcode tree tv-app unban unlock update update-check upnext-dismiss usage video watch-history watchlist web web-callback web-finish " +
  "web-start websub wrapped xray errors alert-rules " +
  "js screens vendor ws " +
  ".m3u8 .ts .m4s .mp4 .mkv .webm .vtt .srt .jpg .jpeg .png .webp .avif .svg .gif .ico .js .css .json .html .txt .apk .woff2 .webmanifest " +
  "?a ?blur ?category ?code ?days ?duration ?episode ?error ?fmt ?force ?genre ?head ?hevc ?imdbid ?intent ?itemid ?k ?kb ?keys ?limit ?page ?profile ?pw " +
  "?q ?season ?seek ?seg ?slim ?state ?t ?title ?tmdbid ?type ?u ?url ?v ?vtag ?w ?h ?y ?year ?r"
).split(/\s+/));
// the query keys whose (small, numeric) value is kept: a size, not content
const QUERY_KEEP = new Set(["w", "h"]);

module.exports = { DEVICES, NET_TIERS, AUTH_MODES, INPUTS, FLAG_RE, SCREEN_RE, DIM_RE, ERROR_KINDS, CTX_KEYS, BENIGN, TIMINGS, PATHS, CONTROLS, SEGMENTS, QUERY_KEEP };
