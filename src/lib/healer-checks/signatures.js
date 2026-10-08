// The errors Aurora KNOWS — what each one means in a sentence a person can
// act on, how bad it is, and where to press.
//
// Two kinds of evidence, one table:
//   re       a pattern over a warning/error line of the server's own log. The
//            patterns are written against the strings the code really prints
//            (the file each comes from is named beside it) — when a message
//            is reworded there, the test in test/healer-signatures.test.js
//            that feeds the real string through here fails.
//   signal   a count from lib/signals.js, for the things that go wrong
//            WITHOUT a log line: a provider answering 429, a rejected key, a
//            refused sign-in, a flood of connections.
//
// level   "fail"   something is broken now          (goes red, may alert)
//         "warn"   needs a look                      (amber)
//         "quiet"  routine — counted, never a finding, never a "new error"
// min     how many in the window before it is a finding (default 1)
// press   an Actions id: the button a person is sent to (never run from here)
// setting where else to go, in words
// repair  an automatic repair the healer may try (healer-checks/repairs.js)
//
// The first matching row wins, so the specific ones sit above the general.
"use strict";

const MIN15 = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const SIGNATURES = [
  // ---- the process itself ----
  {
    id: "crash", title: "Unexpected error", level: "fail",
    re: /\[uncaughtException\]|\[unhandledRejection\]/, // server.js
    means: "Aurora hit an error nothing was prepared for. It kept running, but whatever it was doing at that moment was dropped.",
    setting: "Server → Logs, filtered to errors: the lines starting [uncaughtException] say where it happened.",
  },
  {
    id: "disk-full", title: "A drive is full", level: "fail",
    re: /\bENOSPC\b|no space left on device/i, // node's error text, from any module that writes
    means: "A drive is full: Aurora could not write a file. Downloads, anything that needs converting, and saving progress all stop until there is room.",
    press: "sweep-streams", repair: "sweep-streams",
  },
  {
    id: "open-files", title: "Too many open files", level: "warn",
    re: /\bEMFILE\b|\bENFILE\b|too many open files/i,
    means: "Aurora has more files open than the system allows, and is being refused new ones. It usually clears by itself; if it keeps coming back, a restart clears it.",
    press: "restart",
  },
  {
    id: "port-in-use", title: "A port is taken", level: "fail",
    re: /\bEADDRINUSE\b|address already in use|\[fatal\] server failed to listen/i, // server.js; aria2's own stderr via [aria2]
    means: "A port Aurora needs is already held by another program — usually a second copy of Aurora, or a download engine left over from an earlier run.",
    setting: "Close the other copy (Task Manager: node.exe / aria2c.exe), then Server → Actions → Restart Aurora.",
  },
  {
    id: "permission", title: "Access refused", level: "warn",
    re: /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted/i,
    means: "Aurora was refused access to a file or folder. Whatever lives there cannot be read, saved or cleaned up.",
    setting: "Give the account Aurora runs under full access to the folder named in the line (Server → Logs).",
  },
  // ---- its own records ----
  {
    id: "store-save", title: "A data file could not be saved", level: "fail",
    re: /^Failed to save .+:/, // lib/jsonstore.js
    means: "A data file could not be saved. Progress, profiles or settings changed since then exist only in memory, and are lost if the server restarts now.",
    setting: "Look at the Disk line and the folder's permissions; do not restart until this stops.",
  },
  {
    id: "store-corrupt", title: "A data file was unreadable", level: "fail",
    re: /^Corrupt store .+ backed up to /, // lib/jsonstore.js
    means: "A data file was unreadable when Aurora started, so it began again from an empty one. The damaged file was kept beside it (its name ends .corrupt-…).",
    setting: "Restore the newest good snapshot from the Backups table.", press: "backup-verify",
  },
  {
    id: "config", title: "config.json was not read", level: "fail",
    re: /^config\.json missing or invalid/, // config.js
    means: "config.json could not be read, so Aurora is running on its defaults — the library folders and keys in it are being ignored.",
    setting: "Fix config.json (a missing comma or quote is the usual cause), then restart.",
  },
  {
    id: "backup", title: "A backup failed", level: "warn",
    re: /^\[backup\] (failed:|.+ has warnings:)/, // lib/backup.js
    means: "The last backup failed or came out incomplete.",
    press: "backup-now",
  },
  // ---- ffmpeg and the streams ----
  {
    id: "ffmpeg-missing", title: "ffmpeg will not start", level: "fail",
    re: /^ffmpeg spawn error:|spawn \S*ff(?:mpeg|probe)\S* ENOENT/i, // media/subtitles.js; node's spawn error
    means: "ffmpeg could not be started. Files that need converting will not play, and subtitles inside video files and thumbnails will be missing.",
    press: "versions",
  },
  {
    id: "jit-declined", title: "A file was sent down the slow path", level: "warn",
    re: /^\[jit\] .+ — declining this file/, // media/jit.js failJob
    means: "A video file's index does not match what is really in it, so it now plays through the slower stream. Replacing the file with a good copy fixes it.",
    press: "jit-forget-changed",
  },
  {
    id: "ffmpeg-failed", title: "Converting keeps failing", level: "warn", min: 3,
    // media/jit.js, media/remux.js, media/torrent-transcode.js, media/subtitles.js, media/ocr.js, media/offline.js
    re: /^\[jit\] |^Remux failed for |^\[torrent-transcode\] (?:ffmpeg exited \d+|input starved)|^ffmpeg failed extracting track |^Auto-OCR failed for |^\[offline\] failed /,
    means: "ffmpeg keeps failing while converting video. One odd file does this now and then (it is named under “Repeat offenders”); several different files at once means ffmpeg itself is not well.",
    press: "stream-test",
  },
  // ---- downloads ----
  {
    id: "engine", title: "The download engine is unsteady", level: "warn", min: 3,
    // media/aria2.js (its stderr and exit), media/downloads.js (poll, pump, limits)
    re: /^\[aria2\] |^\[download\] (?:progress poll failed|pump failed|could not tell the running engine|could not start a second source)/,
    means: "The download engine keeps stopping or not answering. The healer restarts it by itself; if this line stays, downloads are not moving.",
    setting: "If it does not settle: Server → Actions → Restart Aurora.",
  },
  {
    id: "torrent-client", title: "The streaming client reports errors", level: "warn", min: 5,
    re: /^\[torrent\] client error:|^\[torrent\] [0-9a-f]{8}… error:|^\[torrent\] (?:destroyStore|quiesce|unquiesce|scoping) failed/, // media/torrent.js
    means: "The part of Aurora that streams straight from a torrent is reporting errors. A single bad torrent does this; many at once usually means its patch is missing after an install.",
    press: "patch-webtorrent",
  },
  // ---- the outside world ----
  {
    id: "metadata", title: "Posters and descriptions are not arriving", level: "warn", min: 10,
    re: /^Metadata fetch failed for /, // media/online.js
    means: "The catalogue that supplies posters and descriptions is refusing or failing. New titles show without artwork until it recovers; nothing needs doing.",
  },
  {
    id: "ai", title: "The AI provider is failing", level: "warn", min: 3,
    re: /^\[ai\] (?:one call failed|recommend failed|model returned nothing usable)/, // media/ai.js, routes/ai.js
    means: "The AI provider (OpenRouter) is failing, so “recommend by mood” comes back empty.",
    setting: "Check the key and its credit: \"openrouterApiKey\" in config.json (or OPENROUTER_API_KEY in .env).",
  },
  {
    id: "push-signature", title: "Phones are refusing this server's notifications", level: "warn",
    re: /^\[push\] .*BadJwtToken|^\[push\] \S+ answered 40[13]\b/, // lib/push.js tickle
    means: "A push service is refusing this server's signature, so those phones get no notifications. The usual causes: the server's clock is wrong, or no contact address is set.",
    setting: "Set \"pushContact\" in config.json to \"mailto:you@example.com\", and look at the Clock line.",
  },
  {
    id: "push-failed", title: "Notifications are failing to send", level: "warn", min: 3,
    re: /^\[push\] (?:\S+ answered \d+|send failed:|not sent:)/, // lib/push.js, media/downloads.js
    means: "Notifications to phones and browsers are failing to send. “Your download is ready” will not arrive.",
  },
  {
    id: "notify", title: "Alerts are not being delivered", level: "warn",
    re: /^\[notify\] (?:ntfy|telegram) failed:/, // lib/notify.js
    means: "An alert could not be delivered (ntfy or Telegram). If something breaks now, nobody is told.",
    setting: "Check \"notifications\" in config.json; then prove it with the test alert.", press: "notify-test",
  },
  // ---- the server's own checks and background jobs ----
  {
    id: "self-check", title: "A check could not run", level: "warn", min: 3,
    re: /^\[health\] (?:a check could not run|round failed)|^\[healer\] round failed/, // lib/health.js, lib/healer.js
    means: "One of the server's own checks keeps failing to run, so that part is not being watched.",
  },
  {
    id: "routine", title: "Routine", level: "quiet",
    // server.js (webrtc, boot banner), lib/health.js (its own alerts), media/torrent.js (self-recovering reads),
    // media/downloads.js (re-queues the healer itself causes), lib/push.js (boot prune), media/ai.js (salvaged reply)
    re: /^\[webrtc\] .*\(benign\)|^\[health\] (?:ALERT|the health ping|health alerts have nowhere|healthPingUrl)|^\[torrent\] (?:bitfield distrusted|read stalled|.+ — resuming)|^\[download\] \w+ (?:re-queued|no second source)|^\[download\] could not remember a source outcome|^\[push\] dropped \d+ subscription|^\[ai\] reply was truncated|^\s*⚠ /,
  },
  {
    id: "background", title: "A background job keeps failing", level: "warn", min: 10,
    // lib/daily.js, media/follows.js, media/smartdl.js, media/smartclean.js, routes/profiles.js, media/introdetect.js,
    // media/similar.js, media/librarywarm.js, profiles.js, media/preconvert.js
    re: /^\[(?:daily|follow|smart|intro|similar|warm|profiles|preconvert)\] /,
    means: "A background job keeps failing (the tag in brackets says which: the daily refresh, follows, smart downloads, intro detection…). Nothing is lost, but its results go stale.",
    press: "daily-now",
  },

  // ---- counted, not logged (lib/signals.js) ----
  {
    id: "tmdb-key", title: "TMDB rejects the key", level: "warn",
    signal: { kind: "provider", key: /^tmdb:401$/, min: 2, windowMs: HOUR },
    means: "TMDB is rejecting this server's API key ({n} refusals in the last hour), so similar titles, vibes and age ratings come back empty.",
    setting: "Check \"tmdbApiKey\" in config.json (or TMDB_API_KEY in .env); keys are free at themoviedb.org.",
  },
  {
    id: "rate-limited", title: "A provider is rate-limiting", level: "warn",
    signal: { kind: "provider", key: /:429$/, min: 5, windowMs: MIN15 },
    means: "{keys} is turning this server away for asking too often ({n} refusals in 15 minutes). It recovers by itself when the requests slow down.",
  },
  {
    id: "subtitles-provider", title: "Subtitle providers are failing", level: "warn",
    signal: { kind: "provider", key: /^subtitles:(?:4\d\d|5\d\d)$/, min: 5, windowMs: HOUR },
    means: "The subtitle providers failed {n} requests in the last hour. Films may start without subtitles; fetch them again later from the title's page.",
  },
  {
    id: "provider-down", title: "A provider is failing", level: "warn",
    signal: { kind: "provider", key: /^(?!subtitles:|ai:).+:5\d\d$/, min: 5, windowMs: MIN15 },
    means: "{keys} is failing on its own side ({n} errors in 15 minutes). Search, sources or artwork may come back empty until it recovers.",
  },
  {
    id: "ai-provider", title: "The AI provider refuses", level: "warn",
    signal: { kind: "provider", key: /^ai:(?!ok$)/, min: 3, windowMs: HOUR },
    means: "The AI provider refused {n} requests in the last hour ({keys}).",
    setting: "Check the key and its credit: \"openrouterApiKey\" in config.json.",
  },
  {
    id: "signin-burst", title: "Repeated refused sign-ins", level: "warn",
    signal: { kind: "auth-fail", perKey: true, min: 10, windowMs: MIN15 },
    means: "The address {key} was refused {n} times in 15 minutes — a forgotten password, or somebody guessing.",
    setting: "If you do not recognise the address: People → the device with that address → Ban.",
  },
  {
    id: "ws-flood", title: "A flood of connections", level: "warn",
    signal: { kind: "ws", perKey: true, min: 60, windowMs: 5 * 60 * 1000 },
    means: "The address {key} opened {n} live connections in five minutes — a page stuck reloading, or something hammering the server.",
    setting: "People → the device with that address (Kick, or Ban if it is not yours).",
  },
  {
    id: "push-gone", title: "Notification subscriptions are dropping", level: "warn",
    signal: { kind: "push", key: /^gone$/, min: 5, windowMs: HOUR },
    means: "{n} devices' notification subscriptions were dropped in the last hour (the push service says they no longer exist). Those people have to switch notifications on again in Settings.",
  },
  {
    id: "push-bulk", title: "Most notifications are failing", level: "warn",
    signal: { kind: "push", key: /^fail:/, min: 5, windowMs: HOUR },
    means: "{n} notifications failed to send in the last hour ({keys}).",
    setting: "Look at the Clock line, and set \"pushContact\" in config.json.",
  },
];

