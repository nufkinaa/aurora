// Recommendations between the people of the household (media/household.js):
// the limits, the ranking, kids, mute and "off", Not for me, what the sender
// sees, pruning, and who may be picked. The core is pure — every fact about
// the household is a fake here; nothing touches data/.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const household = require("../src/media/household");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const rig = ({ people = null } = {}) => {
  let t = Date.UTC(2026, 9, 27, 12, 0, 0);
  const pp = people || [
    { id: "dana", name: "Dana" },
    { id: "avi", name: "Avi" },
    { id: "noa", name: "Noa", kids: { maxAge: 7 } },
    { id: "ben", name: "Ben" },
    { id: "lock", name: "Locked", locked: true },
  ];
  const facts = {}; // pid -> { inList:Set, watching:Set, watched:Set }
  const ages = { tt1000001: 0, tt1000002: 18 }; // anything else: unrated
  const pinged = [];
  const store = { data: { v: 1, recs: [], sends: {}, settings: {} }, saves: 0, save() { this.saves++; } };
  const hh = household.make({
    store,
    now: () => t,
    people: () => pp,
    titleState: (pid, title) => {
      const f = facts[pid] || {};
      const has = (s) => !!s && (s.has(title.key) || (title.imdbId && s.has(title.imdbId)));
      return { inList: has(f.inList), watching: has(f.watching), watched: has(f.watched) };
    },
    ageCheck: (pid, title) => {
      const p = pp.find((x) => x.id === pid);
      if (!p || !p.kids) return "ok";
      const a = ages[title.imdbId];
      if (a == null) return "unrated";
      return a <= p.kids.maxAge ? "ok" : "too-old";
    },
    notify: (to) => pinged.push(to),
  });
  const fact = (pid, kind, key) => {
    facts[pid] = facts[pid] || { inList: new Set(), watching: new Set(), watched: new Set() };
    facts[pid][kind].add(key);
  };
  return { hh, store, pinged, fact, advance: (ms) => { t += ms; }, now: () => t, people: pp };
};
const T = (n, extra = {}) => ({ imdbId: `tt${String(2000000 + n)}`, type: "movie", title: `Film ${n}`, year: 2020, ...extra });

test("a title is kept by its IMDb id (else the library id), cleaned; a bad one is refused", () => {
  assert.equal(household.cleanTitle({ id: "abc", imdbId: "tt1234567", title: "X" }).key, "tt1234567");
  assert.equal(household.cleanTitle({ id: "abc", title: "X" }).key, "lib:abc");
  assert.equal(household.cleanTitle({ id: "torrent|aa|0", title: "X" }), null);
  assert.equal(household.cleanTitle({ imdbId: "tt12", title: "X" }), null, "not an IMDb id");
  assert.equal(household.cleanTitle({ imdbId: "tt1234567", title: "  " }), null, "no title");
  const c = household.cleanTitle({ imdbId: "tt1234567", title: "X", type: "series", poster: "javascript:alert(1)", genres: ["Drama", 3], rating: 99 });
  assert.equal(c.type, "show");
  assert.equal(c.poster, null);
  assert.deepEqual(c.genres, ["Drama"]);
  assert.equal(c.rating, null);
});

test("the note is one clean line of at most 140 characters", () => {
  assert.equal(household.cleanNote("  you'll\nlove\tthis  "), "you'll love this");
  assert.equal(household.cleanNote("a\u2028b\u0007c"), "a b c");
  assert.equal(Array.from(household.cleanNote("😀".repeat(200))).length, 140);
  assert.equal(household.cleanNote(42), "");
});

test("names read the way the cards print them", () => {
  assert.equal(household.fromLine(["Dana"]), "From Dana");
  assert.equal(household.fromLine(["Dana", "Avi"]), "From Dana and Avi");
  assert.equal(household.fromLine(["Dana", "Avi", "Ben"]), "From Dana and 2 others");
});

test("at most 4 to the same person in a rolling hour; the answer says how long to wait", () => {
  const { hh, advance } = rig();
  for (let i = 1; i <= 4; i++) {
    const r = hh.send("dana", ["avi"], T(i), "");
    assert.equal(r.sent.length, 1, `send ${i}`);
    advance(5 * 60 * 1000); // 5 min apart: 0, 5, 10, 15
  }
  // now = +20 min: the first went at +0, so one more is possible at +60
  const r = hh.send("dana", ["avi"], T(5), "");
  assert.equal(r.sent.length, 0);
  assert.equal(r.refused[0].reason, "limit");
  assert.equal(r.refused[0].waitMin, 40);
  assert.equal(r.refused[0].line, "You can recommend more to Dana in 40 min".replace("Dana", "Avi"));
  // the picker says the same, greyed
  const avi = hh.peopleFor("dana", T(5)).find((p) => p.id === "avi");
  assert.equal(avi.state, "limit");
  assert.equal(avi.line, "More in 40 min");
  // somebody else is not affected
  assert.equal(hh.send("dana", ["ben"], T(5), "").sent.length, 1);
  // and an hour after the first, one more goes (rolling, not a clock hour)
  advance(40 * 60 * 1000);
  assert.equal(hh.send("dana", ["avi"], T(6), "").sent.length, 1);
  assert.equal(hh.send("dana", ["avi"], T(7), "").sent.length, 0, "the second one is still inside the hour");
});

