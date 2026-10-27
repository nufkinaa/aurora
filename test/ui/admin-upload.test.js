// The admin page, Downloads → "Add your own file" (media/uploads.js): a video
// picked from this device goes up in chunks, with its subtitle, and lands in
// the library as "<Title> (<Year>)/<Title> (<Year>).mp4" with a poster from
// one of its frames; a link (a local fake server standing in for Drive /
// a direct link) is downloaded by the server itself; a web page where a
// video was expected says so. Desktop and phone width — the card stays
// inside the screen. Screenshots are kept in docs/qa/admin-upload/.
//
// Its own private instance (scripts/ui-test-server.js): this file adds files
// to the library.
const assert = require("node:assert/strict");
const { after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { suite, PHONE } = require("./helpers");

const SHOTS = path.join(__dirname, "..", "..", "docs", "qa", "admin-upload");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-ui-upload-"));
let fake = null;
let fakeUrl = "";

const ui = suite({
  setup: async (srv) => {
    // a real (small) video to send: Film Three from the test library's extras, under a home-video name
    const src = path.join(srv.media, "extras", "movies", "Test Film Three (2022)", "Test Film Three (2022).mp4");
    const from = fs.existsSync(src) ? src : path.join(srv.library.movies, "Test Film One (2020)", "Test Film One (2020).mp4");
    fs.copyFileSync(from, path.join(WORK, "Beach.Day.2024.1080p.mp4"));
    fs.writeFileSync(path.join(WORK, "Beach.Day.2024.1080p.en.srt"), "1\n00:00:01,000 --> 00:00:03,000\nOn the beach\n");
    const film = fs.readFileSync(from);
    fake = http.createServer((req, res) => {
      if (req.url.startsWith("/clip.mp4")) {
        const m = /bytes=(\d+)-/.exec(req.headers.range || "");
        const start = m ? Number(m[1]) : 0;
        res.writeHead(m ? 206 : 200, { "Content-Type": "video/mp4", "Content-Length": String(film.length - start), "Accept-Ranges": "bytes",
          ...(m ? { "Content-Range": `bytes ${start}-${film.length - 1}/${film.length}` } : {}) });
        return res.end(film.subarray(start));
      }
      if (req.url.startsWith("/page")) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html><body>Sign up to watch!</body></html>"); }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => fake.listen(0, "127.0.0.1", r));
    fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  },
});

const enter = async (page, srv) => {
  await page.goto(`${srv.url}/admin#downloads`);
  await page.fill('.gate input[aria-label="Admin password"]', srv.adminPassword);
  await page.click(".gate button");
  await page.waitForSelector(".gate", { state: "detached" });
  await page.waitForSelector("#up-card[open] .up-drop");
};
const job = (page, title) => page.locator("#up-jobs .up-job", { hasText: title });
const shot = async (page, name) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
};
const inLibrary = async (api, title) => {
  for (let i = 0; i < 100; i++) {
    const lib = await api.library();
    const m = lib.movies.find((x) => x.title === title);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};

ui.test("from this device: the video and its subtitle go up, land as '<Title> (<Year>)', show in the library with a poster from a frame", async ({ page, srv, api }) => {
  await enter(page, srv);
  await page.locator("#up-card").scrollIntoViewIfNeeded();
  await page.setInputFiles("#up-files", [path.join(WORK, "Beach.Day.2024.1080p.mp4"), path.join(WORK, "Beach.Day.2024.1080p.en.srt")]);
  const item = page.locator("#up-items .up-item");
  await item.waitFor();
  assert.match(await item.innerText(), /Beach\.Day\.2024\.1080p\.mp4[\s\S]*\+ Beach\.Day\.2024\.1080p\.en\.srt/);
  // the guess from the name
  assert.equal(await item.locator('[data-k="title"]').inputValue(), "Beach Day");
  assert.equal(await item.locator('[data-k="year"]').inputValue(), "2024");
  await item.locator('[data-k="title"]').fill("Beach Day at Home");
  await shot(page, "desktop-1-picked");
  await page.click("#up-go");
  const row = job(page, "Beach Day at Home");
  await row.waitFor();
  await page.waitForFunction(() => {
    const r = [...document.querySelectorAll("#up-jobs .up-job")].find((x) => x.innerText.includes("Beach Day at Home"));
    return r && r.dataset.status === "done";
  }, null, { timeout: 60000 });
  assert.match(await row.innerText(), /In the library[\s\S]*this device[\s\S]*Beach Day at Home \(2024\)/);
  assert.equal(await row.locator("a.mini", { hasText: "Open" }).count(), 1);
  await shot(page, "desktop-2-uploaded");
  const dir = path.join(srv.library.movies, "Beach Day at Home (2024)");
  assert.ok(fs.existsSync(path.join(dir, "Beach Day at Home (2024).mp4")));
  assert.ok(fs.existsSync(path.join(dir, "Beach Day at Home (2024).en.srt")));
  assert.ok(fs.existsSync(path.join(dir, "poster.jpg")), "a poster made from one of its frames");
  assert.deepEqual(fs.readdirSync(path.join(srv.library.movies, ".aurora-uploads")), [], "nothing left in the temp folder");
  const m = await inLibrary(api, "Beach Day at Home");
  assert.ok(m, "in the library");
  assert.equal(m.year, 2024);
  assert.ok(m.cover && m.cover.startsWith("/img/"), "its own poster");
  const item2 = await api.item(m.id);
  assert.ok(item2.subtitles.some((s) => /en/i.test(`${s.label} ${s.lang}`)), JSON.stringify(item2.subtitles));
});

ui.test("from a link: the server downloads it, with progress, into the library; a web page says it is not a video", { allow: [/400 \(Bad Request\).*\/api\/admin\/uploads\/link/] }, async ({ page, srv, api }) => {
  await enter(page, srv);
  await page.click('[data-up-mode="link"]');
  await page.fill("#up-url", `${fakeUrl}/clip.mp4`);
  await page.fill('#up-items [data-k="title"]', "Linked Film");
  await page.fill('#up-items [data-k="year"]', "2023");
  await page.click("#up-go");
  await page.waitForFunction(() => {
    const r = [...document.querySelectorAll("#up-jobs .up-job")].find((x) => x.innerText.includes("Linked Film"));
    return r && r.dataset.status === "done";
  }, null, { timeout: 60000 });
  assert.match(await job(page, "Linked Film").innerText(), /In the library[\s\S]*link/);
  assert.ok(fs.existsSync(path.join(srv.library.movies, "Linked Film (2023)", "Linked Film (2023).mp4")));
  assert.ok(await inLibrary(api, "Linked Film"));
  // the form is ready for the next one
  assert.equal(await page.inputValue("#up-url"), "");
  // a page, not a video
  await page.fill("#up-url", `${fakeUrl}/page`);
  await page.fill('#up-items [data-k="title"]', "Not A Film");
  await page.click("#up-go");
  await page.waitForFunction(() => {
    const r = [...document.querySelectorAll("#up-jobs .up-job")].find((x) => x.innerText.includes("Not A Film"));
    return r && r.dataset.status === "error";
  }, null, { timeout: 30000 });
  const bad = job(page, "Not A Film");
  assert.match(await bad.innerText(), /Failed[\s\S]*web page, not a video file/);
  assert.equal(await bad.locator('[data-up-act="retry"]').count(), 1);
  await shot(page, "desktop-3-link");
  // remove the failed row
  await bad.locator('[data-up-act="dismiss"]').click();
  await page.waitForFunction(() => ![...document.querySelectorAll("#up-jobs .up-job")].some((x) => x.innerText.includes("Not A Film")));
  // a link that isn't one: refused at once, nothing queued
  await page.fill("#up-url", "ftp://example.com/x.mkv");
  await page.fill('#up-items [data-k="title"]', "Nope");
  await page.click("#up-go");
  await page.waitForFunction(() => /Only http and https/.test(document.getElementById("up-msg").textContent));
});

ui.test("the API is admin only, and refuses other kinds of file", async ({ api, srv }) => {
  const noPw = await api.call("POST", "/api/admin/uploads/link", { url: "https://example.com/a.mp4", title: "x" });
  assert.equal(noPw.status, 403);
  const exe = await api.call("POST", "/api/admin/uploads", { title: "x", files: [{ name: "run.exe", size: 5 }] }, api.admin);
  assert.equal(exe.status, 400);
  assert.match(exe.body.error, /isn't a video or subtitle file/);
  const ok = await api.call("POST", "/api/admin/uploads", { title: "Clip", files: [{ name: "clip.mp4", size: 5 }] }, api.admin);
  assert.equal(ok.status, 200);
  const put = await fetch(`${srv.url}/api/admin/uploads/${ok.body.job.id}/chunk?part=0&offset=0`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("12345") });
  assert.equal(put.status, 403, "no bytes without the admin password");
  assert.equal((await api.call("POST", `/api/admin/uploads/${ok.body.job.id}/cancel`, {}, api.admin)).status, 200);
  assert.equal((await api.call("POST", `/api/admin/uploads/${ok.body.job.id}/dismiss`, {}, api.admin)).status, 200);
});

ui.test("after a reload: a half-sent upload says Paused, Resume takes the same file again and goes on from where the server is", async ({ page, srv, api }) => {
  const file = path.join(WORK, "Beach.Day.2024.1080p.mp4");
  const bytes = fs.readFileSync(file);
  const { job } = await api.adminPost("/api/admin/uploads", { title: "Half Sent", year: "2022", files: [{ name: path.basename(file), size: bytes.length }] });
  const half = Math.floor(bytes.length / 2);
  const put = await fetch(`${srv.url}/api/admin/uploads/${job.id}/chunk?part=0&offset=0`, { method: "PUT", headers: { ...api.admin, "Content-Type": "application/octet-stream" }, body: bytes.subarray(0, half) });
  assert.equal(put.status, 200);
  await enter(page, srv);
  const row = job && page.locator(`#up-jobs [data-up-job="${job.id}"]`);
  await row.waitFor();
  assert.match(await row.innerText(), /Paused at 49%|Paused at 50%/);
  // the wrong file is refused
  let chooser = page.waitForEvent("filechooser");
  await row.locator('[data-up-act="resume"]').click();
  await (await chooser).setFiles(path.join(WORK, "Beach.Day.2024.1080p.en.srt"));
  await page.waitForFunction(() => /That isn't the same file/.test(document.getElementById("toasts").innerText));
  chooser = page.waitForEvent("filechooser");
  await row.locator('[data-up-act="resume"]').click();
  await (await chooser).setFiles(file);
  await page.waitForFunction((id) => { const r = document.querySelector(`#up-jobs [data-up-job="${id}"]`); return r && r.dataset.status === "done"; }, job.id, { timeout: 60000 });
  const landed = fs.readFileSync(path.join(srv.library.movies, "Half Sent (2022)", "Half Sent (2022).mp4"));
  assert.ok(Buffer.compare(landed, bytes) === 0, "the second half joined the first");
});

ui.test("phone width: the card fits, the form and the list are usable", { viewport: PHONE }, async ({ page, srv }) => {
  await enter(page, srv);
  await page.locator("#up-card").scrollIntoViewIfNeeded();
  await page.setInputFiles("#up-files", [path.join(WORK, "Beach.Day.2024.1080p.mp4")]);
  await page.locator("#up-items .up-item").waitFor();
  const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  assert.ok(fit.sw <= fit.iw + 1, `sideways scroll: ${fit.sw} > ${fit.iw}`);
  const card = await page.locator("#up-card").boundingBox();
  for (const sel of ["#up-items .up-item", "#up-go", "#up-jobs .up-job"]) {
    const n = await page.locator(sel).count();
    for (let i = 0; i < n; i++) {
      const b = await page.locator(sel).nth(i).boundingBox();
      if (!b) continue;
      assert.ok(b.x >= card.x - 1 && b.x + b.width <= card.x + card.width + 1, `${sel} sticks out`);
    }
  }
  const go = await page.locator("#up-go").boundingBox();
  assert.ok(go.height >= 40, "a thumb-sized button");
  await page.locator("#up-items").scrollIntoViewIfNeeded();
  await shot(page, "phone-1-form");
  await page.locator("#up-jobs").scrollIntoViewIfNeeded();
  await shot(page, "phone-2-list");
});

ui.run({ concurrency: 1 });

after(() => {
  try { fake && fake.close(); } catch {}
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
});
