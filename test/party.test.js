// Watch parties: the registry's rules, with fake clients and a recording
// send() — no sockets.
const test = require("node:test");
const assert = require("node:assert");

const party = require("../src/lib/party");
const { parties, byClient, keyOfClient } = party._internals;

const mk = (id, name) => ({ id, profile: name, profileId: `p-${id}` });
const sentTo = () => {
  const log = [];
  return { log, send: (id, data) => log.push({ id, type: data.type, data }) };
};
const reset = () => { parties.clear(); byClient.clear(); keyOfClient.clear(); };

test("create: a four-letter code, the host is the first member, the item is kept", () => {
  reset();
  const { send } = sentTo();
  const r = party.create(mk("h", "Elia"), { id: "lib1", title: "Arrival", _probePromise: "x" }, send);
  assert.ok(!r.error);
  assert.match(r.party.code, /^[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(r.party.members.length, 1);
  assert.equal(r.party.host.name, "Elia");
  assert.equal(r.party.item._probePromise, undefined, "client-only handles are dropped");
  assert.equal(party.codeFor("h"), r.party.code);
});

test("create refuses junk items", () => {
  reset();
  assert.ok(party.create(mk("h", "E"), null, () => {}).error);
  assert.ok(party.create(mk("h", "E"), { title: "no id" }, () => {}).error);
});

test("join: members hear about it, the joiner gets the current state; a bad code is refused", () => {
  reset();
  const { log, send } = sentTo();
  const { party: p } = party.create(mk("h", "Elia"), { id: "lib1" }, send);
  party.setState(mk("h"), { playing: true, position: 120, kind: "play" }, send);
  const r = party.join(mk("g", "Dana"), p.code.toLowerCase(), send);
  assert.ok(!r.error);
  assert.equal(r.party.members.length, 2);
  assert.equal(r.party.state.position, 120);
  assert.equal(r.party.state.playing, true);
  assert.ok(log.some((m) => m.id === "h" && m.type === "party_update" && m.data.joined === "Dana"));
  assert.ok(party.join(mk("x", "X"), "ZZZZ", send).error);
});

test("state: goes to everyone but the sender, with who and what", () => {
  reset();
  const { log, send } = sentTo();
  const { party: p } = party.create(mk("h", "Elia"), { id: "lib1" }, send);
  party.join(mk("g", "Dana"), p.code, send);
  log.length = 0;
  party.setState(mk("g", "Dana"), { playing: false, position: 300, kind: "pause" }, send);
  const got = log.filter((m) => m.type === "party_state");
  assert.deepEqual(got.map((m) => m.id), ["h"]);
  assert.equal(got[0].data.by, "Dana");
  assert.equal(got[0].data.kind, "pause");
  assert.equal(got[0].data.position, 300);
  assert.ok(party.setState(mk("nobody"), { playing: true }, send).error);
});

test("leave: a guest leaving updates the rest; the host leaving ends it for everyone", () => {
  reset();
  const { log, send } = sentTo();
  const { party: p } = party.create(mk("h", "Elia"), { id: "lib1" }, send);
  party.join(mk("g", "Dana"), p.code, send);
  party.join(mk("k", "Kim"), p.code, send);
  log.length = 0;
  assert.equal(party.leave(mk("g"), send), true);
  assert.ok(log.some((m) => m.type === "party_update" && m.data.left === "Dana"));
  assert.equal(party.get(p.code).members.length, 2);
  log.length = 0;
  assert.equal(party.leave(mk("h"), send), true);
  assert.equal(party.get(p.code), null);
  assert.ok(log.some((m) => m.id === "k" && m.type === "party_ended"));
  assert.equal(party.codeFor("k"), null);
  assert.equal(party.leave(mk("k"), send), false); // already gone
});

test("setItem: only the host moves the party; guests are told and the transport resets", () => {
  reset();
  const { log, send } = sentTo();
  const { party: p } = party.create(mk("h", "Elia"), { id: "ep1", title: "Pilot" }, send);
  party.join(mk("g", "Dana"), p.code, send);
  party.setState(mk("h"), { playing: true, position: 1200, kind: "play" }, send);
  assert.ok(party.setItem(mk("g"), { id: "ep2" }, send).error, "a guest can't move the party");
  log.length = 0;
  const r = party.setItem(mk("h"), { id: "ep2", title: "Episode 2", _probePromise: "x" }, send);
  assert.ok(!r.error);
  assert.equal(r.party.item.id, "ep2");
  assert.equal(r.party.item._probePromise, undefined);
  assert.deepEqual({ playing: r.party.state.playing, position: r.party.state.position }, { playing: false, position: 0 });
  const told = log.find((m) => m.type === "party_item");
  assert.ok(told && told.id === "g", "the guest hears about it");
  assert.equal(told.data.item.id, "ep2");
  assert.equal(party.get(p.code).item.id, "ep2", "the party carries the new item for late joiners");
  assert.ok(party.setItem(mk("x"), { id: "ep3" }, send).error, "not in a party");
});

test("one party per socket: creating again leaves the old one", () => {
  reset();
  const { send } = sentTo();
  const a = party.create(mk("h", "Elia"), { id: "lib1" }, send).party;
  const b = party.create(mk("h", "Elia"), { id: "lib2" }, send).party;
  assert.equal(party.get(a.code), null);
  assert.ok(party.get(b.code));
  assert.equal(party.list().length, 1);
  assert.equal(party.list()[0].host, "Elia");
});

// ---------- a person on a device, not a socket ----------
const mkd = (id, name, profileId) => ({ id, profile: name, profileId });

test("a dropped socket is away, not gone: the same person + device takes the place again (host too)", () => {
  reset();
  party.configure({ graceMs: 60000 });
  const { log, send } = sentTo();
  const { party: p } = party.create(mkd("h1", "Elia", "pe"), { id: "lib1" }, send, { device: "laptop" });
  party.join(mkd("g1", "Dana", "pd"), p.code, send, { device: "phone" });
  party.setState(mkd("h1", "Elia", "pe"), { playing: true, position: 50, kind: "play" }, send);
  log.length = 0;
  assert.equal(party.drop(mkd("h1", "Elia", "pe"), send), true);
  assert.ok(party.get(p.code), "the host's dropped socket does not end the party");
  assert.ok(log.some((m) => m.id === "g1" && m.type === "party_update" && m.data.away === "Elia"));
  assert.equal(party.get(p.code).members.find((m) => m.name === "Elia").away, true);
  // back on a new socket, same device: host again, at the party's state
  const r = party.join(mkd("h2", "Elia", "pe"), p.code, send, { device: "laptop" });
  assert.ok(!r.error && r.rejoined);
  assert.equal(r.party.host.id, r.party.you, "still the host");
  assert.equal(r.party.members.length, 2);
  assert.equal(r.party.state.position, 50);
  // the new socket is heard, the old one is not
  log.length = 0;
  party.setState(mkd("h2", "Elia", "pe"), { playing: false, position: 60, kind: "pause" }, send);
  assert.deepEqual(log.filter((m) => m.type === "party_state").map((m) => m.id), ["g1"]);
  assert.ok(party.setState(mkd("h1", "Elia", "pe"), { playing: true }, send).error, "the old socket is out");
  // a stale close of the old socket after the new one joined changes nothing
  assert.equal(party.drop(mkd("h1", "Elia", "pe"), send), false);
  assert.equal(party.get(p.code).members.every((m) => !m.away), true);
});

test("a host away past the grace hands the party to the next member; a guest away past it is dropped", async () => {
  reset();
  party.configure({ graceMs: 30 });
  const { log, send } = sentTo();
  const { party: p } = party.create(mkd("h", "Elia", "pe"), { id: "lib1" }, send, { device: "a" });
  party.join(mkd("g", "Dana", "pd"), p.code, send, { device: "b" });
  party.join(mkd("k", "Kim", "pk"), p.code, send, { device: "c" });
  party.drop(mkd("h", "Elia", "pe"), send);
  await new Promise((r) => setTimeout(r, 80));
  const now = party.get(p.code);
  assert.ok(now, "handed over, not ended");
  assert.equal(now.host.name, "Dana");
  assert.equal(now.members.length, 2);
  assert.ok(log.some((m) => m.id === "g" && m.type === "party_update" && m.data.host === "Dana" && m.data.party.you === m.data.party.host.id));
  party.drop(mkd("k", "Kim", "pk"), send);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(party.get(p.code).members.length, 1);
  // explicit End party from the (new) host ends it
  party.leave(mkd("g", "Dana", "pd"), send);
  assert.equal(party.get(p.code), null);
  party.configure({ graceMs: 120000 });
});

test("state: a sender's server-time stamp is kept when it is believable", () => {
  reset();
  const { log, send } = sentTo();
  const { party: p } = party.create(mk("h", "Elia"), { id: "lib1" }, send);
  party.join(mk("g", "Dana"), p.code, send);
  const at = Date.now() - 120;
  party.setState(mk("h"), { playing: true, position: 10, kind: "sync", at }, send);
  assert.equal(party.get(p.code).state.at, at);
  party.setState(mk("h"), { playing: true, position: 10, kind: "sync", at: Date.now() - 60000 }, send);
  assert.ok(Math.abs(party.get(p.code).state.at - Date.now()) < 50, "a wild stamp is replaced by now");
  assert.ok(log.length > 0);
});

// ---------- start together, everyone waits, reactions, handover ----------
const three = (send) => {
  const { party: p } = party.create(mkd("h", "Elia", "pe"), { id: "lib1" }, send, { device: "a" });
  party.join(mkd("g", "Dana", "pd"), p.code, send, { device: "b" });
  party.join(mkd("k", "Kim", "pk"), p.code, send, { device: "c" });
  return p;
};

test("a jump while playing is a start together: everyone (the jumper too) gets the same future server instant; a play goes to the others at once", () => {
  reset();
  party.configure({ startLeadMs: 400 });
  const { log, send } = sentTo();
  const p = three(send);
  log.length = 0;
  const before = Date.now();
  party.setState(mkd("g", "Dana", "pd"), { playing: true, position: 42, kind: "seek" }, send);
  const got = log.filter((m) => m.type === "party_state");
  assert.deepEqual(got.map((m) => m.id).sort(), ["g", "h", "k"]);
  const ats = new Set(got.map((m) => m.data.at));
  assert.equal(ats.size, 1, "one instant for all");
  assert.ok([...ats][0] >= before + 400, "in the future");
  assert.equal(got.find((m) => m.id === "g").data.self, true, "the presser knows it was its own");
  // a host tick before the start has started is not believed
  party.setState(mkd("h", "Elia", "pe"), { playing: true, position: 40, kind: "sync" }, send);
  assert.equal(party.get(p.code).state.position, 42);
  // a play: the others, now (the presser is already moving)
  log.length = 0;
  party.setState(mkd("h", "Elia", "pe"), { playing: true, position: 42, kind: "play" }, send);
  const play = log.filter((m) => m.type === "party_state");
  assert.deepEqual(play.map((m) => m.id).sort(), ["g", "k"]);
  assert.ok(play[0].data.at <= Date.now());
  // a pause goes to the others only, now
  log.length = 0;
  party.setState(mkd("h", "Elia", "pe"), { playing: false, position: 43, kind: "pause" }, send);
  assert.deepEqual(log.filter((m) => m.type === "party_state").map((m) => m.id).sort(), ["g", "k"]);
});

test("everyone waits for whoever buffers, and starts again together when all are ready", () => {
  reset();
  party.configure({ startLeadMs: 300, waitGiveUpMs: 60000 });
  const { log, send } = sentTo();
  const p = three(send);
  party.setState(mkd("h", "Elia", "pe"), { playing: true, position: 100, kind: "play" }, send);
  // buffering while paused does nothing
  log.length = 0;
  party.setState(mkd("h", "Elia", "pe"), { playing: false, position: 100, kind: "pause" }, send);
  party.setBuffering(mkd("g", "Dana", "pd"), { buffering: true, position: 100 }, send);
  assert.equal(log.filter((m) => m.data.kind === "wait").length, 0);
  party.setState(mkd("h", "Elia", "pe"), { playing: true, position: 100, kind: "play" }, send);
  log.length = 0;
  party.setBuffering(mkd("g", "Dana", "pd"), { buffering: true, position: 99.5 }, send);
  let waits = log.filter((m) => m.data.kind === "wait");
  assert.deepEqual(waits.map((m) => m.id).sort(), ["g", "h", "k"], "everyone is told to wait");
  assert.equal(waits[0].data.position, 99.5, "held where the slow one is");
  assert.deepEqual(waits[0].data.waiting, ["Dana"]);
  assert.deepEqual(party.get(p.code).waiting, ["Dana"], "a late joiner sees who is being waited for");
  assert.equal(party.get(p.code).state.playing, false);
  // a second one stalls too: the hold stays where it was
  party.setBuffering(mkd("k", "Kim", "pk"), { buffering: true, position: 99 }, send);
  assert.deepEqual(party.get(p.code).waiting, ["Dana", "Kim"]);
  log.length = 0;
  party.setBuffering(mkd("g", "Dana", "pd"), { buffering: false }, send);
  assert.equal(log.filter((m) => m.data.kind === "resume").length, 0, "still waiting for Kim");
  assert.deepEqual(log.find((m) => m.data.kind === "wait").data.waiting, ["Kim"]);
  log.length = 0;
  const before = Date.now();
  party.setBuffering(mkd("k", "Kim", "pk"), { buffering: false }, send);
  const res = log.filter((m) => m.data.kind === "resume");
  assert.deepEqual(res.map((m) => m.id).sort(), ["g", "h", "k"]);
  assert.equal(res[0].data.position, 99.5);
  assert.ok(res[0].data.at >= before + 300 && res[0].data.playing === true);
  assert.deepEqual(party.get(p.code).waiting, []);
});

test("a waiting member who goes away is not waited for; nor one who takes too long", async () => {
  reset();
  party.configure({ startLeadMs: 0, waitGiveUpMs: 40 });
  const { log, send } = sentTo();
  three(send);
  party.setState(mkd("h", "Elia", "pe"), { playing: true, position: 10, kind: "play" }, send);
  party.setBuffering(mkd("g", "Dana", "pd"), { buffering: true, position: 10 }, send);
  log.length = 0;
  party.drop(mkd("g", "Dana", "pd"), send);
  assert.ok(log.some((m) => m.data.kind === "resume"), "away: the others go on");
  party.setBuffering(mkd("k", "Kim", "pk"), { buffering: true, position: 12 }, send);
  log.length = 0;
  await new Promise((r) => setTimeout(r, 90));
  const gave = log.find((m) => m.data.kind === "resume");
  assert.ok(gave && gave.data.gaveUp && gave.data.gaveUp[0] === "Kim", "gave up on Kim, and says so");
  party.configure({ startLeadMs: 400, waitGiveUpMs: 20000 });
});

test("reactions: one of a few faces, to everyone, a held key is one face", () => {
  reset();
  const { log, send } = sentTo();
  three(send);
  party.react(mkd("g", "Dana", "pd"), { emoji: "😂" }, send);
  party.react(mkd("g", "Dana", "pd"), { emoji: "😂" }, send);
  assert.deepEqual(log.filter((m) => m.type === "party_react").map((m) => m.id).sort(), ["g", "h", "k"]);
  assert.ok(party.react(mkd("g", "Dana", "pd"), { emoji: "<script>" }, send).error);
});

test("the host can leave the party running: the next member hosts", () => {
  reset();
  const { log, send } = sentTo();
  const p = three(send);
  log.length = 0;
  party.leave(mkd("h", "Elia", "pe"), send, { handover: true });
  const now = party.get(p.code);
  assert.ok(now);
  assert.equal(now.host.name, "Dana");
  assert.ok(log.some((m) => m.id === "g" && m.data.host === "Dana"));
});