test("the same title again to the same person updates the note and counts nothing", () => {
  const { hh } = rig();
  hh.send("dana", ["avi"], T(1), "first");
  for (let i = 0; i < 10; i++) {
    const r = hh.send("dana", ["avi"], T(1), `again ${i}`);
    assert.deepEqual(r.sent, [{ to: "avi", name: "Avi", updated: true }]);
  }
  const rows = hh.forRecipient("avi").items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from[0].note, "again 9");
  // only one counted: three more new ones still go
  for (let i = 2; i <= 4; i++) assert.equal(hh.send("dana", ["avi"], T(i), "").sent.length, 1);
  assert.equal(hh.send("dana", ["avi"], T(5), "").refused[0].reason, "limit");
  // a re-send with no note keeps the note there was
  hh.send("dana", ["avi"], T(1), "");
  assert.equal(hh.forRecipient("avi").items.find((g) => g.key === T(1).imdbId).from[0].note, "again 9");
  // the picker shows it as already sent, with the note
  const avi = hh.peopleFor("dana", T(1)).find((p) => p.id === "avi");
  assert.equal(avi.state, "sent");
  assert.equal(avi.note, "again 9");
});

test("a sane overall cap: 12 new ones an hour from one person, a send to three is three", () => {
  const people = [{ id: "s", name: "Sender" }, ...Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }))];
  const { hh } = rig({ people });
  const to = people.slice(1).map((p) => p.id);
  const a = hh.send("s", to, T(1), ""); // 6
  const b = hh.send("s", to, T(2), ""); // 12
  assert.equal(a.sent.length + b.sent.length, 12);
  const c = hh.send("s", ["p0"], T(3), "");
  assert.equal(c.refused[0].reason, "limit");
  assert.match(c.refused[0].line, /^You've sent a lot this hour — you can recommend more in \d+ min$/);
});

test("ranked by how many people recommended it, then the newest", () => {
  const { hh, advance } = rig();
  hh.send("dana", ["avi"], T(1), ""); advance(1000);
  hh.send("dana", ["avi"], T(2), "watch it!"); advance(1000);
  hh.send("ben", ["avi"], T(2), ""); advance(1000);
  hh.send("ben", ["avi"], T(3), ""); advance(1000);
  hh.send("noa", ["avi"], T(1), ""); advance(1000);
  hh.send("noa", ["avi"], T(2), ""); advance(1000);
  hh.send("dana", ["avi"], T(4), "");
  const r = hh.forRecipient("avi");
  assert.deepEqual(r.items.map((g) => [g.title.title, g.count]), [
    ["Film 2", 3], ["Film 1", 2], ["Film 4", 1], ["Film 3", 1],
  ]);
  assert.deepEqual(r.items[0].from.map((f) => f.name), ["Noa", "Ben", "Dana"], "newest first");
  assert.equal(r.total, 4);
  // filter by person
  assert.deepEqual(hh.forRecipient("avi", { from: "ben" }).items.map((g) => g.title.title), ["Film 2", "Film 3"]);
  assert.deepEqual(r.people.map((p) => [p.name, p.n]).sort(), [["Ben", 2], ["Dana", 3], ["Noa", 2]]);
});

test("not to yourself, not to a locked profile, not to someone unknown", () => {
  const { hh } = rig();
  const r = hh.send("dana", ["dana", "lock", "ghost", "avi"], T(1), "");
  assert.deepEqual(r.sent.map((s) => s.to), ["avi"]);
  assert.deepEqual(r.refused.map((x) => [x.to, x.reason]), [["dana", "unknown"], ["lock", "unknown"], ["ghost", "unknown"]]);
  const ids = hh.peopleFor("dana", T(1)).map((p) => p.id);
  assert.deepEqual(ids, ["avi", "noa", "ben"], "the picker lists neither yourself nor a locked profile");
  assert.equal(hh.send("ghost", ["avi"], T(1), "").status, 404);
  assert.equal(hh.send("dana", [], T(1), "").status, 400);
  assert.equal(hh.send("dana", ["avi"], { title: "no id" }, "").status, 400);
});

