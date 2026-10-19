// A device's capability report on a real (private) server: POST /api/caps,
// the decision /api/item carries for it (?caps=), the person's "Surround
// sound" choice, and every answer without ?caps= exactly as before (TV round
// 2026-10-19, direct play). The UI tests' harness: a temp folder, a free
// port, no outbound network; without ffmpeg (its library is made with it)
// it is skipped.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");

const haveFfmpeg = () => {
  try {
    const win = process.platform === "win32";
    return spawnSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { stdio: "ignore", windowsHide: true }).status === 0;
  } catch { return false; }
};

const call = async (srv, method, url, body, headers = {}) => {
  const res = await fetch(srv.url + url, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};

// the realistic Mi TV / Amlogic report (tv-native/src/avCaps.ts builds the real one)
const MITV = {
  client: "tv", model: "MiTV-AFMU0", sdk: 34,
  video: { h264: { profiles: ["baseline", "main", "high"], maxW: 3840, maxH: 2160 }, hevc: { profiles: ["main", "main10"], maxW: 3840, maxH: 2160 }, vp9: { profiles: ["0", "2"] } },
  hdr: ["hdr10", "hlg"],
  audio: { decode: ["aac", "ac3", "eac3", "mp3", "opus", "flac"], passthrough: ["ac3", "eac3", "eac3-joc"], maxChannels: 8 },
  containers: { mp4: true, mkv: true, webm: true, ts: true },
  display: { w: 1920, h: 1080, hz: 60, modes: [[1920, 1080, 60], [1920, 1080, 24]] },
};
const CHROME = {
  client: "web",
  video: { h264: { profiles: ["baseline", "main", "high"] }, vp9: { profiles: ["0", "2"] }, av1: { profiles: ["main"] } },
  audio: { decode: ["aac", "mp3", "opus", "flac", "vorbis"], passthrough: [] },
  containers: { mp4: ["h264", "vp9", "av1"], mkv: ["h264", "vp9", "av1"], webm: ["vp9", "av1"] },
};

test("POST /api/caps → an id; /api/item?caps= carries how the title plays on that device", { skip: !haveFfmpeg() && "ffmpeg not found", timeout: 180000 }, async () => {
  const { start } = require("../scripts/ui-test-server");
  const srv = await start();
  try {
    // a report → its id (the same report, the same id)
    const a = await call(srv, "POST", "/api/caps", MITV);
    assert.equal(a.status, 200);
    assert.match(a.body.id, /^[0-9a-f]{16}$/);
    const again = await call(srv, "POST", "/api/caps", JSON.parse(JSON.stringify(MITV)));
    assert.equal(again.body.id, a.body.id);
    const kept = await call(srv, "GET", `/api/caps/${a.body.id}`);
    assert.equal(kept.status, 200);
    assert.equal(kept.body.client, "tv");
    assert.deepEqual(kept.body.audio.passthrough, ["ac3", "eac3", "eac3-joc"]);
    assert.equal((await call(srv, "POST", "/api/caps", { client: "toaster" })).status, 400);
    assert.equal((await call(srv, "GET", "/api/caps/0000000000000000")).status, 404);
    const chrome = (await call(srv, "POST", "/api/caps", CHROME)).body.id;

    const lib = (await call(srv, "GET", "/api/library")).body;
    const film1 = lib.movies.find((m) => /Film One/.test(m.title)); // MP4, H.264 + AAC
    const film2 = lib.movies.find((m) => /Film Two/.test(m.title)); // MKV, H.264 + AC-3 ×2
    assert.ok(film1 && film2, "the test library");

    // without ?caps=: the answer it always was
    const plain = (await call(srv, "GET", `/api/item/${film2.id}`)).body;
    assert.equal("play" in plain, false);
    // a report the server does not know: no decision (the client plays by its own rules)
    assert.equal("play" in (await call(srv, "GET", `/api/item/${film2.id}?caps=0123456789abcdef`)).body, false);

    // the Mi TV: AC-3 passed through, the file as it is
    const tv2 = (await call(srv, "GET", `/api/item/${film2.id}?caps=${a.body.id}`)).body.play;
    assert.equal(tv2.mode, "direct", tv2.why.join(" | "));
    assert.equal(tv2.audio, "passthrough");
    assert.equal(tv2.form, "ac3");
    assert.equal(tv2.fps, 25);
    assert.equal(tv2.tracks.length, 2);
    // Chrome: AC-3 is silent there → the picture copied, the sound made AAC
    const ch2 = (await call(srv, "GET", `/api/item/${film2.id}?caps=${chrome}`)).body.play;
    assert.equal(ch2.mode, "remux", ch2.why.join(" | "));
    assert.equal(ch2.audio, "convert");
    assert.equal(ch2.decodes, true);
    // both play Film One as it is
    for (const id of [a.body.id, chrome]) {
      assert.equal((await call(srv, "GET", `/api/item/${film1.id}?caps=${id}`)).body.play.mode, "direct");
    }

    // the person's "Surround sound: Stereo only" → decoded on the TV, never passed through
    const req = (await call(srv, "POST", "/api/profiles", { name: "Capsy", password: "pass-capsy", realName: "Capsy Tester", avatar: "🦊", color: "#2c9fe0" })).body;
    const p = (await call(srv, "POST", `/api/admin/profile-requests/${req.request.id}/approve`, {}, { "X-Admin-Password": srv.adminPassword })).body;
    const token = (await call(srv, "POST", `/api/profiles/${p.id}/unlock`, { password: "pass-capsy" })).body.token;
    const put = await call(srv, "PUT", `/api/profiles/${p.id}`, { prefs: { surround: "stereo", matchFrameRate: "off" } }, { "X-Profile-Token": token });
    assert.equal(put.status, 200);
    const prof = (await call(srv, "GET", "/api/profiles")).body.find((x) => x.id === p.id);
    assert.equal(prof.prefs.surround, "stereo");
    assert.equal(prof.prefs.matchFrameRate, "off");
    // (anything outside the closed sets is not stored)
    await call(srv, "PUT", `/api/profiles/${p.id}`, { prefs: { surround: "dolby", matchFrameRate: "sometimes" } }, { "X-Profile-Token": token });
    const prof2 = (await call(srv, "GET", "/api/profiles")).body.find((x) => x.id === p.id);
    assert.equal(prof2.prefs.surround, "stereo");
    assert.equal(prof2.prefs.matchFrameRate, "off");
    const st = (await call(srv, "GET", `/api/item/${film2.id}?profile=${p.id}&caps=${a.body.id}`, undefined, { "X-Profile-Token": token })).body.play;
    assert.equal(st.mode, "direct");
    assert.equal(st.audio, "decode");

    // the device checks' own read: every line of why
    const dbg = (await call(srv, "GET", `/api/caps/${a.body.id}/play/${film2.id}`)).body;
    assert.equal(dbg.play.mode, "direct");
    assert.equal(dbg.facts.container, "mkv");
    assert.ok(dbg.play.why.some((l) => /ac3 passthrough/.test(l)));
    // the server said so in its log, once
    assert.ok(srv.log().some((l) => /\[play\] .*→ direct \(ac3\)/.test(l)), "a [play] line in the log");
  } finally {
    await srv.stop();
  }
});
