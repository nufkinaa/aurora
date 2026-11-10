// Home's remark on a real (private) server: GET /api/profiles/:id/remark —
// the gate in front of it (a profile's own token only), the answer's shape,
// the ten-minute hold, a kids profile, Wrapped's ready roasts, and what a
// call costs (p50/p95 over 200 calls, printed). The rules themselves are
// pinned in test/remarks.test.js.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");

const haveFfmpeg = () => {
  try {
    const win = process.platform === "win32";
    return spawnSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { stdio: "ignore", windowsHide: true }).status === 0;
  } catch { return false; }
};

test("Home's remark, end to end", { skip: !haveFfmpeg() && "ffmpeg not found", timeout: 240000 }, async (t) => {
  const { start } = require("../scripts/ui-test-server");
  const { makeApi } = require("./ui/helpers");
  const srv = await start();
  const api = makeApi(srv);
  try {
    const dana = await api.createProfile("Dana");
    const eli = await api.createProfile("Eli");
    const noa = await api.createProfile("Noa", { open: true, kids: { maxAge: 7 } });
    const asDana = await api.as(dana);
    const asEli = await api.as(eli);
    const q = "?tzo=-120&tz=Asia%2FJerusalem";

    await t.test("the gate: no token, another profile's token, no such profile", async () => {
      assert.equal((await api.call("GET", `/api/profiles/${dana.id}/remark${q}`)).status, 401);
      assert.equal((await api.call("GET", `/api/profiles/${dana.id}/remark${q}`, undefined, asEli)).status, 401);
      assert.equal((await api.call("GET", `/api/profiles/nope00000000/remark${q}`, undefined, asDana)).status, 404);
    });

    await t.test("the answer: { id, text, kind }, a line that fits, held on the next visit", async () => {
      const r = await api.call("GET", `/api/profiles/${dana.id}/remark${q}&seen=em-1,zz-9,ex-2`, undefined, asDana);
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.body).sort(), ["id", "kind", "text"]);
      assert.match(r.body.id, /^[a-z]+\d?-\d+$/);
      assert.ok(r.body.text.length > 0 && r.body.text.length <= 64, r.body.text);
      assert.ok(!["em-1", "ex-2"].includes(r.body.id), "an id the app says it saw is not said again");
      const again = await api.get(`/api/profiles/${dana.id}/remark${q}`, asDana);
      assert.deepEqual(again, r.body, "the same line within ten minutes");
      // a brand-new profile: nothing watched — Aurora says so, or speaks to the hour
      assert.ok(!r.body.kind.startsWith("kids-") && !r.body.kind.startsWith("roast-"));
    });

    await t.test("a kids profile is only ever spoken to kindly", async () => {
      const r = await api.get(`/api/profiles/${noa.id}/remark${q}`);
      assert.match(r.kind, /^kids-/);
    });

    await t.test("Wrapped of someone with nothing watched stays empty (no roasts invented)", async () => {
      const w = await api.get(`/api/profiles/${dana.id}/wrapped`, asDana);
      assert.equal(w.empty, true);
      assert.equal(w.roasts, undefined);
    });

    await t.test("what a call costs", async () => {
      const times = [];
      for (let i = 0; i < 200; i++) {
        const t0 = performance.now();
        const r = await api.call("GET", `/api/profiles/${eli.id}/remark${q}`, undefined, asEli);
        times.push(performance.now() - t0);
        assert.equal(r.status, 200);
      }
      times.sort((a, b) => a - b);
      const p = (x) => times[Math.min(times.length - 1, Math.floor(x * times.length))].toFixed(2);
      t.diagnostic(`remark route over 200 calls: p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${times[times.length - 1].toFixed(2)} ms`);
      assert.ok(Number(p(0.95)) < 500, "no call is slow");
    });
  } finally {
    await srv.stop();
  }
});
