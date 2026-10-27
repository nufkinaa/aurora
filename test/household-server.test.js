// Household recommendations on a real (private) server: the routes, the
// guard in front of them, Home's row (ranking, 15 + "more"), adding to My List
// and "Not for me" taking a title off the row, kids refusals, the sender's
// Sent list, settings. The rules themselves are pinned in household.test.js.
// A private instance (the UI tests' harness: a temp folder, a free port, no
// outbound network); without ffmpeg (its library is made with it) it is skipped.
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

test("household recommendations, end to end", { skip: !haveFfmpeg() && "ffmpeg not found", timeout: 240000 }, async (t) => {
  const { start, certificatesSeed, IDS } = require("../scripts/ui-test-server");
  const { makeApi } = require("./ui/helpers");
  const srv = await start({ seed: { "cache/certificates.json": certificatesSeed({ film1: 0, film2: 18, show: 7 }) } });
  const api = makeApi(srv);
  try {
    const dana = await api.createProfile("Dana", { open: true });
    const avi = await api.createProfile("Avi", { open: true });
    const ben = await api.createProfile("Ben"); // has a password
    const noa = await api.createProfile("Noa", { open: true, kids: { maxAge: 7 } });
    const lock = await api.createProfile("Lockie", { open: true });
    await api.adminPost(`/api/admin/profiles/${lock.id}/lock`, { locked: true });
    const benH = await api.as(ben);
    const lib = await api.library();
    const film1 = lib.movies.find((m) => m.imdbId === IDS.film1 || /one/i.test(m.title));
    const film2 = lib.movies.find((m) => m.imdbId === IDS.film2 || /two/i.test(m.title));
    assert.ok(film1 && film2, "the test library has its films");
    let eve = null;
    const cat = (n) => ({ imdbId: `tt${8000000 + n}`, type: n % 2 ? "movie" : "show", title: `Catalogue ${n}`, year: 2024, poster: null });

    await t.test("the picker: everyone but yourself, a locked profile left out, the kid greyed for an 18+ film", async () => {
      const r = await api.get(`/api/profiles/${dana.id}/recommend/people?key=lib:${film2.id}&type=movie`);
      // (the instance starts with a profile of its own; ours are these)
      const names = r.people.map((p) => p.name).filter((x) => ["Dana", "Avi", "Ben", "Noa", "Lockie"].includes(x));
      assert.deepEqual(names.sort(), ["Avi", "Ben", "Noa"]);
      const n = r.people.find((p) => p.name === "Noa");
      assert.equal(n.state, "kids");
      assert.equal(n.line, "Not for Noa's age");
      assert.equal(r.noteMax, 140);
      assert.equal(r.perPerson, 4);
    });

    await t.test("guarded like the profile's own data: a protected profile needs its token, a locked one is refused", async () => {
      const noTok = await api.call("GET", `/api/profiles/${ben.id}/household`);
      assert.equal(noTok.status, 401);
      const ok = await api.call("GET", `/api/profiles/${ben.id}/household`, undefined, benH);
      assert.equal(ok.status, 200);
      const locked = await api.call("POST", `/api/profiles/${lock.id}/recommend`, { to: [avi.id], title: { id: film1.id } });
      assert.equal(locked.status, 403);
      const ghost = await api.call("GET", `/api/profiles/nobody/household`);
      assert.equal(ghost.status, 404);
    });

    await t.test("send: a library film to two people with a note; the kid is refused an 18+ film", async () => {
      const r = await api.post(`/api/profiles/${dana.id}/recommend`, { to: [avi.id, noa.id], title: { id: film1.id }, note: "Short and sweet\nreally" });
      assert.deepEqual(r.sent.map((s) => s.name).sort(), ["Avi", "Noa"]);
      assert.equal(r.line, "Recommended to Avi and Noa");
      const k = await api.post(`/api/profiles/${dana.id}/recommend`, { to: [noa.id], title: { id: film2.id } });
      assert.equal(k.sent.length, 0);
      assert.equal(k.refused[0].reason, "kids");
      assert.equal(k.line, "Not for Noa's age");
      const bad = await api.call("POST", `/api/profiles/${dana.id}/recommend`, { to: [avi.id], title: { imdbId: "nope", title: "x" } });
      assert.equal(bad.status, 400);
    });

    await t.test("the recipient's Home has the row right under Recommended for You, with who and the note", async () => {
      const home = await api.get(`/api/home?profile=${avi.id}`);
      const ids = home.rows.map((r) => r.id);
      const row = home.rows.find((r) => r.id === "household");
      assert.ok(row, `a household row (rows: ${ids.join(", ")})`);
      assert.equal(row.title, "Recommended by your household");
      assert.equal(row.items[0].id, film1.id, "the library copy");
      assert.equal(row.items[0].meta, "From Dana");
      assert.equal(row.items[0].hh.note, "Short and sweet really");
      assert.equal(row.more, false);
      const rec = ids.indexOf("recommended");
      if (rec !== -1) assert.equal(ids.indexOf("household"), rec + 1, "directly under Recommended for You");
      // the TV's shape too
      const slim = await api.get(`/api/home?profile=${avi.id}&slim=1`);
      assert.equal(slim.rows.find((r) => r.id === "household").items[0].meta, "From Dana");
      // nobody else got it
      const bens = await api.get(`/api/home?profile=${ben.id}`, benH);
      assert.ok(!bens.rows.some((r) => r.id === "household"));
    });

    await t.test("ranked by how many people recommended it; 15 on Home, more on the page", async () => {
      // 20 catalogue titles to Avi: Dana 4 an hour, so Ben, Noa and Dana share them
      let n = 0;
      // Dana has 3 left this hour for Avi (film1 was one), Ben 4, Noa (a kid sending a catalogue
      // title is fine — the kid is the sender) 4
      const plan = [[dana, {}, 3], [ben, benH, 4], [noa, {}, 4]];
      for (const [p, h, k] of plan) {
        for (let i = 0; i < k; i++) {
          const r = await api.ok("POST", `/api/profiles/${p.id}/recommend`, { to: [avi.id], title: cat(++n) }, h);
          assert.equal(r.sent.length, 1, `${p.name} #${i + 1}: ${r.line}`);
        }
      }
      // Dana is at her limit for Avi now
      const lim = await api.post(`/api/profiles/${dana.id}/recommend`, { to: [avi.id], title: cat(99) });
      assert.equal(lim.refused[0].reason, "limit");
      assert.match(lim.line, /^You can recommend more to Avi in \d+ min$/);
      // …but the same title again only updates the note
      const again = await api.post(`/api/profiles/${dana.id}/recommend`, { to: [avi.id], title: { id: film1.id }, note: "Really!" });
      assert.deepEqual(again.sent, [{ to: avi.id, name: "Avi", updated: true }]);
      // more people for some titles: Ben and Noa are at their 4 for Avi, so others send
      eve = await api.createProfile("Eve", { open: true });
      for (const i of [1, 2, 3]) {
        const r = await api.post(`/api/profiles/${eve.id}/recommend`, { to: [avi.id], title: cat(i) });
        assert.equal(r.sent.length, 1);
      }
      const r1 = await api.post(`/api/profiles/${eve.id}/recommend`, { to: [avi.id], title: cat(12) });
      assert.equal(r1.sent.length, 1);
      // total for Avi: film1 + cat 1..11 + cat 12 = 13; add more from a sixth person to pass 15
      const fay = await api.createProfile("Fay", { open: true });
      for (const i of [13, 14, 15, 16]) await api.post(`/api/profiles/${fay.id}/recommend`, { to: [avi.id], title: cat(i) });
      const gil = await api.createProfile("Gil", { open: true });
      await api.post(`/api/profiles/${gil.id}/recommend`, { to: [avi.id], title: cat(1) });
      const all = await api.get(`/api/profiles/${avi.id}/household`);
      assert.equal(all.total, 17);
      assert.equal(all.items.length, 17);
      assert.equal(all.items[0].title, "Catalogue 1", "three people (Dana, Eve, Gil) — first");
      assert.equal(all.items[0].hh.count, 3);
      assert.equal(all.items[0].meta, "From Gil and 2 others");
      assert.deepEqual(all.items.slice(1, 3).map((i) => i.hh.count), [2, 2]);
      const home = await api.get(`/api/home?profile=${avi.id}`);
      const row = home.rows.find((r) => r.id === "household");
      assert.equal(row.items.length, 15);
      assert.equal(row.total, 17);
      assert.equal(row.more, true);
      assert.deepEqual(row.items.map((i) => i.imdbId || i.id), all.items.slice(0, 15).map((i) => i.imdbId || i.id), "the same ranking");
      // filter by person
      const byEve = await api.get(`/api/profiles/${avi.id}/household?from=${eve.id}`);
      assert.deepEqual(byEve.items.map((i) => i.title).sort(), ["Catalogue 1", "Catalogue 12", "Catalogue 2", "Catalogue 3"]);
      assert.ok(all.people.some((p) => p.name === "Eve" && p.n === 4));
    });

    await t.test("added to My List or Not for me: off the row; the sender sees what became of it", async () => {
      await api.post(`/api/profiles/${avi.id}/watchlist`, { stream: cat(2) });
      await api.post(`/api/profiles/${avi.id}/household/dismiss`, { key: cat(3).imdbId });
      const for1 = await api.get(`/api/profiles/${avi.id}/household/for?key=${cat(1).imdbId}`);
      assert.deepEqual(for1.from.map((f) => f.name), ["Gil", "Eve", "Dana"]);
      const left = await api.get(`/api/profiles/${avi.id}/household`);
      const titles = left.items.map((i) => i.title);
      assert.ok(!titles.includes("Catalogue 2"), "in My List: off the row");
      assert.ok(!titles.includes("Catalogue 3"), "Not for me: off the row");
      assert.equal(left.total, 15);
      const sent = await api.get(`/api/profiles/${eve.id}/household/sent`);
      const st = Object.fromEntries(sent.items.map((g) => [g.title, g.hh.to[0].status]));
      assert.equal(st["Catalogue 2"], "added");
      assert.equal(st["Catalogue 3"], "seen");
      assert.equal(st["Catalogue 1"], "seen");
      assert.equal(st["Catalogue 12"], "sent");
      // Home's row: 15 or fewer now, no "more"
      const home = await api.get(`/api/home?profile=${avi.id}`);
      const row = home.rows.find((r) => r.id === "household");
      assert.equal(row.more, false);
      // undo
      await api.post(`/api/profiles/${avi.id}/household/dismiss`, { key: cat(3).imdbId, undo: true });
      assert.equal((await api.get(`/api/profiles/${avi.id}/household`)).total, 16);
    });

    await t.test("watched: off the row, 'Watched' for the sender, greyed in the picker", async () => {
      await api.setProgress(avi, film1.id, 59, 60);
      const left = await api.get(`/api/profiles/${avi.id}/household`);
      assert.ok(!left.items.some((i) => i.id === film1.id));
      const sent = await api.get(`/api/profiles/${dana.id}/household/sent`);
      assert.equal(sent.items.find((g) => g.id === film1.id).hh.to.find((x) => x.name === "Avi").status, "watched");
      const pick = await api.get(`/api/profiles/${ben.id}/recommend/people?key=lib:${film1.id}`, benH);
      assert.equal(pick.people.find((p) => p.name === "Avi").state, "seen");
    });

    await t.test("the kid's own list and Home only carry what it may see", async () => {
      const k = await api.get(`/api/profiles/${noa.id}/household`);
      assert.deepEqual(k.items.map((i) => i.id), [film1.id]);
    });

    await t.test("settings: mute and off, server-side, per person", async () => {
      const s0 = await api.get(`/api/profiles/${avi.id}/household/settings`);
      assert.equal(s0.on, true);
      assert.ok(s0.people.some((p) => p.name === "Dana" && p.muted === false));
      const s1 = await api.post(`/api/profiles/${avi.id}/household/settings`, { muted: [dana.id] });
      assert.ok(s1.people.find((p) => p.name === "Dana").muted);
      const left = await api.get(`/api/profiles/${avi.id}/household`);
      assert.ok(left.items.every((i) => !i.hh.from.some((f) => f.name === "Dana")));
      await api.post(`/api/profiles/${avi.id}/household/settings`, { on: false });
      const pick = await api.get(`/api/profiles/${ben.id}/recommend/people`, benH);
      assert.equal(pick.people.find((p) => p.name === "Avi").state, "off");
      const home = await api.get(`/api/home?profile=${avi.id}`);
      assert.ok(!home.rows.some((r) => r.id === "household"), "off: no row");
      await api.post(`/api/profiles/${avi.id}/household/settings`, { on: true, muted: [] });
      assert.ok((await api.get(`/api/profiles/${avi.id}/household`)).total > 0);
    });

    await t.test("seen: the Show all page marks everything looked at", async () => {
      await api.post(`/api/profiles/${avi.id}/household/seen`);
      const after = await api.get(`/api/profiles/${avi.id}/household`);
      assert.equal(after.unseen, 0);
      const home = await api.get(`/api/home?profile=${avi.id}`);
      assert.equal(home.rows.find((r) => r.id === "household").sub, undefined);
    });
  } finally {
    await srv.stop();
  }
});
