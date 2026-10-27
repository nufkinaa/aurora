// The start-up timeline: from the press on Play to the first frame, step by
// step (public/js/startline.js). The player posts it as the "start-up" play
// mark, a problem report sent from the player carries it, and the admin's
// App health → Slow starts shows the starts by step.
const assert = require("node:assert/strict");
const { suite, player, warmJit } = require("./helpers");

const ui = suite({ setup: async (srv) => { await warmJit(srv, srv.lib.film2.id); } });
const PRIMARY = ".detail-actions > .btn-primary";

ui.test("pressing Play: the start-up mark names every step in order, from the press", async ({ page, srv, signIn, freshProfile, goto, lib }) => {
  await signIn(await freshProfile());
  const marks = player.marks(page);
  await goto(`#/movie/${lib.film2.id}`, { selector: PRIMARY });
  await page.click(PRIMARY);
  await player.playing(page, { min: 0.5 });
  const m = await marks.wait((x) => x.name === "start-up", 15000, "the start-up mark");
  const steps = m.steps.split(",").map((p) => p.split(":")).map(([n, ms]) => [n, Number(ms)]);
  const names = steps.map(([n]) => n);
  for (const n of ["open", "item", "mount", "decide", "ask", "frame"]) assert.ok(names.includes(n), `step ${n} in ${m.steps}`);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i][1] >= steps[i - 1][1], `in order: ${m.steps}`);
  assert.equal(names[names.length - 1], "frame");
  assert.equal(Number(m.total), steps[steps.length - 1][1]);
  assert.ok(names.includes(m.slow));
  assert.equal(m.path, "jit");
  // the first frame mark (counted from the player's mount) is part of it
  const ff = marks.named("first-frame")[0];
  assert.ok(Number(m.total) >= ff.ms, `total ${m.total} ≥ first-frame ${ff.ms}`);

  // a problem report from the player carries it
  await player.press(page, "Settings");
  await page.locator(".player .menu .menu-item", { hasText: "Report a problem" }).click();
  await page.fill(".report-text", "it took long to start");
  await page.click('[data-ui="report.send"]');
  await page.waitForSelector(".report-wrap", { state: "detached" });
  const { reports } = await srv.api.adminGet("/api/admin/reports");
  const r = reports.find((x) => x.text.startsWith("it took long to start"));
  assert.ok(r && r.context.startup, `the report's context: ${JSON.stringify(r && r.context)}`);
  assert.equal(r.context.startup.total, Number(m.total));
  assert.deepEqual(r.context.startup.steps.map(([n]) => n), names);
});

ui.test("the admin's App health shows the starts, step by step, and names the slow one's slowest step", async ({ page, srv }) => {
  // a slow start, as a far server's would arrive
  await fetch(`${srv.url}/api/play-mark/${srv.lib.film1.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "start-up", ms: 91000, total: 91400, slow: "byte", path: "jit", steps: "open:20,item:90,history:95,mount:120,decide:130,ask:140,byte:90100,frame:91400", seg: 89000 }) });
  await page.goto(`${srv.url}/admin`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
  await page.click('.tab[data-tab="analytics"]');
  await page.locator(".subtabs button", { hasText: "App health" }).click();
  await page.waitForFunction(() => /starts/.test(document.querySelector("#tel-starts-line").textContent));
  const line = await page.textContent("#tel-starts-line");
  assert.match(line, /slow \(6 s or more\)/);
  const steps = await page.locator("#tel-starts-steps tr").allTextContents();
  assert.ok(steps.some((t) => /first byte/.test(t) && /1$/.test(t.trim())), `the steps table: ${JSON.stringify(steps)}`);
  const recent = await page.locator("#tel-starts-recent tr").allTextContents();
  assert.ok(recent.some((t) => /Test Film One/.test(t) && /91 s from the press \(jit\), mostly first byte \(90 s\)/.test(t) && /first segment made in 89 s/.test(t)), `recent: ${JSON.stringify(recent)}`);
});

ui.run({ concurrency: 1 });
