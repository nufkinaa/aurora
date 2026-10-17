// GET /api/tv/tuning on a real (private) server: the rendering switches of
// config.json's "tvRender" reach the TV that asks — by its model — and a server
// that sets nothing answers with the measured start-up only (docs/qa/native-port/DEVICE-PLAN.md).
// A private instance (the UI tests' harness: a temp folder, a free port, no
// outbound network); without ffmpeg (its library is made with it) it is skipped.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { spawnSync } = require("child_process");

const haveFfmpeg = () => {
  try {
    const win = process.platform === "win32";
    return spawnSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { stdio: "ignore", windowsHide: true }).status === 0;
  } catch { return false; }
};

const get = (srv, url) =>
  new Promise((resolve) => {
    const req = http.request(`${srv.url}${url}`, { agent: false, timeout: 8000 }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, body: json, cache: res.headers["cache-control"] }); });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0 }); });
    req.on("error", () => resolve({ status: 0 }));
    req.end();
  });

test("tvRender reaches the TV that asks, by model; nothing set answers the measured start-up", { skip: !haveFfmpeg() && "ffmpeg not found", timeout: 180000 }, async () => {
  const { start } = require("../scripts/ui-test-server");
  const srv = await start({
    config: {
      tvPlayer: { startBufferMs: 1000 },
      tvRender: { cull: true, card: "yes", models: { "MiTV-AFMU0": { recommended: true, pool: false } } },
    },
    waitForLibrary: false,
  });
  try {
    const mi = await get(srv, "/api/tv/tuning?model=MiTV-AFMU0");
    assert.equal(mi.status, 200);
    assert.equal(mi.cache, "no-store");
    const D = { startBufferMs: 1000, rebufferMs: 5000, resumeAtSource: true };
    assert.deepEqual(mi.body, { ...D, tvRender: { cull: true, recommended: true, pool: false } });
    const other = await get(srv, "/api/tv/tuning?model=Chromecast%20HD");
    assert.deepEqual(other.body, { ...D, tvRender: { cull: true } });
    const old = await get(srv, "/api/tv/tuning");
    assert.deepEqual(old.body, { ...D, tvRender: { cull: true } });
  } finally {
    await srv.stop();
  }
  const bare = await start({ waitForLibrary: false });
  try {
    const r = await get(bare, "/api/tv/tuning?model=MiTV-AFMU0");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { startBufferMs: 1000, rebufferMs: 5000, resumeAtSource: true }, "no tvPlayer: the measured start-up; no tvRender: every rendering switch as the build says");
  } finally {
    await bare.stop();
  }
});
