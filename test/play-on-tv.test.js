// "Play on TV" / "Continue on TV" (src/lib/devices.js, the handoff round):
// who may send a title to which TV, a TV on its profile wall, the answers
// (playing / the TV asks for the PIN / didn't answer), commands that expire,
// a TV that is off, two senders at once — then realtime.js's wall proof.
// Same rig as test/devices.test.js: fake clients, a recording send(), a hand-driven clock.
const test = require("node:test");
const assert = require("node:assert/strict");

const devices = require("../src/lib/devices");
const { _reset, targets, pending } = devices._internals;

const PROFILES = {
  pa: { id: "pa", name: "Elia", kids: false },
  pb: { id: "pb", name: "Dana", kids: false },
  pk: { id: "pk", name: "Noa", kids: true },
};

const rig = ({ household = false, wallOk = true } = {}) => {
  _reset();
  const log = [];
  const timers = [];
  const clock = { t: 5000000 };
  const env = { household, wallOk };
  devices.configure({
    send: (to, data) => { log.push({ ...data, to }); return true; },
    prove: (client, claimed) => (client.may && client.may.includes(claimed) ? claimed : null),
    proveWall: (client) => env.wallOk && !client.restricted,
    profile: (id) => PROFILES[id] || null,
    household: () => env.household,
    mode: () => "enforce",
    now: () => clock.t,
    setTimeout: (fn, ms) => { const h = { fn, at: clock.t + ms, done: false }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.done = true; },
  });
  const tick = (ms) => {
    clock.t += ms;
    for (const h of timers) if (!h.done && h.at <= clock.t) { h.done = true; h.fn(); }
  };
  const to = (id, type) => log.filter((m) => m.to === id && (!type || m.type === type));
  const last = (id, type) => to(id, type).slice(-1)[0];
  return { log, tick, to, last, env, clock };
};
const phone = (id, profileId, name) => {
  const c = { id, may: [profileId], profile: name || null, device: { os: "Android", device: "Mobile" } };
  devices.subscribe(c, { profileId, label: "Android phone" });
  return c;
};
const tvIn = (id, profileId, deviceId = `tv-${id}-00000000`) => {
  const t = { id, may: [profileId], deviceId };
  devices.announce(t, { deviceId, name: "Living room TV", kind: "tv", profileId, caps: { navigate: true, volume: true } });
  return t;
};
const tvOnWall = (id, deviceId = `tv-${id}-00000000`, extra = {}) => {
  const t = { id, may: [], deviceId, ...extra };
  const r = devices.announce(t, { deviceId, name: "Living room TV", kind: "tv", wall: true, profileId: "pa", caps: { navigate: true, volume: true } });
  return { t, r };
};
const ITEM = { id: "lib-arrival", title: "Arrival", type: "movie", duration: 6960 };
const playItem = (c, deviceId, id = "p1", position = 1834.5) =>
  devices.command(c, { id, deviceId, cmd: "play_item", args: { item: ITEM, position } });

// ---------------------------------------------------------------- authorisation
test("authorised: the TV signed in to the SAME profile takes the title; another profile's TV is refused", () => {
  const r = rig();
  const t = tvIn("t1", "pa");
  const mine = phone("c1", "pa", "Elia");
  const other = phone("c2", "pb", "Dana");
  playItem(mine, t.deviceId);
  const got = r.last("t1", "remote_command");
  assert.equal(got.cmd, "play_item");
  assert.equal(got.args.item.id, "lib-arrival");
  assert.equal(got.args.position, 1834.5, "the second the phone was at");
  playItem(other, t.deviceId, "p2");
  const no = r.last("c2", "remote_ack");
  assert.deepEqual([no.ok, no.error], [false, "not-allowed"]);
  assert.equal(r.to("t1", "remote_command").length, 1, "Dana's command never reached the TV");
});