const LOG_SIGS = SIGNATURES.filter((s) => s.re);
const SIGNAL_SIGS = SIGNATURES.filter((s) => s.signal);
const byId = new Map(SIGNATURES.map((s) => [s.id, s]));

// A log line -> the row it belongs to, or null when Aurora does not know it.
const classify = (msg) => {
  const text = String(msg || "");
  for (const s of LOG_SIGS) if (s.re.test(text)) return s;
  return null;
};

// The counted rows. `byKey(kind, windowMs)` answers a Map key -> n (that is
// lib/signals.js byKey; a test hands in its own). Returns one hit per row —
// or, for a per-key row, one per offending key.
const signalHits = (byKey) => {
  const hits = [];
  for (const s of SIGNAL_SIGS) {
    const g = s.signal;
    const tally = byKey(g.kind, g.windowMs) || new Map();
    const matched = [...tally].filter(([k]) => !g.key || g.key.test(k));
    if (g.perKey) {
      for (const [key, n] of matched) if (n >= g.min) hits.push({ sig: s, n, key, keys: [key] });
      continue;
    }
    const n = matched.reduce((a, [, c]) => a + c, 0);
    if (n >= g.min) hits.push({ sig: s, n, key: null, keys: matched.sort((a, b) => b[1] - a[1]).map(([k]) => k) });
  }
  return hits;
};

// "{n}", "{key}", "{keys}" in a row's sentence. A provider key reads
// "tmdb:429"; people are shown the name.
const NAMES = { tmdb: "TMDB", cinemeta: "Cinemeta (the catalogue)", torrentio: "Torrentio (the sources)", artwork: "the artwork host", subtitles: "the subtitle providers", ai: "OpenRouter", imdb: "IMDb" };
const sentence = (sig, hit = {}) => {
  const names = [...new Set((hit.keys || []).map((k) => { const [a, b] = String(k).split(":"); return NAMES[a] || (sig.signal && sig.signal.kind === "provider" ? a : b ? `${a} (${b})` : a); }))];
  return String(sig.means || "")
    .replace("{n}", hit.n == null ? "" : String(hit.n))
    .replace("{key}", hit.key || "")
    .replace("{keys}", names.slice(0, 3).join(", ") || "A provider");
};

module.exports = { SIGNATURES, classify, signalHits, sentence, byId };
