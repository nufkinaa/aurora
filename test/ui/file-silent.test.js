// A film played as the file itself whose connection goes silent under it
// (streaming round 2, 2026-11-28 — docs/qa/streaming-round-2/web.md): the
// browser gets no more bytes and nothing says so. The player opens the file
// again at the same spot instead of reading the silence as a thin line and
// stepping down onto an encode.
const assert = require("node:assert/strict");
const { suite, player } = require("./helpers");

const ui = suite();

ui.test("a file whose bytes stop coming is opened again at the same spot, with no step down", async ({ page, srv, signIn, freshProfile, lib }) => {
  await signIn(await freshProfile());
  const id = lib.film1.id;
  const meta = await (await fetch(`${srv.url}/stream/video/${id}`, { method: "HEAD" })).headers;
  const total = Number(meta.get("content-length"));
  assert.ok(total > 1e6, `the test film is ${total} bytes`);
  // The first answer carries only the first fifth of the film; the browser's
  // next ask (the rest) is never answered — a connection that died. Once the
  // player has opened the file again, every ask is let through.
  const cut = Math.floor(total / 5);
  let state = "first";
  const asks = [];
  await page.route(new RegExp(`/stream/video/${id}`), async (route) => {
    const range = route.request().headers().range || "";
    asks.push({ t: Date.now(), range, state });
    if (state === "first") {
      state = "cut";
      const r = await route.fetch({ headers: { ...route.request().headers(), range: `bytes=0-${cut - 1}` } });
      const body = await r.body();
      return route.fulfill({ status: 206, headers: { ...r.headers(), "content-range": `bytes 0-${cut - 1}/${total}`, "content-length": String(body.length) }, body });
    }
    if (state === "cut") { state = "hung"; return; } // never answered
    return route.continue();
  });
  const marks = player.marks(page);
  await player.open(page, srv, id, { min: 0.3 });
  const kick = await marks.wait((m) => m.name === "file-kick", 40000, "the file kick");
  // the file asked for again (under a fresh address: the old loader is the dead one)
  for (let i = 0; i < 50 && asks.length < 3; i++) await page.waitForTimeout(100);
  assert.ok(asks.length >= 3, `asks: ${JSON.stringify(asks)}`);
  assert.equal(marks.named("step-down").length, 0, "stepped down onto an encode for a dead connection");
  // and it plays on past where the cut was
  await page.waitForFunction((t) => document.querySelector(".player video").currentTime > t + 3, kick.at || 0, { timeout: 30000 });
  await player.advancing(page);
});

ui.run();