test("a kids profile: a title above its age, or with no age rating, is refused — and greyed in the picker", () => {
  const { hh } = rig();
  const fine = { imdbId: "tt1000001", type: "movie", title: "For all" };
  const old = { imdbId: "tt1000002", type: "movie", title: "Grown-up" };
  const unknown = T(9);
  assert.equal(hh.send("dana", ["noa"], fine, "").sent.length, 1);
  const r = hh.send("dana", ["noa", "avi"], old, "");
  assert.deepEqual(r.sent.map((s) => s.to), ["avi"]);
  assert.equal(r.refused[0].reason, "kids");
  assert.equal(r.refused[0].line, "Not for Noa's age");
  const u = hh.send("dana", ["noa"], unknown, "");
  assert.equal(u.refused[0].reason, "kids");
  assert.match(u.refused[0].line, /no age rating yet/);
  const picker = hh.peopleFor("dana", old);
  assert.equal(picker.find((p) => p.id === "noa").state, "kids");
  assert.equal(picker.find((p) => p.id === "noa").line, "Not for Noa's age");
  assert.equal(hh.peopleFor("dana", unknown).find((p) => p.id === "noa").line, "No age rating yet");
  assert.deepEqual(hh.forRecipient("noa").items.map((g) => g.key), ["tt1000001"]);
});

test("a kids limit lowered later: what was sent before is filtered on the way out", () => {
  const people = [{ id: "dana", name: "Dana" }, { id: "noa", name: "Noa", kids: { maxAge: 18 } }];
  const { hh } = rig({ people });
  assert.equal(hh.send("dana", ["noa"], { imdbId: "tt1000002", type: "movie", title: "Grown-up" }, "").sent.length, 1);
  assert.equal(hh.forRecipient("noa").items.length, 1);
  people[1].kids = { maxAge: 7 };
  assert.equal(hh.forRecipient("noa").items.length, 0);
});

test("mute: the sender is not told, nothing arrives, and the picker does not give it away", () => {
  const { hh, pinged } = rig();
  hh.setSettings("avi", { muted: ["dana"] });
  const r = hh.send("dana", ["avi"], T(1), "psst");
  assert.deepEqual(r.sent, [{ to: "avi", name: "Avi", updated: false }]);
  assert.equal(pinged.length, 0, "no ping for a muted sender");
  assert.equal(hh.forRecipient("avi").items.length, 0);
  assert.deepEqual(hh.forTitle("avi", T(1).imdbId).from, []);
  assert.equal(hh.peopleFor("dana", T(2)).find((p) => p.id === "avi").state, "ok");
  // the sender's own list says "sent", never more
  assert.equal(hh.sentBy("dana")[0].to[0].status, "sent");
  // somebody else is still heard
  hh.send("ben", ["avi"], T(1), "");
  assert.deepEqual(hh.forRecipient("avi").items.map((g) => g.from.map((f) => f.name)), [["Ben"]]);
  assert.deepEqual(pinged, ["avi"]);
  // the settings say who is muted
  assert.deepEqual(hh.settingsFor("avi").people.filter((p) => p.muted).map((p) => p.id), ["dana"]);
  assert.equal(hh.settingsFor("avi").on, true);
  // a muted id that is not a person of the household is not kept; nor is yourself
  hh.setSettings("avi", { muted: ["dana", "ghost", "avi"] });
  assert.deepEqual(hh.settingsFor("avi").people.filter((p) => p.muted).map((p) => p.id), ["dana"]);
});

test("off: the person is greyed for everyone, a send is refused, their row is empty", () => {
  const { hh } = rig();
  hh.send("dana", ["avi"], T(1), "");
  hh.setSettings("avi", { off: true });
  assert.equal(hh.settingsFor("avi").on, false);
  assert.equal(hh.forRecipient("avi").items.length, 0);
  const p = hh.peopleFor("ben", T(2)).find((x) => x.id === "avi");
  assert.equal(p.state, "off");
  assert.equal(p.line, "Not taking recommendations");
  assert.equal(hh.send("ben", ["avi"], T(2), "").refused[0].reason, "off");
  // back on: what was sent before comes back
  hh.setSettings("avi", { off: false });
  assert.equal(hh.forRecipient("avi").items.length, 1);
});

test("Not for me hides the title from every sender, now and later; undo brings it back", () => {
  const { hh } = rig();
  hh.send("dana", ["avi"], T(1), "");
  hh.send("ben", ["avi"], T(1), "");
  hh.send("dana", ["avi"], T(2), "");
  assert.equal(hh.dismiss("avi", T(1).imdbId).ok, true);
  assert.deepEqual(hh.forRecipient("avi").items.map((g) => g.key), [T(2).imdbId]);
  hh.send("noa", ["avi"], { ...T(1) }, ""); // (no age rating: Noa is the sender, Avi is no kid — fine)
  assert.deepEqual(hh.forRecipient("avi").items.map((g) => g.key), [T(2).imdbId], "a later sender does not bring it back");
  // the senders see "seen" at most
  assert.equal(hh.sentBy("dana").find((g) => g.key === T(1).imdbId).to[0].status, "seen");
  hh.dismiss("avi", T(1).imdbId, true);
  assert.equal(hh.forRecipient("avi").items[0].key, T(1).imdbId);
  assert.equal(hh.dismiss("avi", "tt0000000").ok, false);
});

