// "What do we watch tonight?" on a real (private) server: the session's whole
// life over the routes, the guard in front of them (household only, as
// yourself), adding by search, the kids rule in a mixed room, the live
// socket's "something changed", and a code that expires. The rules
// themselves are pinned in grouppick.test.js.
// A private instance (the UI tests' harness: a temp folder, a free port, no
// outbound network); without ffmpeg (its library is made with it) it is skipped.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const WebSocket = require("ws");

const haveFfmpeg = () => {
  try {
    const win = process.platform === "win32";
    return spawnSync(win ? "where" : "which", [win ? "ffmpeg.exe" : "ffmpeg"], { stdio: "ignore", windowsHide: true }).status === 0;
  } catch { return false; }
};
const until = async (what, fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

test("group pick, end to end", { skip: !haveFfmpeg() && "ffmpeg not found", timeout: 240000 }, async (t) => {
  const { start, certificatesSeed, IDS } = require("../scripts/ui-test-server");
  const { makeApi } = require("./ui/helpers");
  const srv = await start({
    seed: { "cache/certificates.json": certificatesSeed({ film1: 0, film2: 18, film3: 12, show: 7 }) },
    preload: [path.join(__dirname, "ui", "support", "group-fast.js")],
    env: { UI_GROUP_FAST: "1", UI_GROUP_LOBBY_MS: "15000", UI_GROUP_KEEP_MS: "3000" },
  });
  const api = makeApi(srv);
  const sockets = [];
  try {
    const dana = await api.createProfile("Dana", { open: true });
    const avi = await api.createProfile("Avi", { open: true });
    const ben = await api.createProfile("Ben"); // has a password
    const noa = await api.createProfile("Noa", { open: true, kids: { maxAge: 12 } });
    const lock = await api.createProfile("Lockie", { open: true });
    await api.adminPost(`/api/admin/profiles/${lock.id}/lock`, { locked: true });
    const benH = await api.as(ben);
    const lib = await api.library();
    const WORD = { film1: /one/i, film2: /two/i };
    const film = (k) => lib.movies.find((m) => m.imdbId === IDS[k]) || lib.movies.find((m) => WORD[k].test(m.title));
    const show = lib.shows.find((x) => x.title === "Test Show");
    assert.ok(film("film1") && film("film2") && show, "the test library has its films and its show");
    const G = (p, rest = "") => `/api/profiles/${p.id}/group${rest}`;
    let code = null;

    await t.test("options: the moods, lengths, kinds and limits the starter picks from", async () => {
      const o = await api.get(G(dana, "/options"));
      assert.ok(o.moods.some((m) => m.id === "funny" && m.label === "Funny"));
      assert.deepEqual(o.lengths.map((l) => l.id), ["any", "90", "120", "150"]);
      assert.deepEqual(o.kinds.map((k) => k.id), ["movie", "both", "show"]);
      assert.deepEqual(o.limits, [120, 180, 300]);
    });

    await t.test("household only, as yourself: no profile 404, a protected one needs its token, a locked one is refused", async () => {
      assert.equal((await api.call("POST", "/api/profiles/nobody/group", { settings: {} })).status, 404);
      assert.equal((await api.call("POST", G(ben), { settings: {} })).status, 401);
      assert.equal((await api.call("POST", G(lock), { settings: {} })).status, 403);
    });

    await t.test("the TV starts it (a screen); phones join by code; a stranger to the session sees nothing", async () => {
      const r = await api.post(G(dana), { settings: { kind: "movie", mood: "any", length: "any", limitSec: 120 }, device: "tv1", role: "screen", app: "tv" });
      code = r.session.code;
      assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/);
      assert.equal(r.session.you.role, "screen");
      assert.equal(r.session.settings.limitSec, 120);
      // not in it yet
      assert.equal((await api.call("GET", `${G(avi, `/${code}`)}?device=ph-avi`)).status, 403);
      const j = await api.post(G(avi, "/join"), { code: code.toLowerCase(), device: "ph-avi", app: "phone" });
      assert.equal(j.session.you.role, "voter");
      assert.equal((await api.call("POST", G(ben, "/join"), { code, device: "ph-ben" })).status, 401, "Ben's profile is locked to his token");
      await api.post(G(ben, "/join"), { code, device: "ph-ben", app: "web" }, benH);
      await api.post(G(dana, "/join"), { code, device: "ph-dana", app: "phone" });
      const tv = await api.get(`${G(dana, `/${code}`)}?device=tv1`);
      assert.equal(tv.session.voters, 3);
      assert.deepEqual(tv.session.members.map((m) => m.name).sort(), ["Avi", "Ben", "Dana", "Dana"]);
      assert.equal((await api.call("POST", G(avi, "/join"), { code: "ZZZZ", device: "x" })).status, 404);
      // a member's own session read needs their own guard, too
      assert.equal((await api.call("GET", `${G(ben, `/${code}`)}?device=ph-ben`)).status, 401);
    });

    await t.test("the live socket says when the session changed (members only)", async () => {
      const ws = new WebSocket(srv.url.replace("http", "ws"));
      sockets.push(ws);
      const got = [];
      ws.on("message", (raw) => { try { got.push(JSON.parse(raw)); } catch {} });
      ws.on("error", () => {});
      await until("the socket to open", () => got.some((m) => m.type === "welcome"));
      ws.send(JSON.stringify({ type: "hello", profile: "Avi", profileId: avi.id }));
      ws.send(JSON.stringify({ type: "group_watch", code, profileId: avi.id, device: "ph-avi" }));
      await until("the watch to be accepted", () => got.find((m) => m.type === "group_watching"));
      assert.equal(got.find((m) => m.type === "group_watching").ok, true);
      // somebody else's device is refused
      const ws2 = new WebSocket(srv.url.replace("http", "ws"));
      sockets.push(ws2);
      const got2 = [];
      ws2.on("message", (raw) => { try { got2.push(JSON.parse(raw)); } catch {} });
      ws2.on("error", () => {});
      await until("the second socket", () => got2.some((m) => m.type === "welcome"));
      ws2.send(JSON.stringify({ type: "group_watch", code, profileId: ben.id, device: "ph-ben" }));
      await until("the refusal", () => got2.find((m) => m.type === "group_watching"));
      assert.equal(got2.find((m) => m.type === "group_watching").ok, false, "Ben's protected profile needs its token");
      // a change: the watcher hears it
      await api.post(G(dana, `/${code}/settings`), { device: "tv1", settings: { length: "150" } });
      await until("group_update", () => got.find((m) => m.type === "group_update" && m.code === code));
      assert.equal(got2.filter((m) => m.type === "group_update").length, 0);
    });

    await t.test("search inside the session, and adding: a library film and a catalogue title", async () => {
      const s = await api.get(`${G(avi, `/${code}/search`)}?q=test%20show&device=ph-avi`);
      assert.ok(s.results.length >= 1, JSON.stringify(s.results));
      assert.ok(s.results.every((r) => r.key && r.title));
      const sh = s.results.find((r) => r.id === show.id);
      assert.ok(sh, "the library's show");
      assert.equal(sh.lib, true);
      assert.equal(sh.inDeck, false);
      // an explicit add is taken even when it is not the deck's kind (a series in a films night)
      const a = await api.post(G(avi, `/${code}/add`), { device: "ph-avi", title: { id: show.id } });
      assert.equal(a.key, `lib:${show.id}`);
      const s2 = await api.get(`${G(avi, `/${code}/search`)}?q=test%20show&device=ph-avi`);
      assert.equal(s2.results.find((r) => r.id === show.id).inDeck, true);
      const again = await api.post(G(ben, `/${code}/add`), { device: "ph-ben", title: { id: show.id } }, benH);
      assert.equal(again.already, true);
      const cat = await api.post(G(ben, `/${code}/add`), { device: "ph-ben", title: { imdbId: "tt7000001", type: "movie", title: "A Catalogue Film", year: 2019, poster: "javascript:alert(1)" } }, benH);
      assert.equal(cat.key, "tt7000001");
      const lobby = await api.get(`${G(dana, `/${code}`)}?device=tv1`);
      assert.deepEqual(lobby.session.added.map((x) => [x.title, x.by]), [["Test Show", "Avi"], ["A Catalogue Film", "Ben"]]);
      assert.equal(lobby.session.added.find((x) => x.by === "Ben").poster, null, "a poster that is not an image address is dropped");
      assert.equal((await api.call("POST", G(avi, `/${code}/add`), { device: "ph-avi", title: { imdbId: "bad" } })).status, 400);
    });

    await t.test("only the host deals; the deck is the library first, with the added titles early", async () => {
      assert.equal((await api.call("POST", G(avi, `/${code}/start`), { device: "ph-avi" })).status, 403);
      const r = await api.post(G(dana, `/${code}/start`), { device: "tv1" });
      const d = r.session.deck;
      assert.equal(r.session.phase, "swiping");
      assert.ok(d.length >= 4, `deck: ${d.map((c) => c.title).join(", ")}`);
      const keys = d.map((c) => c.key);
      for (const k of ["film1", "film2"]) assert.ok(keys.includes(`lib:${film(k).id}`), `${k} is in the deck`);
      assert.ok(keys.includes(`lib:${show.id}`) && keys.includes("tt7000001"), "the added titles");
      assert.ok(d.slice(0, 4).some((c) => c.addedBy), "an added title comes early");
      assert.equal(d.find((c) => c.key === `lib:${show.id}`).addedBy, "Avi");
      assert.equal(r.session.mine[`lib:${show.id}`], undefined, "the TV did not add it");
      const avis = (await api.get(`${G(avi, `/${code}`)}?device=ph-avi`)).session;
      assert.equal(avis.mine[`lib:${show.id}`], "yes", "adding is Avi's yes");
      assert.ok(r.session.deadline > r.session.now + 100000);
      assert.equal((await api.call("POST", G(dana, `/${code}/start`), { device: "tv1" })).status, 409);
    });

    await t.test("everyone swipes; the result is the overlap with its why; Something else; Play", async () => {
      const s = (await api.get(`${G(avi, `/${code}`)}?device=ph-avi`)).session;
      const f1 = `lib:${film("film1").id}`;
      const f2 = `lib:${film("film2").id}`;
      const vote = (p, dev, key, verdict, h) => api.post(G(p, `/${code}/vote`), { device: dev, key, verdict }, h);
      for (const c of s.deck) {
        await vote(avi, "ph-avi", c.key, c.key === f1 || c.key === f2 ? "yes" : "no");
        await vote(ben, "ph-ben", c.key, c.key === f1 ? "yes" : c.key === f2 ? "maybe" : "no", benH);
      }
      assert.equal((await api.get(`${G(dana, `/${code}`)}?device=tv1`)).session.phase, "swiping", "Dana is still swiping");
      assert.equal((await api.call("POST", G(dana, `/${code}/vote`), { device: "tv1", key: f1, verdict: "yes" })).status, 409, "the TV is the screen");
      for (const c of s.deck) await vote(dana, "ph-dana", c.key, c.key === f1 || c.key === f2 ? "yes" : "no");
      const r = (await api.get(`${G(dana, `/${code}`)}?device=tv1`)).session;
      assert.equal(r.phase, "result");
      assert.equal(r.result.method, "everyone");
      assert.equal(r.result.picks[0].key, f1);
      assert.equal(r.result.picks[0].why, "3 of 3 said yes");
      assert.equal(r.result.picks[1].key, f2);
      assert.equal(r.result.picks[1].why, "2 of 3 said yes · 1 maybe");
      const next = await api.post(G(avi, `/${code}/pick`), { device: "ph-avi", index: 1 });
      assert.equal(next.session.result.index, 1);
      const ch = await api.post(G(dana, `/${code}/choose`), { device: "tv1", key: f1 });
      assert.equal(ch.session.phase, "chosen");
      assert.equal(ch.session.chosen.card.id, film("film1").id);
      assert.equal(ch.session.chosen.by, "Dana");
    });

    await t.test("a kid in the room: the deck and the adds keep to the kid's age", async () => {
      const r = await api.post(G(dana), { settings: { kind: "both" }, device: "tv1", role: "screen", app: "tv" });
      const c2 = r.session.code;
      await api.post(G(noa, "/join"), { code: c2, device: "ph-noa" });
      await api.post(G(avi, "/join"), { code: c2, device: "ph-avi" });
      const refused = await api.call("POST", G(avi, `/${c2}/add`), { device: "ph-avi", title: { id: film("film2").id } });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, "Not for everyone's age in this group");
      const found = await api.get(`${G(avi, `/${c2}/search`)}?q=test%20film&device=ph-avi`);
      assert.ok(!found.results.some((x) => x.id === film("film2").id), "an 18+ film is not offered");
      const st = await api.post(G(dana, `/${c2}/start`), { device: "tv1" });
      const keys = st.session.deck.map((c) => c.key);
      assert.ok(!keys.includes(`lib:${film("film2").id}`), "no 18+ film for a 12-year-old");
      assert.ok(keys.includes(`lib:${film("film1").id}`));
      assert.ok(keys.includes(`lib:${show.id}`), "7+ is fine for 12");
      await api.post(G(dana, `/${c2}/end`), { device: "tv1" });
      const ended = await api.get(`${G(avi, `/${c2}`)}?device=ph-avi`);
      assert.equal(ended.session.phase, "ended");
      assert.equal(ended.session.ended.reason, "Dana ended it");
    });

    await t.test("a code nobody starts with expires, and then is not found", async () => {
      const r = await api.post(G(avi), { settings: {}, device: "web-avi", app: "web" });
      const c3 = r.session.code;
      assert.ok(r.session.expiresAt - r.session.now <= 15000);
      await until("the code to expire", async () => {
        const g = await api.get(`${G(avi, `/${c3}`)}?device=web-avi`);
        return g.session.phase === "ended" ? g : null;
      }, 30000).then((g) => assert.equal(g.session.ended.reason, "The code expired"));
      assert.equal((await api.call("POST", G(dana, "/join"), { code: c3, device: "x" })).status, 404);
      await until("the session to be gone", async () => (await api.call("GET", `${G(avi, `/${c3}`)}?device=web-avi`)).status === 404, 15000);
    });
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch {} }
    await srv.stop();
  }
});
