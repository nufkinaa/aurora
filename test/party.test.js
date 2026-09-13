// Watch parties: the registry's rules, with fake clients and a recording
// send() — no sockets.
const test = require("node:test");
const assert = require("node:assert");

const party = require("../src/lib/party");
const { parties, byClient } = party._internals;

const mk = (id, name) => ({ id, profile: name, profileId: `p-${id}` });
const sentTo = () => {
  const log = [];
  return { log, send: (id, data) => log.push({ id, type: data.type, data }) };
};
const reset = () => { parties.clear(); byClient.clear(); };

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
