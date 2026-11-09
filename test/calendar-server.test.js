// The Calendar on a real (private) server: GET /api/profiles/:id/calendar
// with My List, a followed show and a library show, from seeded caches
// (test/ui/support/calendar-seed.js); the guard in front of it; the words;
// Save & watch's answers (the instance has no way out, so the source
// provider "doesn't answer" — nothing is ever downloaded here); a kids
// profile. The rules themselves are pinned in test/calendar.test.js.
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

test("the calendar, end to end", { skip: !haveFfmpeg() && "ffmpeg not found", timeout: 240000 }, async (t) => {
  const { start, certificatesSeed } = require("../scripts/ui-test-server");
  const { makeApi } = require("./ui/helpers");
  const cal = require("./ui/support/calendar-seed");
  const srv = await start({ seed: { ...cal.seed(), "cache/certificates.json": certificatesSeed({ film1: 0, film2: 18, show: 7 }) } });
  const api = makeApi(srv);
  try {
    const lib = await api.library();
    const show = lib.shows.find((s) => s.title === "Test Show");
    const dana = await api.createProfile("Dana", { open: true });
    await cal.fill(api, dana, show.id);
    const all = (r) => [...r.upcoming, ...r.recent].flatMap((d) => d.items);

    await t.test("one person's releases, by day, with the words every app prints", async () => {
      const r = await api.get(`/api/profiles/${dana.id}/calendar?locale=en-GB`);
      assert.equal(r.today, cal.todayKey());
      assert.equal(r.counts.titles, 5);
      assert.equal(r.pending, 0);
      assert.equal(r.empty.pending, null);
      const up = r.upcoming.map((d) => [d.label, d.items.map((i) => `${i.title}: ${i.what}${i.detail ? ` (${i.detail})` : ""}`)]);
      assert.deepEqual(up[0], ["Tomorrow", ["Night Harbour: New episode (S1 E5 · The Lighthouse)"]]);
      assert.deepEqual(up[1][1], ["Test Show: Season 2 premiere (S2 E1 · Back Again)"]);
      assert.deepEqual(up[2][1], ["Quiet Fields: Season 2 premiere (S2 E1–E8 · 8 episodes)"]);
      assert.deepEqual(up[3][1], ["Glass Orchard: In cinemas"]);
      assert.deepEqual(up[4][1], ["Glass Orchard: Out to stream or buy"]);
      const recent = r.recent.map((d) => [d.label, d.items.map((i) => i.title)]);
      assert.deepEqual(recent[0], ["Yesterday", ["Night Harbour"]]);
      assert.deepEqual(recent.map((d) => d[1][0]), ["Night Harbour", "Test Show", "Paper Moons", "Night Harbour"]); // (E3, 8 days ago)
      const byKey = Object.fromEntries(all(r).map((i) => [i.key, i]));
      // the library's episodes: on the server, Play, no Save
      const owned = byKey[`${cal.IDS.show}:1:1`];
      assert.equal(owned.state, "have");
      assert.equal(owned.badge, "On the server");
      assert.equal(owned.canSave, false);
      assert.ok(owned.play && owned.play.id && owned.play.showId === show.id);
      assert.equal(owned.item.id, show.id, "a card of a library show opens the library page");
      assert.equal(owned.why, "In My List");
      // aired, not on the server: Save & watch
      const harbour = byKey[`${cal.IDS.harbour}:1:4`];
      assert.equal(harbour.canSave, true);
      assert.deepEqual(harbour.save, { imdbId: cal.IDS.harbour, type: "show", season: 1, episode: 4 });
      assert.equal(harbour.item.source, "stream");
      assert.equal(byKey[`${cal.IDS.harbour}:1:5`].canSave, false, "tomorrow's is not out yet");
      assert.equal(byKey[`${cal.IDS.fields}:2:1`].why, "Following");
      assert.equal(byKey[`${cal.IDS.moons}:home`].canSave, true);
      assert.equal(byKey[`${cal.IDS.moons}:cinema`], undefined, "60 days ago is outside the window");
      assert.equal(byKey[`${cal.IDS.orchard}:cinema`].canSave, false, "a film in cinemas has nothing to save");
    });

    await t.test("the day names follow the asking device's locale", async () => {
      const us = await api.get(`/api/profiles/${dana.id}/calendar?locale=en-US`);
      const gb = await api.get(`/api/profiles/${dana.id}/calendar?locale=en-GB`);
      const farUs = us.upcoming.find((d) => !d.date);
      const farGb = gb.upcoming.find((d) => !d.date);
      assert.ok(farUs && farGb);
      assert.notEqual(farUs.label, farGb.label); // "Fri, Nov 27" / "Fri 27 Nov"
      const junk = await api.get(`/api/profiles/${dana.id}/calendar?locale=${encodeURIComponent("<b>")}`);
      assert.equal(junk.locale, "en-GB");
    });

    await t.test("guarded like the profile's own data", async () => {
      const ben = await api.createProfile("Ben"); // has a password
      assert.equal((await api.call("GET", `/api/profiles/${ben.id}/calendar`)).status, 401);
      assert.equal((await api.call("GET", `/api/profiles/${ben.id}/calendar`, undefined, await api.as(ben))).status, 200);
      assert.equal((await api.call("GET", "/api/profiles/nobody/calendar")).status, 404);
      assert.equal((await api.call("POST", `/api/profiles/${ben.id}/calendar/save`, { imdbId: cal.IDS.moons, type: "movie" })).status, 401);
    });

    await t.test("nothing in the list: the calendar says how to fill it", async () => {
      const eve = await api.createProfile("Eve", { open: true });
      const r = await api.get(`/api/profiles/${eve.id}/calendar`);
      assert.deepEqual([r.upcoming, r.recent, r.counts.titles], [[], [], 0]);
      assert.match(r.empty.noTitles, /^Add films and shows to My List/);
    });

    await t.test("Save & watch: a bad request is refused; with no source provider it says so and starts nothing", async () => {
      const bad = await api.call("POST", `/api/profiles/${dana.id}/calendar/save`, { imdbId: "nope", type: "movie" });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.line, "That title couldn't be found.");
      const noEp = await api.call("POST", `/api/profiles/${dana.id}/calendar/save`, { imdbId: cal.IDS.harbour, type: "show" });
      assert.equal(noEp.status, 400);
      // the library's own episode: already there, nothing asked of anyone
      const have = await api.post(`/api/profiles/${dana.id}/calendar/save`, { imdbId: cal.IDS.show, type: "show", season: 1, episode: 2 });
      assert.deepEqual([have.ok, have.state, have.line], [true, "have", "Already on the server"]);
      const r = await api.post(`/api/profiles/${dana.id}/calendar/save`, { imdbId: cal.IDS.harbour, type: "show", season: 1, episode: 4 });
      assert.equal(r.ok, false);
      assert.ok(["sources", "none"].includes(r.why), r.why);
      assert.ok(r.line && r.line.length > 10);
      const jobs = await api.get("/api/downloads");
      assert.equal(jobs.length, 0, "nothing was queued");
    });

    await t.test("a kids profile sees only what it may", async () => {
      const kid = await api.createProfile("Noa", { open: true, kids: { maxAge: 7 } });
      await cal.fill(api, kid, show.id).catch(() => {}); // (some adds may be refused for a kids profile — fine)
      const r = await api.get(`/api/profiles/${kid.id}/calendar`, { "X-Profile": kid.id });
      // Test Show is rated 7 (allowed); the catalogue titles have no rating: hidden
      const titles = new Set(all(r).map((i) => i.title));
      assert.ok(!titles.has("Night Harbour") && !titles.has("Paper Moons"), [...titles].join(", "));
      const no = await api.call("POST", `/api/profiles/${kid.id}/calendar/save`, { imdbId: cal.IDS.moons, type: "movie" }, { "X-Profile": kid.id });
      assert.equal(no.status, 403);
    });
  } finally {
    await srv.stop();
  }
});
