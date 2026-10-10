// The healer's table of KNOWN errors (src/lib/healer-checks/signatures.js),
// held against the strings the code really prints. Every sample below names
// the file it comes from and a piece of the literal text in that file: when
// somebody rewords a message, the "still in the source" half fails here and
// says which signature needs a look.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const sigs = require("../src/lib/healer-checks/signatures");
const signals = require("../src/lib/signals");

const ROOT = path.join(__dirname, "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// [signature id, source file, a literal piece of the message in that file, the line as it lands in the log]
const REAL = [
  ["crash", "server.js", 'console.error("[uncaughtException]"', "[uncaughtException] TypeError: Cannot read properties of null (reading 'reserve')\n    at Torrent._request (C:\\elia\\aurora\\node_modules\\webtorrent\\lib\\torrent.js:1790:30)"],
  ["crash", "server.js", 'console.error("[unhandledRejection]"', "[unhandledRejection] Error: fetch failed"],
  ["wall-refused", "server.js", "`[auth] 401 ${bucket}", "[auth] 401 /img/a009d1dfcfaa ua=okhttp/4.12.0 cookie=dead x-session=none token=yes"],
  ["port-in-use", "server.js", '"[fatal] server failed to listen:"', "[fatal] server failed to listen: listen EADDRINUSE: address already in use :::4000"],
  ["store-save", "src/lib/jsonstore.js", "Failed to save ${this.filePath}:", "Failed to save C:\\elia\\aurora\\data\\profiles.json: EBUSY: resource busy or locked, rename"],
  ["store-corrupt", "src/lib/jsonstore.js", "Corrupt store ${filePath} — backed up to ${backup}", "Corrupt store C:\\elia\\aurora\\data\\profiles.json — backed up to C:\\elia\\aurora\\data\\profiles.json.corrupt-1760000000000, starting from defaults"],
  ["config", "src/config.js", '"config.json missing or invalid, using defaults:"', "config.json missing or invalid, using defaults: Unexpected token } in JSON at position 512"],
  ["backup", "src/lib/backup.js", "[backup] failed: ${error}", "[backup] failed: the snapshot did not pass its own check"],
  ["backup", "src/lib/backup.js", "[backup] ${snap.name} has warnings:", "[backup] aurora-2026-10-08.tar has warnings: profiles.json does not parse"],
  ["ffmpeg-missing", "src/media/subtitles.js", '"ffmpeg spawn error:"', "ffmpeg spawn error: spawn C:\\ffmpeg\\bin\\ffmpeg.exe ENOENT"],
  ["jit-declined", "src/media/jit.js", '" — declining this file"', "[jit] 0a1b2c3d4e5f-1760000000000: keyframe at 512.2s is not where the index says (510.0s) — declining this file"],
  ["ffmpeg-failed", "src/media/jit.js", "[jit] producer exited ${code}", "[jit] producer exited 1 (0a1b2c3d4e5f-1760000000000 @seg42): Invalid data found when processing input"],
  ["ffmpeg-failed", "src/media/jit.js", "init.mp4 differs between producers", "[jit] 0a1b2c3d4e5f-1760000000000-f4: init.mp4 differs between producers"],
  ["ffmpeg-failed", "src/media/remux.js", "Remux failed for ${videoPath}:", "Remux failed for D:\\Movies\\Some Film (2020)\\Some.Film.mkv: Conversion failed!"],
  ["ffmpeg-failed", "src/media/torrent-transcode.js", "[torrent-transcode] ffmpeg exited ${code}", "[torrent-transcode] ffmpeg exited 1 (a1b2c3d4…): Error while decoding stream"],
  ["ffmpeg-failed", "src/media/torrent-transcode.js", "[torrent-transcode] input starved:", "[torrent-transcode] input starved: 1024/900000 bytes reached ffmpeg — evicting truncated output (a1b2c3d4…)"],
  ["ffmpeg-failed", "src/media/subtitles.js", "ffmpeg failed extracting track ${trackIndex} from ${videoPath}:", "ffmpeg failed extracting track 2 from D:\\Shows\\Show\\S01E01.mkv: (no stderr)"],
  ["ffmpeg-failed", "src/media/ocr.js", "Auto-OCR failed for ${job.displayName}:", "Auto-OCR failed for Some.Film.mkv: tesseract: not found"],
  ["ffmpeg-failed", "src/media/offline.js", "[offline] failed ${id} at ${q}:", "[offline] failed 0a1b2c3d4e5f at 720: ffmpeg exited 1"],
  ["engine", "src/media/aria2.js", "[aria2] daemon exited (code ${code})", "[aria2] daemon exited (code 1)"],
  ["engine", "src/media/aria2.js", '"[aria2] start failed', "[aria2] start failed — the daemon will be respawned on the next request"],
  ["engine", "src/media/aria2.js", "[aria2] could not apply speed caps:", "[aria2] could not apply speed caps: fetch failed"],
  ["engine", "src/media/downloads.js", '"[download] progress poll failed:"', "[download] progress poll failed: fetch failed"],
  ["engine", "src/media/downloads.js", '"[download] pump failed:"', "[download] pump failed: aria2.addUri: The given uri is invalid"],
  ["torrent-client", "src/media/torrent.js", '"[torrent] client error:"', "[torrent] client error: Client is destroyed"],
  ["torrent-client", "src/media/torrent.js", "… error:`", "[torrent] a1b2c3d4… error: Invalid torrent identifier"],
  ["metadata", "src/media/online.js", 'Metadata fetch failed for "${item.title}"', 'Metadata fetch failed for "Some Film": 429'],
  ["ai", "src/media/ai.js", "[ai] one call failed after", "[ai] one call failed after 20.1s: OpenRouter 402 after 0.4s: insufficient credits"],
  ["ai", "src/routes/ai.js", '"[ai] recommend failed:"', "[ai] recommend failed: OpenRouter 401 after 0.2s"],
  ["push-signature", "src/lib/push.js", "answered ${r.status} ${why.slice(0, 160)}", '[push] web.push.apple.com answered 403 {"reason":"BadJwtToken"}'],
  ["push-failed", "src/lib/push.js", "answered ${r.status} ${why.slice(0, 160)}", "[push] fcm.googleapis.com answered 500 internal"],
  ["push-failed", "src/lib/push.js", '"[push] send failed:"', "[push] send failed: The operation was aborted due to timeout"],
  ["push-failed", "src/media/downloads.js", '"[push] not sent:"', "[push] not sent: bad subscription"],
  ["notify", "src/lib/notify.js", '"[notify] ntfy failed:"', "[notify] ntfy failed: fetch failed"],
  ["notify", "src/lib/notify.js", '"[notify] telegram failed:"', '[notify] telegram failed: {"ok":false,"error_code":401,"description":"Unauthorized"}'],
  ["self-check", "src/lib/health.js", "[health] a check could not run:", "[health] a check could not run: EIO: i/o error, statfs"],
  ["self-check", "src/lib/healer.js", '"[healer] round failed:"', "[healer] round failed: boom"],
  ["routine", "server.js", "web peer(s) dropped mid-handshake (benign)", "[webrtc] 3 web peer(s) dropped mid-handshake (benign)"],
  ["routine", "src/lib/health.js", "[health] ALERT warn ${check.id}", "[health] ALERT warn backup-stale — There has been no working backup for 50 hours (one is made every day)."],
  ["routine", "src/media/torrent.js", "[torrent] read stalled — recreating stream at", "[torrent] read stalled — recreating stream at +1048576 bytes (Some.Film.mkv)"],
  ["routine", "src/media/downloads.js", "re-queued: ${why", "[download] a1b2c3 re-queued: restarted by the healer: stuck at 40% for 16 min"],
  ["routine", "src/media/mylistdl.js", "could not queue ${labelOf(rec)}: ${rec.failReason}", "[mylist] could not queue Some Film: no source"],
  ["routine", "src/media/mylistdl.js", "download failed ${labelOf(rec)}: ${rec.failReason}", "[mylist] download failed Some Show · S1 E1: no peers for 30 minutes"],
  ["routine", "src/media/mylistdl.js", "could not delete ${labelOf(rec)} yet:", "[mylist] could not delete Some Film yet: EBUSY: resource busy or locked, unlink"],
  ["routine", "src/media/downloads.js", '[mylist] held "${job.label || job.title}" at', '[mylist] held "Some Film" at 40% — another download needs the queue; what it has is kept'],
  ["routine", "src/media/downloads.js", '[mylist] held "${job.label || job.title}" at', '[mylist] held "Some Show · S1 E1" at 12% — someone is watching; what it has is kept'],
  ["routine", "src/media/downloads.js", '[mylist] resumed "${job.label || job.title}" from', '[mylist] resumed "Some Film" from 40% (on hold since 2026-10-10T18:00:00.000Z)'],
  ["background", "src/routes/profiles.js", '"[mylist] pass failed:"', "[mylist] pass failed: boom"],
  ["background", "src/media/mylistdl.js", "pass failed: ${(e && e.message) || e}", "[mylist] pass failed: Cannot read properties of undefined"],
  ["background", "src/lib/daily.js", "[daily] ${name} failed:", "[daily] backup failed: the backup folder is not reachable"],
  ["background", "src/media/follows.js", '"[follow] check failed:"', "[follow] check failed: fetch failed"],
  ["background", "src/media/introdetect.js", '"[intro] pass failed:"', "[intro] pass failed: boom"],
  ["background", "src/media/preconvert.js", "[preconvert] ${libraryId}: ${e.message}", "[preconvert] 0a1b2c3d4e5f: no room"],
];

test("every known signature recognises the line the code really prints", () => {
  for (const [id, file, needle, line] of REAL) {
    assert.ok(src(file).includes(needle), `${file} no longer contains ${JSON.stringify(needle)} — the message was reworded; update signature "${id}"`);
    const got = sigs.classify(line);
    assert.ok(got, `nothing recognised: ${line}`);
    assert.equal(got.id, id, line);
  }
});

test("the system's own error codes are recognised wherever they turn up", () => {
  const cases = [
    ["disk-full", "[download] pump failed: ENOSPC: no space left on device, write"],
    ["disk-full", "Failed to save C:\\elia\\aurora\\data\\profiles.json: ENOSPC: no space left on device, write"],
    ["open-files", "Error: EMFILE: too many open files, open 'D:\\\\Movies\\\\a.mkv'"],
    ["open-files", "Remux failed for D:\\a.mkv: ENFILE: file table overflow"],
    ["port-in-use", "[aria2] Failed to bind a socket, cause: Address already in use"],
    ["permission", "[aria2] could not purge D:\\staging\\abc: EPERM: operation not permitted, rmdir"],
    ["permission", "Remux failed for /mnt/media/a.mkv: EACCES: permission denied"],
  ];
  for (const [id, line] of cases) assert.equal((sigs.classify(line) || {}).id, id, line);
  // an uncaught error outranks the code inside it only when it IS uncaught
  assert.equal(sigs.classify("[uncaughtException] Error: ENOSPC: no space left on device").id, "crash");
});

test("a line Aurora has no row for is unknown, and a routine line is quiet", () => {
  assert.equal(sigs.classify("[xray] the cast list came back in an unexpected shape"), null);
  assert.equal(sigs.classify("something nobody wrote a rule for"), null);
  assert.equal(sigs.classify("[webrtc] 1 web peer(s) dropped mid-handshake (benign)").level, "quiet");
});

test("every row is complete: a sentence, a level, and a button that exists", () => {
  const actions = new Set(require("../src/lib/adminactions")._internals.ACTIONS.map((a) => a.id));
  const repairs = require("../src/lib/healer-checks/repairs").REPAIRS;
  const ids = new Set();
  for (const s of sigs.SIGNATURES) {
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.ok(["fail", "warn", "quiet"].includes(s.level), s.id);
    assert.ok(!!s.re !== !!s.signal, `${s.id}: exactly one kind of evidence`);
    if (s.level !== "quiet") assert.ok(s.means && s.means.length > 30 && /\.$/.test(s.means.trim()), `${s.id} needs a plain sentence`);
    if (s.press) assert.ok(actions.has(s.press), `${s.id} points at an action that does not exist: ${s.press}`);
    if (s.repair) assert.ok(repairs[s.repair], `${s.id} names a repair that does not exist: ${s.repair}`);
  }
  // the classes the owner asked for, by name
  for (const id of ["disk-full", "open-files", "port-in-use", "permission", "store-save", "store-corrupt", "ffmpeg-missing", "ffmpeg-failed", "engine", "rate-limited", "provider-down", "tmdb-key", "ai", "ai-provider", "push-signature", "push-failed", "push-gone", "notify", "subtitles-provider", "ws-flood", "signin-burst", "crash"]) {
    assert.ok(ids.has(id), `missing signature: ${id}`);
  }
});

// ---- the counted ones (no log line): lib/signals.js

const tallyOf = (hits) => (kind) => {
  const m = new Map();
  for (const [k, key, n] of hits) if (k === kind) m.set(key, (m.get(key) || 0) + n);
  return m;
};

test("counted problems: a rejected TMDB key, rate limits, provider trouble, subtitles, AI", () => {
  const hits = sigs.signalHits(tallyOf([
    ["provider", "tmdb:401", 3], ["provider", "tmdb:ok", 40],
    ["provider", "cinemeta:429", 4], ["provider", "torrentio:429", 2],
    ["provider", "torrentio:503", 6],
    ["provider", "subtitles:500", 5],
    ["provider", "ai:402", 3],
  ]));
  const ids = hits.map((h) => h.sig.id).sort();
  assert.deepEqual(ids, ["ai-provider", "provider-down", "rate-limited", "subtitles-provider", "tmdb-key"]);
  const rl = hits.find((h) => h.sig.id === "rate-limited");
  assert.equal(rl.n, 6);
  assert.match(sigs.sentence(rl.sig, rl), /Cinemeta.*Torrentio.*6 refusals/);
  assert.match(sigs.sentence(hits.find((h) => h.sig.id === "tmdb-key").sig, hits.find((h) => h.sig.id === "tmdb-key")), /3 refusals/);
  // below the line: nothing
  assert.deepEqual(sigs.signalHits(tallyOf([["provider", "tmdb:401", 1], ["provider", "cinemeta:429", 4], ["provider", "tmdb:ok", 900]])), []);
});

test("counted problems: one address guessing passwords, one address flooding, push subscriptions dropping", () => {
  const hits = sigs.signalHits(tallyOf([
    ["auth-fail", "203.0.113.9", 14], ["auth-fail", "10.0.0.5", 2],
    ["ws", "10.0.0.7", 75], ["ws", "10.0.0.8", 12],
    ["push", "gone", 6], ["push", "fail:403", 7], ["push", "ok", 1],
  ]));
  const guess = hits.filter((h) => h.sig.id === "signin-burst");
  assert.equal(guess.length, 1, "only the address over the line");
  assert.equal(guess[0].key, "203.0.113.9");
  assert.match(sigs.sentence(guess[0].sig, guess[0]), /203\.0\.113\.9 was refused 14 times/);
  assert.equal(hits.filter((h) => h.sig.id === "ws-flood")[0].key, "10.0.0.7");
  assert.ok(hits.some((h) => h.sig.id === "push-gone"));
  assert.ok(hits.some((h) => h.sig.id === "push-bulk"));
});

test("signals: bounded, windowed, and a URL is filed under its provider's name", () => {
  signals._reset();
  const now = 1e12;
  signals.hit("provider", "tmdb:429", now - 20 * 60000);
  signals.hit("provider", "tmdb:429", now - 60000);
  signals.hit("provider", "tmdb:ok", now - 1000);
  assert.equal(signals.count("provider", 15 * 60000, now), 2);
  assert.equal(signals.byKey("provider", 3600000, now).get("tmdb:429"), 2);
  assert.equal(signals.providerOf("https://api.themoviedb.org/3/find/tt1"), "tmdb");
  assert.equal(signals.providerOf("https://v3-cinemeta.strem.io/meta/movie/tt1.json"), "cinemeta");
  assert.equal(signals.providerOf("https://torrentio.strem.fun/stream/movie/tt1.json"), "torrentio");
  assert.equal(signals.providerOf("https://openrouter.ai/api/v1/chat/completions"), "ai");
  assert.equal(signals.providerOf("https://example.org/x"), "example.org");
  signals.provider("https://api.themoviedb.org/3/x", 401);
  signals.provider("https://api.themoviedb.org/3/x", 200);
  assert.equal(signals.byKey("provider", 60000).get("tmdb:401"), 1);
  assert.equal(signals.byKey("provider", 60000).get("tmdb:ok"), 1);
  for (let i = 0; i < 5000; i++) signals.hit("ws", "1.2.3.4", now);
  assert.ok(signals.list("ws", 1000, now).length <= 4000, "a flood cannot grow the list without end");
  signals._reset();
});

test("the places that count are wired: providers, refused sign-ins, connections, encoders, push", () => {
  const wired = [
    ["src/media/online.js", 'signals").provider(url, res.status)'],
    ["src/media/discover.js", 'signals").provider(url, res.status)'],
    ["src/media/websubs.js", 'signals").provider(url, res.status)'],
    ["src/media/torrent.js", 'signals").provider(url, res.status)'],
    ["src/media/vibe.js", 'signals").provider(TMDB, res.status)'],
    ["src/media/similar.js", 'signals").provider(TMDB, res.status)'],
    ["src/media/ai.js", 'signals").provider(ENDPOINT, res.status)'],
    ["src/routes/auth.js", 'signals").hit("auth-fail"'],
    ["src/routes/admin.js", 'signals").hit("auth-fail"'],
    ["src/realtime.js", 'signals").hit("ws", ip)'],
    ["src/media/jit.js", 'signals").hit("no-encoder"'],
    ["src/media/remux.js", 'signals").hit("no-encoder"'],
    ["src/routes/stream.js", 'signals").hit("seg-wait"'],
    ["src/lib/push.js", 'signals").hit("push"'],
  ];
  for (const [file, needle] of wired) assert.ok(src(file).includes(needle), `${file} no longer counts (${needle})`);
});