test("authorised: with the household switch, a grown-up may send to another's TV — a kids profile never", () => {
  const r = rig({ household: true });
  const t = tvIn("t1", "pa");
  const dana = phone("cb", "pb", "Dana");
  playItem(dana, t.deviceId, "b1");
  assert.equal(r.last("t1", "remote_command").from.profileId, "pb");
  playItem(phone("ck", "pk", "Noa"), t.deviceId, "k1");
  assert.equal(r.last("ck", "remote_ack").error, "not-allowed");
  // the switch is read again on every command, not only when the list was sent
  r.env.household = false;
  playItem(dana, t.deviceId, "b2");
  assert.equal(r.last("cb", "remote_ack").error, "not-allowed");
});

test("who asks is the server's proof, never the phone's claim: from.profileId is the subscribed profile", () => {
  const r = rig();
  const { t } = tvOnWall("w1");
  const c = phone("c1", "pa", "Elia");
  devices.command(c, { id: "p1", deviceId: t.deviceId, cmd: "play_item", args: { item: ITEM }, from: { profileId: "pb" }, profileId: "pb" });
  const got = r.last("w1", "remote_command");
  assert.equal(got.from.profileId, "pa");
  assert.equal(got.from.profileName, "Elia");
});

// ---------------------------------------------------------------- a TV on its profile wall
test("a TV on its profile wall: nobody's, offered to every proven profile, titles only", () => {
  const r = rig();
  const { t, r: ok } = tvOnWall("w1");
  assert.deepEqual(ok.device, { deviceId: t.deviceId, name: "Living room TV" });
  const a = phone("ca", "pa", "Elia");
  const k = phone("ck", "pk", "Noa");
  for (const id of ["ca", "ck"]) {
    const list = r.last(id, "remote_devices").devices;
    assert.equal(list.length, 1);
    assert.equal(list[0].wall, true);
    assert.equal(list[0].mine, false);
    assert.equal(list[0].profile, null, "no one is signed in to it");
    assert.deepEqual(list[0].caps, { navigate: false, volume: false, playItem: true, tracks: false }, "whatever it claimed");
  }
  playItem(a, t.deviceId);
  assert.equal(r.last("w1", "remote_command").from.profileId, "pa");
  for (const [cmd, args] of [["key", { key: "ok" }], ["pause", {}], ["seek", { to: 5 }], ["rename", { name: "Mine now" }]]) {
    devices.command(a, { id: `x-${cmd}`, deviceId: t.deviceId, cmd, args });
    const ack = r.last("ca", "remote_ack");
    assert.deepEqual([ack.id, ack.ok, ack.error], [`x-${cmd}`, false, "on-wall"], cmd);
  }
  assert.equal(r.to("w1", "remote_command").length, 1, "only the title reached the TV");
});

test("a wall announce needs proof (a session, or a server that is not closed); never a must-reset socket, never a computer", () => {
  rig({ wallOk: false });
  assert.equal(tvOnWall("w1").r.error, "not-signed-in");
  rig();
  assert.equal(tvOnWall("w2", undefined, { restricted: "pa" }).r.error, "not-signed-in");
  const t = { id: "web1", may: [], deviceId: "web-12345678" };
  assert.equal(devices.announce(t, { deviceId: t.deviceId, kind: "web", wall: true }).error, "bad-kind");
  assert.equal(targets.size, 0);
});

test("the wall in the whole house is capped (a script cannot fill everyone's list)", () => {
  rig();
  for (let i = 0; i < devices.MAX_WALL_TARGETS; i++) assert.ok(tvOnWall(`w${i}`, `tv-wall-${String(i).padStart(4, "0")}`).r.device);
  assert.equal(tvOnWall("w-extra", "tv-wall-extra").r.error, "too-many-devices");
});