test("what the person watched, is watching or has on their list leaves the row; the sender sees what became of it", () => {
  const { hh, fact } = rig();
  for (let i = 1; i <= 4; i++) hh.send("dana", ["avi"], T(i), "");
  fact("avi", "inList", T(1).imdbId);
  fact("avi", "watching", T(2).imdbId);
  fact("avi", "watched", T(3).imdbId);
  assert.deepEqual(hh.forRecipient("avi").items.map((g) => g.key), [T(4).imdbId]);
  hh.forTitle("avi", T(4).imdbId, { seen: true });
  const st = Object.fromEntries(hh.sentBy("dana").map((g) => [g.title.title, g.to[0].status]));
  assert.deepEqual(st, { "Film 1": "added", "Film 2": "watching", "Film 3": "watched", "Film 4": "seen" });
  // already watched: greyed in the picker, refused at the send
  assert.equal(hh.peopleFor("ben", T(3)).find((p) => p.id === "avi").state, "seen");
  assert.equal(hh.send("ben", ["avi"], T(3), "").refused[0].reason, "seen");
});

test("new ones are 'unseen' until the title (or the Show all page) is looked at", () => {
  const { hh } = rig();
  hh.send("dana", ["avi"], T(1), "");
  hh.send("dana", ["avi"], T(2), "");
  assert.equal(hh.forRecipient("avi").items.filter((g) => g.unseen).length, 2);
  const before = hh.stamp("avi");
  assert.equal(hh.forTitle("avi", T(1).imdbId, { seen: true }).from[0].name, "Dana");
  assert.notEqual(hh.stamp("avi"), before, "Home's memo learns of it");
  assert.equal(hh.forRecipient("avi").items.filter((g) => g.unseen).length, 1);
  hh.markSeen("avi");
  assert.equal(hh.forRecipient("avi").items.filter((g) => g.unseen).length, 0);
});

test("the recipient's Home stamp moves when something arrives for them — and only for them", () => {
  const { hh } = rig();
  const a = hh.stamp("avi");
  const b = hh.stamp("ben");
  hh.send("dana", ["avi"], T(1), "");
  assert.notEqual(hh.stamp("avi"), a);
  assert.equal(hh.stamp("ben"), b);
});

test("prune: older than 90 days goes, and anything from or to a profile that is gone", () => {
  const people = [{ id: "dana", name: "Dana" }, { id: "avi", name: "Avi" }, { id: "ben", name: "Ben" }];
  const { hh, advance, store } = rig({ people });
  hh.send("dana", ["avi"], T(1), "");
  advance(60 * DAY);
  hh.send("dana", ["avi"], T(2), "");
  hh.send("ben", ["avi"], T(3), "");
  hh.setSettings("avi", { muted: ["ben"] });
  advance(31 * DAY);
  hh.daily();
  assert.deepEqual(store.data.recs.map((r) => r.key), [T(2).imdbId, T(3).imdbId]);
  // Ben's profile is deleted: his recommendations and the mute of him go
  people.splice(2, 1);
  hh.daily();
  assert.deepEqual(store.data.recs.map((r) => r.key), [T(2).imdbId]);
  assert.equal(store.data.settings.avi, undefined, "nothing left to keep for Avi");
  assert.deepEqual(store.data.sends, {}, "the rolling hour has long passed");
});

test("prune keeps the store bounded: at most 300 per recipient, the oldest go first", () => {
  const people = [{ id: "avi", name: "Avi" }, ...Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, name: `S${i}` }))];
  const { hh, advance, store } = rig({ people });
  let n = 0;
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 80; i++) { hh.send(`s${i}`, ["avi"], T(++n), ""); advance(1000); }
    advance(2 * HOUR);
  }
  assert.equal(n, 320);
  assert.equal(store.data.recs.filter((r) => r.to === "avi").length, 300);
  assert.ok(!store.data.recs.some((r) => r.key === T(1).imdbId), "the oldest went");
});

test("a damaged store is read as empty, never thrown on", () => {
  const { hh, store } = rig();
  store.data = { recs: "nope", sends: null, settings: 3 };
  assert.deepEqual(hh.forRecipient("avi").items, []);
  assert.equal(hh.send("dana", ["avi"], T(1), "").sent.length, 1);
});
