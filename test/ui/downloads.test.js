// "My downloads" in the web app while the server tries a second source for a
// slow download (src/media/dlrace.js): the card stays ONE card and gains one
// calm note — nothing else about it changes.
//
// The private instance cannot download anything (no network, no torrent), so
// the queue's answer is stubbed in the browser: these are the exact fields
// publicJob() sends. The queue itself is tested in test/dlrace-queue.test.js.
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const ui = suite();

const job = (over = {}) => ({
  id: "aaaaaaaaaaaa", infoHash: "a".repeat(40), fileIdx: 0, imdbId: "tt9100001", title: "Slow Film", label: "Slow Film", type: "movie",
  season: null, episode: null, quality: "1080p", sizeBytes: 4e9, poster: null, provider: null,
  status: "downloading", phase: "downloading", copyProgress: null, progress: 0.12, downloadSpeed: 2100000, peers: 4,
  error: null, at: new Date().toISOString(), approvedAt: new Date().toISOString(), doneAt: null,
  holdReason: null, autoApproved: true, seenAt: null, smart: false, resolvedAt: null, libraryId: null,
  race: null, raceNote: null, mine: true, ...over,
});
const racing = { state: "racing", why: "projected to take 6.8 h more", attempts: [] };

ui.test("a download trying a second source says so on its one card, and nothing else changes", async ({ page, goto, signIn, freshProfile }) => {
  const jobs = [
    job({ race: racing }),
    job({ id: "bbbbbbbbbbbb", title: "Plain Film", label: "Plain Film" }),
    job({ id: "cccccccccccc", title: "Stuck Film", label: "Stuck Film", raceNote: "No healthy source was found at 1080p — still trying the original." }),
    job({ id: "dddddddddddd", title: "Landing Film", label: "Landing Film", phase: "copying", copyProgress: 0.5, progress: 1, race: racing }),
  ];
  await page.route((url) => url.pathname === "/api/downloads", (route) => route.fulfill({ json: jobs }));
  await signIn(await freshProfile());
  await goto("#/downloads");
  await page.waitForSelector('.dl-row[data-id="aaaaaaaaaaaa"]');

  assert.equal(await page.locator(".dl-row").count(), 4, "one card per download — a race does not add one");
  const text = (id) => page.locator(`.dl-row[data-id="${id}"] .dl-status`).innerText();
  const raced = await text("aaaaaaaaaaaa");
  assert.match(raced, /Downloading · 12%/);
  assert.match(raced, /2\.1 MB\/s/);
  assert.match(raced, /· trying a second source$/, "the note is last, after the usual speed and time left");
  const plain = await text("bbbbbbbbbbbb");
  assert.doesNotMatch(plain, /second source/);
  assert.equal(raced.replace(" · trying a second source", ""), plain, "apart from the note, the two cards read the same");
  assert.match(await text("cccccccccccc"), /No healthy source was found at 1080p — still trying the original\./);
  assert.doesNotMatch(await text("dddddddddddd"), /second source/, "once it is being copied in, the race is over");
  // same bar, same buttons
  const shape = (id) => page.locator(`.dl-row[data-id="${id}"]`).evaluate((r) => [r.className, r.querySelectorAll(".dl-bar").length, r.querySelectorAll("button").length]);
  assert.deepEqual(await shape("aaaaaaaaaaaa"), await shape("bbbbbbbbbbbb"));
});

ui.run({ concurrency: 1 });