test("the TV leaves the wall for the profile: the SAME device, now that profile's — the remote carries on with it", () => {
  const r = rig();
  const { t } = tvOnWall("w1");
  const a = phone("ca", "pa", "Elia");
  phone("cb", "pb", "Dana");
  playItem(a, t.deviceId);
  devices.ack(t, { ref: r.last("w1", "remote_command").ref, ok: true, status: "playing" });
  // the wall's socket closes, the profile's socket announces the same box
  devices.dropClient("w1");
  const t2 = tvIn("w1b", "pa", t.deviceId);
  const listA = r.last("ca", "remote_devices").devices;
  assert.deepEqual(listA.map((d) => [d.deviceId, d.wall, d.mine]), [[t2.deviceId, false, true]]);
  assert.deepEqual(r.last("cb", "remote_devices").devices, [], "Dana no longer sees it: it is Elia's now");
  devices.command(a, { id: "k1", deviceId: t2.deviceId, cmd: "key", args: { key: "ok" } });
  assert.equal(r.last("w1b", "remote_command").cmd, "key", "the remote steers it now");
});

// ---------------------------------------------------------------- the answers
test("the answer: 'playing' / the TV asks for the PIN or the password — passed back as status; anything else is dropped", () => {
  const r = rig();
  const { t } = tvOnWall("w1");
  const a = phone("ca", "pa", "Elia");
  for (const status of ["playing", "needs-pin", "needs-password", "<b>hax</b>"]) {
    playItem(a, t.deviceId, `p-${status}`);
    devices.ack(t, { ref: r.last("w1", "remote_command").ref, ok: true, status, message: "Enter your PIN to play Arrival" });
    const ack = r.last("ca", "remote_ack");
    assert.equal(ack.ok, true);
    assert.equal(ack.status, status === "<b>hax</b>" ? undefined : status, status);
  }
  // a refusal carries no status, only its reason
  playItem(a, t.deviceId, "p-no");
  devices.ack(t, { ref: r.last("w1", "remote_command").ref, ok: false, error: "locked", message: "That profile has been locked by an admin", status: "playing" });
  const no = r.last("ca", "remote_ack");
  assert.deepEqual([no.ok, no.error, no.status], [false, "locked", undefined]);
});

test("a locked profile cannot send at all: its phone is not proven, so it sees no TV and its command is refused", () => {
  const r = rig();
  const t = tvIn("t1", "pa");
  // (realtime.js proveProfile never proves a locked profile — its own test pins that)
  const locked = { id: "cl", may: [], profile: "Locked", device: { os: "iOS" } };
  devices.subscribe(locked, { profileId: "pa" });
  assert.equal(r.last("cl", "remote_devices").error, "not-signed-in");
  devices.command(locked, { id: "p1", deviceId: t.deviceId, cmd: "play_item", args: { item: ITEM } });
  assert.equal(r.last("cl", "remote_ack").error, "not-subscribed");
  assert.equal(r.to("t1", "remote_command").length, 0);
});

// ---------------------------------------------------------------- expiry
test("every command carries when it was sent and how long it is good for; unanswered, the sender hears '<TV> didn't answer' after ACK_MS", () => {
  const r = rig();
  const t = tvIn("t1", "pa");
  const a = phone("ca", "pa", "Elia");
  playItem(a, t.deviceId);
  const got = r.last("t1", "remote_command");
  assert.equal(got.at, r.clock.t);
  assert.equal(got.ttl, devices.ACK_MS);
  assert.ok(devices.ACK_MS <= 10000, "a few seconds");
  r.tick(devices.ACK_MS - 1);
  assert.equal(r.to("ca", "remote_ack").length, 0);
  r.tick(1);
  const ack = r.last("ca", "remote_ack");
  assert.deepEqual([ack.ok, ack.error, ack.message], [false, "timeout", "Living room TV didn't answer"]);
  assert.equal(pending.size, 0);
  // the TV's answer after that is nobody's
  assert.equal(devices.ack(t, { ref: got.ref, ok: true, status: "playing" }), false);
  assert.equal(r.to("ca", "remote_ack").length, 1);
});

