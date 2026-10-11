// Run INSTEAD of the server, in a private instance's folder (memory.js): load
// what the server loads, one owner at a time, and record what each step leaves
// on the heap after a full collection. Nothing listens, nothing is served.
// Prints one line: EFF_MEM_STEPS <json>.
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = process.cwd();
const req = (r) => require(path.join(ROOT, r));
const mb = (b) => Math.round((b / 1048576) * 100) / 100;
const settle = async () => { await new Promise((r) => setTimeout(r, 30)); global.gc(); global.gc(); return process.memoryUsage(); };
const fileMb = (rel) => { try { return mb(fs.statSync(path.join(ROOT, "data", rel)).size); } catch { return 0; } };

(async () => {
  const steps = [];
  let last = await settle();
  const step = async (name, files, fn) => {
    const t0 = process.hrtime.bigint();
    const c0 = process.cpuUsage();
    try { await fn(); } catch (e) { steps.push({ name, error: String((e && e.message) || e) }); return; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const c = process.cpuUsage(c0);
    const now = await settle();
    steps.push({ name, onDiskMb: mb(files.reduce((a, f) => a + fileMb(f) * 1048576, 0)), heapMb: mb(now.heapUsed - last.heapUsed), rssMb: mb(now.rss - last.rss), externalMb: mb(now.external - last.external), ms: Math.round(ms), cpuMs: Math.round((c.user + c.system) / 1000) });
    last = now;
  };
  const base = last;
  await step("node + express, compression, ws (code)", [], () => { require("express"); require("compression"); require("ws"); require("zlib"); });
  await step("config (finding ffmpeg & co.)", [], () => req("src/config"));
  await step("probe cache (metadata-cache.json)", ["metadata-cache.json"], () => req("src/media/metadata"));
  await step("by-name metadata (online-metadata.json)", ["online-metadata.json"], () => req("src/media/online"));
  await step("catalogue: trending, title pages, ratings (discover, meta, certificates)", ["cache/discover.json", "cache/meta.json", "cache/certificates.json"], () => req("src/media/discover"));
  await step("IMDb ids (imdb-map.json)", ["imdb-map.json"], () => req("src/media/imdb"));
  await step("library index: scanner.scan()", [], () => { req("src/media/scanner").scan(); });
  await step("profiles + history (profiles.json)", ["profiles.json"], () => req("src/profiles"));
  await step("identity stamps + title history fold", [], () => { req("src/media/identity").ensureStamped(); req("src/profiles").getProgressView(req("src/profiles").list()[0].id); });
  await step("sign-ins (sessions.json)", ["sessions.json"], () => req("src/lib/sessions"));
  await step("viewing sessions + hourly telemetry", ["watch-sessions.json", "telemetry-hours.json"], () => req("src/telemetry"));
  await step("realtime (bans, watch-history.json)", ["watch-history.json"], () => req("src/realtime"));
  await step("usage log replay (usage/events-*.jsonl)", [`usage/${fs.readdirSync(path.join(ROOT, "data", "usage"))[0] || "x"}`], () => req("src/lib/usage"));
  await step("stream source lists (torrent-streams.json) + torrent module", ["cache/torrent-streams.json"], () => req("src/media/torrent"));
  await step("More like this (similar.json)", ["cache/similar.json"], () => req("src/media/similar"));
  await step("X-Ray (xray.json)", ["cache/xray.json"], () => req("src/media/xray"));
  await step("availability, skip segments, intro records", ["cache/availability.json", "cache/skip-segments.json", "intro-auto.json"], () => { req("src/media/availability"); req("src/media/skipsegments"); req("src/media/introdetect"); });
  await step("well-known titles (search-known.json)", ["cache/search-known.json"], () => { req("src/media/wellknown").all(); });
  await step("search index: search.warm()", [], () => { req("src/media/search").warm(); });
  await step("recommender: title index file (recs-titles.json)", ["cache/recs-titles.json"], () => { req("src/media/recs/titleindex").all(); });
  await step("recommender: vectors (recs.warm())", [], async () => { await req("src/media/recs").warm(); });
  await step("every route module, healer, health, watchdog (code)", ["healer.json", "health.json"], () => {
    for (const r of ["auth", "api", "profiles", "stream", "ai", "admin", "requests", "torrent", "downloads", "subtitles", "reports", "usage", "proxy"]) req(`src/routes/${r}`);
    req("src/lib/healer"); req("src/lib/health"); req("src/lib/watchdog"); req("src/lib/daily"); req("src/media/follows"); req("src/media/librarywarm");
  });
  const end = await settle();
  const hs = require("v8").getHeapSpaceStatistics().map((s) => ({ space: s.space_name, usedMb: mb(s.space_used_size), committedMb: mb(s.physical_space_size) }));
  process.stdout.write(`EFF_MEM_STEPS ${JSON.stringify({ baseline: { heapMb: mb(base.heapUsed), rssMb: mb(base.rss) }, end: { heapMb: mb(end.heapUsed), rssMb: mb(end.rss), externalMb: mb(end.external) }, steps, spaces: hs })}\n`);
  process.exit(0);
})();