// ---------------------------------------------------------------- an offline TV
test("an offline TV: not in the list, a command to it is answered 'gone' at once; one that goes away mid-command too", () => {
  const r = rig();
  const a = phone("ca", "pa", "Elia");
  devices.command(a, { id: "p0", deviceId: "tv-never-000000", cmd: "play_item", args: { item: ITEM } });
  assert.deepEqual([r.last("ca", "remote_ack").ok, r.last("ca", "remote_ack").error], [false, "gone"]);
  const t = tvIn("t1", "pa");
  playItem(a, t.deviceId, "p1");
  devices.dropClient("t1"); // switched off at the wall
  const ack = r.last("ca", "remote_ack");
  assert.deepEqual([ack.id, ack.ok, ack.error, ack.message], ["p1", false, "gone", "Living room TV went away"]);
  assert.deepEqual(r.last("ca", "remote_devices").devices, []);
});

// ---------------------------------------------------------------- two senders at once
test("two senders at once: the later title wins and the earlier sender is told at once; other commands are not touched", () => {
  const r = rig({ household: true });
  const t = tvIn("t1", "pa");
  const a = phone("ca", "pa", "Elia");
  const b = phone("cb", "pb", "Dana");
  devices.command(a, { id: "s1", deviceId: t.deviceId, cmd: "skip", args: { by: 10 } });
  playItem(a, t.deviceId, "a1");
  const first = r.last("t1", "remote_command");
  playItem(b, t.deviceId, "b1");
  const second = r.last("t1", "remote_command");
  assert.notEqual(first.ref, second.ref);
  const aAck = r.last("ca", "remote_ack");
  assert.deepEqual([aAck.id, aAck.ok, aAck.error, aAck.message], ["a1", false, "superseded", "Something else was just started on Living room TV"]);
  // the TV answers both: only the second sender hears it
  devices.ack(t, { ref: first.ref, ok: true, status: "playing" });
  devices.ack(t, { ref: second.ref, ok: true, status: "playing" });
  assert.equal(r.to("ca", "remote_ack").filter((m) => m.id === "a1").length, 1, "Elia heard once");
  assert.deepEqual([r.last("cb", "remote_ack").id, r.last("cb", "remote_ack").ok, r.last("cb", "remote_ack").status], ["b1", true, "playing"]);
  assert.equal([...pending.values()].filter((p) => p.cmd === "skip").length, 1, "the skip still waits for its own answer");
  assert.equal(devices.status().superseded, 1);
});

test("two senders on a wall TV: the later profile is the one the TV is asked to open", () => {
  const r = rig();
  const { t } = tvOnWall("w1");
  playItem(phone("ca", "pa", "Elia"), t.deviceId, "a1");
  playItem(phone("cb", "pb", "Dana"), t.deviceId, "b1");
  assert.equal(r.last("ca", "remote_ack").error, "superseded");
  assert.equal(r.last("w1", "remote_command").from.profileId, "pb");
});

// ---------------------------------------------------------------- realtime.js: the wall proof
test("realtime proveWall: a session always; otherwise only when the server is not closed; never a must-reset socket", () => {
  const authmode = require("../src/lib/authmode");
  const realtime = require("../src/realtime");
  const { proveWall } = realtime._internals;
  const saved = authmode.get;
  let mode = "transition";
  authmode.get = () => mode;
  try {
    const sock = (extra = {}) => ({ ws: { authed: false, profileId: null, restricted: null, ...extra } });
    assert.equal(proveWall(sock()), true, "transition: the wall is open to the house");
    assert.equal(proveWall(sock({ restricted: "pa" })), false);
    assert.equal(proveWall({}), false);
    mode = "closed";
    assert.equal(proveWall(sock()), false, "closed: no session, no wall");
    assert.equal(proveWall(sock({ authed: true, profileId: "pa" })), true);
    assert.equal(proveWall(sock({ authed: true, restricted: "pa" })), false);
  } finally {
    authmode.get = saved;
  }
});
