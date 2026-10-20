// "Your TVs" (src/lib/devices.js): the phone as a remote and Play on TV.
// The registry's rules with fake clients, a recording send() and a hand-driven
// clock — scoping (same profile, the household switch, kids), proof of
// profile, rate limits, acks and their timeout, a device that disappears,
// several tabs of one browser — then realtime.js's proof rule itself.
const test = require("node:test");
const assert = require("node:assert/strict");

const devices = require("../src/lib/devices");
const { _reset, controllers, targets, pending } = devices._internals;

const PROFILES = {
  pa: { id: "pa", name: "Elia", kids: false },
  pb: { id: "pb", name: "Dana", kids: false },
  pk: { id: "pk", name: "Noa", kids: true },
};

const rig = ({ household = false, mode = "enforce" } = {}) => {
  _reset();
  const log = [];
  const timers = [];
  const clock = { t: 1000000 };
  const env = { household, mode };
  devices.configure({
    send: (to, data) => { log.push({ ...data, to }); return true; },
    // a socket "proves" what its test client says it may be
    prove: (client, claimed) => (client.may && client.may.includes(claimed) ? claimed : null),
    profile: (id) => PROFILES[id] || null,
    household: () => env.household,
    mode: () => env.mode,
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
const client = (id, may, extra = {}) => ({ id, may, profile: null, device: { os: "iOS", device: "Mobile" }, ...extra });
const tv = (id, profileId, deviceId = `tv-${id}-0000`, extra = {}) => ({ id, may: [profileId], deviceId, profileId, ...extra });
const announceTv = (t, more = {}) =>
  devices.announce(t, { deviceId: t.deviceId, name: "Living room TV", kind: "tv", profileId: t.profileId, caps: { navigate: true, volume: true }, ...more });

test("a TV announces itself; a remote of the SAME profile sees it, another profile's does not", () => {
  const r = rig();
  const t = tv("t1", "pa");
  assert.deepEqual(announceTv(t).device, { deviceId: t.deviceId, name: "Living room TV" });
  const mine = client("c1", ["pa"]);
  const other = client("c2", ["pb"]);
  devices.subscribe(mine, { profileId: "pa" });
  devices.subscribe(other, { profileId: "pb" });
  const a = r.last("c1", "remote_devices");
  assert.equal(a.devices.length, 1);
  assert.equal(a.devices[0].name, "Living room TV");
  assert.equal(a.devices[0].mine, true);
  assert.equal(a.devices[0].profile.name, "Elia");
  assert.deepEqual(r.last("c2", "remote_devices").devices, [], "Dana's phone does not see Elia's TV");
});

test("nothing happens on a claim alone: an unproven announce or subscribe is refused", () => {
  const r = rig();
  assert.equal(devices.announce(client("t1", ["pb"]), { deviceId: "tv-aaaa-0000", kind: "tv", profileId: "pa" }).error, "not-signed-in");
  assert.equal(devices.announce(client("t1", ["pa"]), { deviceId: "bad id!", kind: "tv", profileId: "pa" }).error, "bad-device-id");
  assert.equal(devices.announce(client("t1", ["pa"]), { deviceId: "tv-aaaa-0000", kind: "fridge", profileId: "pa" }).error, "bad-kind");
  assert.equal(targets.size, 0);
  assert.equal(devices.subscribe(client("c1", []), { profileId: "pa" }).error, "not-signed-in");
  assert.equal(r.last("c1", "remote_devices").error, "not-signed-in");
  assert.equal(controllers.size, 0);
});

test("the household switch: grown-ups may control the household's other devices; kids only ever their own", () => {
  const r = rig({ household: true });
  announceTv(tv("t1", "pa"));
  announceTv(tv("t2", "pk"));
  devices.subscribe(client("cb", ["pb"]), { profileId: "pb" });
  devices.subscribe(client("ck", ["pk"]), { profileId: "pk" });
  assert.deepEqual(r.last("cb", "remote_devices").devices.map((d) => d.profile.id).sort(), ["pa", "pk"], "Dana sees both");
  assert.equal(r.last("cb", "remote_devices").household, true);
  assert.deepEqual(r.last("ck", "remote_devices").devices.map((d) => d.profile.id), ["pk"], "the kids profile sees only its own TV");
  // a kids remote's command to a grown-up's TV is refused even if it knows the id
  devices.command(client("ck", ["pk"]), { id: "k1", deviceId: "tv-t1-0000", cmd: "pause" });
  assert.equal(r.last("ck", "remote_ack").error, "not-allowed");
  // the admin turns it off: the lists shrink at once, and commands are refused
  r.env.household = false;
  devices.recheck();
  assert.deepEqual(r.last("cb", "remote_devices").devices, []);
  devices.command(client("cb", ["pb"]), { id: "b1", deviceId: "tv-t1-0000", cmd: "pause" });
  assert.equal(r.last("cb", "remote_ack").error, "not-allowed");
});

test("a command goes to the TV and its answer back to the remote that sent it", () => {
  const r = rig();
  const t = tv("t1", "pa");
  announceTv(t);
  const c = client("c1", ["pa"], { profile: "Elia" });
  devices.subscribe(c, { profileId: "pa", label: "iPhone" });
  devices.command(c, { id: "x1", deviceId: t.deviceId, cmd: "seek", args: { to: 125.5 } });
  const got = r.last("t1", "remote_command");
  assert.equal(got.cmd, "seek");
  assert.deepEqual(got.args, { to: 125.5 });
  assert.deepEqual(got.from, { label: "iPhone", profileName: "Elia" });
  assert.equal(got.first, true, "the first command from this remote — the TV says who is in control");
  // only the TV's own socket may answer
  assert.equal(devices.ack(client("intruder", ["pa"]), { ref: got.ref, ok: true }), false);
  assert.equal(devices.ack(t, { ref: got.ref, ok: true }), true);
  const ack = r.last("c1", "remote_ack");
  assert.equal(ack.id, "x1");
  assert.equal(ack.ok, true);
  assert.equal(ack.deviceId, t.deviceId);
  assert.equal(pending.size, 0);
  devices.command(c, { id: "x2", deviceId: t.deviceId, cmd: "pause" });
  assert.equal(r.last("t1", "remote_command").first, false, "…and only the first time");
  devices.ack(t, { ref: r.last("t1", "remote_command").ref, ok: false, error: "nothing-playing", message: "Nothing is playing on the TV" });
  assert.deepEqual([r.last("c1", "remote_ack").ok, r.last("c1", "remote_ack").error, r.last("c1", "remote_ack").message], [false, "nothing-playing", "Nothing is playing on the TV"]);
  // the remote's own id rides along when it gave one (the TV counts its toast by it)
  const c2 = client("c2", ["pa"], { profile: "Elia" });
  devices.subscribe(c2, { profileId: "pa", label: "iPhone", remoteId: "phone-12345678" });
  devices.command(c2, { id: "x3", deviceId: t.deviceId, cmd: "pause" });
  assert.deepEqual(r.last("t1", "remote_command").from, { label: "iPhone", profileName: "Elia", id: "phone-12345678" });
  devices.ack(t, { ref: r.last("t1", "remote_command").ref, ok: true });
});

test("an unanswered command is answered by the server after ACK_MS: the TV didn't answer", () => {
  const r = rig();
  const t = tv("t1", "pa");
  announceTv(t);
  const c = client("c1", ["pa"]);
  devices.subscribe(c, { profileId: "pa" });
  devices.command(c, { id: "slow", deviceId: t.deviceId, cmd: "toggle" });
  r.tick(devices.ACK_MS - 1);
  assert.equal(r.to("c1", "remote_ack").length, 0);
  r.tick(2);
  const ack = r.last("c1", "remote_ack");
  assert.deepEqual([ack.id, ack.ok, ack.error], ["slow", false, "timeout"]);
  assert.match(ack.message, /didn't answer/);
  // a late answer changes nothing
  assert.equal(devices.ack(t, { ref: r.last("t1", "remote_command").ref, ok: true }), false);
  assert.equal(r.to("c1", "remote_ack").length, 1);
});

test("a TV that disappears: it leaves every list, and what waited for it is answered 'gone'", () => {
  const r = rig();
  const t = tv("t1", "pa");
  announceTv(t);
  const c = client("c1", ["pa"]);
  devices.subscribe(c, { profileId: "pa" });
  devices.command(c, { id: "w", deviceId: t.deviceId, cmd: "next" });
  devices.dropClient("t1");
  assert.deepEqual(r.last("c1", "remote_devices").devices, []);
  assert.equal(r.last("c1", "remote_ack").error, "gone");
  devices.command(c, { id: "w2", deviceId: t.deviceId, cmd: "next" });
  assert.equal(r.last("c1", "remote_ack").error, "gone");
  // it comes back (a reconnect after a server restart is just a new announce)
  announceTv({ ...t, id: "t1b" });
  assert.equal(r.last("c1", "remote_devices").devices.length, 1);
});

test("rate limit: a burst of presses is fine, a flood is refused (enforce) or only counted (log)", () => {
  const r = rig();
  const t = tv("t1", "pa");
  announceTv(t);
  const c = client("c1", ["pa"]);
  devices.subscribe(c, { profileId: "pa" });
  for (let i = 0; i < devices.CMD_BURST; i++) devices.command(c, { id: `k${i}`, deviceId: t.deviceId, cmd: "key", args: { key: "down" } });
  const refusedBefore = r.to("c1", "remote_ack").filter((a) => a.error === "slow-down").length;
  assert.equal(refusedBefore, 0, "a whole burst gets through");
  // (answer them, so the per-TV pending cap is not what refuses)
  for (const m of r.to("t1", "remote_command")) devices.ack(t, { ref: m.ref, ok: true });
  devices.command(c, { id: "over", deviceId: t.deviceId, cmd: "key", args: { key: "down" } });
  assert.equal(r.last("c1", "remote_ack").error, "slow-down");
  r.tick(1000); // refills CMD_RATE
  devices.command(c, { id: "after", deviceId: t.deviceId, cmd: "key", args: { key: "down" } });
  assert.equal(r.last("t1", "remote_command").args.key, "down");
  // log mode: never refused, counted
  r.env.mode = "log";
  const before = devices.status().rateLimited;
  for (let i = 0; i < 60; i++) {
    devices.command(c, { id: `l${i}`, deviceId: t.deviceId, cmd: "toggle" });
    devices.ack(t, { ref: r.last("t1", "remote_command").ref, ok: true });
  }
  assert.ok(devices.status().rateLimited > before);
  assert.equal(r.to("c1", "remote_ack").filter((a) => a.error === "slow-down").length, 1, "nothing more refused in log mode");
});

test("commands and their arguments are typed: junk is refused before it reaches the TV", () => {
  const r = rig();
  const t = tv("t1", "pa");
  announceTv(t, { caps: { navigate: false } });
  const c = client("c1", ["pa"]);
  devices.subscribe(c, { profileId: "pa" });
  const send = (cmd, args) => { devices.command(c, { id: cmd, deviceId: t.deviceId, cmd, args }); return r.last("c1", "remote_ack"); };
  assert.equal(send("format_disk", {}).error, "bad-command");
  assert.equal(send("seek", { to: "soon" }).error, "bad-command");
  assert.equal(send("skip", { by: 0 }).error, "bad-command");
  assert.equal(send("key", { key: "power" }).error, "bad-command");
  assert.equal(send("key", { key: "up" }).error, "unsupported", "a target that cannot steer is not sent arrows");
  assert.equal(send("play_item", { item: { title: "no id" } }).error, "bad-command");
  assert.equal(r.to("t1", "remote_command").length, 0);
  send("play_item", { item: { id: "ep1", title: "Pilot<script>", season: 1, episode: 2, poster: "javascript:alert(1)" }, position: 99.5, subLang: "he", audioLang: "off" });
  const m = r.last("t1", "remote_command");
  assert.equal(m.args.item.title, "Pilotscript");
  assert.equal(m.args.item.poster, null);
  assert.equal(m.args.position, 99.5);
  assert.equal(m.args.subLang, "he");
  assert.equal(m.args.audioLang, null);
  send("sub", { id: null });
  assert.deepEqual(r.last("t1", "remote_command").args, { id: null });
  send("volume", { level: 7 });
  assert.deepEqual(r.last("t1", "remote_command").args, { level: 1 });
});

test("state: a watching remote gets every tick, the others only what changed; the TV is told when it is watched", () => {
  const r = rig();
  const t = tv("t1", "pa");
  announceTv(t);
  const watching = client("c1", ["pa"]);
  const idle = client("c2", ["pa"]);
  devices.subscribe(idle, { profileId: "pa" });
  assert.equal(r.last("t1", "remote_watch").on, false);
  devices.subscribe(watching, { profileId: "pa", watch: t.deviceId });
  assert.equal(r.last("t1", "remote_watch").on, true, "a remote screen opened on it: tick every second");
  const now = (position, paused = false) => ({ screen: "player", now: { id: "m1", title: "Arrival", duration: 6000, position, paused, subs: [{ id: "en", label: "English", lang: "en" }], sub: "en" } });
  devices.stateFrom(t, now(10));
  devices.stateFrom(t, now(11));
  devices.stateFrom(t, now(12));
  assert.equal(r.to("c1", "device_state").length, 3);
  assert.equal(r.to("c2", "device_state").length, 1, "the idle one heard the title start, not the ticks");
  devices.stateFrom(t, now(13, true));
  assert.equal(r.to("c2", "device_state").length, 2, "…and the pause");
  assert.equal(r.last("c1", "device_state").state.now.position, 13);
  devices.unsubscribe("c1");
  assert.equal(r.last("t1", "remote_watch").on, false, "nobody is looking: back to the slow cadence");
  // the list carries the last state, for a remote that opens later
  devices.subscribe(client("c3", ["pa"]), { profileId: "pa" });
  assert.equal(r.last("c3", "remote_devices").devices[0].state.now.title, "Arrival");
});

test("a tab that is both a target and a remote never sees itself; tabs of one browser are one device", () => {
  const r = rig();
  const tabA = { id: "tabA", may: ["pa"] };
  const tabB = { id: "tabB", may: ["pa"] };
  const dev = { deviceId: "web-dev-1234", kind: "web", form: "computer", name: "Office PC", profileId: "pa" };
  devices.announce(tabA, dev);
  devices.announce(tabB, dev);
  assert.equal(targets.size, 1);
  devices.subscribe(tabA, { profileId: "pa", ownDeviceId: dev.deviceId });
  assert.deepEqual(r.last("tabA", "remote_devices").devices, [], "this browser is not offered to itself");
  const phone = client("ph", ["pa"]);
  devices.subscribe(phone, { profileId: "pa" });
  devices.command(phone, { id: "1", deviceId: dev.deviceId, cmd: "toggle" });
  assert.equal(r.to("tabB", "remote_command").length, 1, "the tab that announced last answers");
  assert.equal(r.to("tabA", "remote_command").length, 0);
  assert.equal(devices.stateFrom(tabA, { screen: "home" }), false, "the tab underneath does not speak for the device");
  devices.dropClient("tabB");
  assert.equal(r.last("ph", "remote_devices").devices.length, 1, "closing one tab leaves the device");
  devices.command(phone, { id: "2", deviceId: dev.deviceId, cmd: "toggle" });
  assert.equal(r.to("tabA", "remote_command").length, 1, "…and the other tab answers now");
});

test("a TV signed in to another profile is that profile's device from then on", () => {
  const r = rig();
  const t = { id: "t1", may: ["pa", "pb"], deviceId: "tv-shared-001" };
  devices.subscribe(client("ca", ["pa"]), { profileId: "pa" });
  devices.subscribe(client("cb", ["pb"]), { profileId: "pb" });
  devices.announce(t, { deviceId: t.deviceId, kind: "tv", profileId: "pa" });
  assert.equal(r.last("ca", "remote_devices").devices.length, 1);
  devices.announce(t, { deviceId: t.deviceId, kind: "tv", profileId: "pb" });
  assert.equal(r.last("ca", "remote_devices").devices.length, 0);
  assert.equal(r.last("cb", "remote_devices").devices.length, 1);
});

test("the state a TV reports is cut to size and typed", () => {
  const { cleanState } = devices._internals;
  const s = cleanState({ screen: "player".repeat(10), appState: "weird", volume: { supported: true, level: 3, muted: "yes", scope: "system" }, now: { id: "x", title: "T".repeat(500), position: -5, duration: "long", subs: new Array(100).fill({ id: "a", label: "A" }), poster: "/img/poster/x?w=300" } });
  assert.equal(s.screen.length, 24);
  assert.equal(s.appState, "active");
  assert.equal(s.now.title.length, 120);
  assert.equal(s.now.position, 0);
  assert.equal(s.now.duration, 0);
  assert.equal(s.now.subs.length, 40);
  assert.equal(s.now.poster, "/img/poster/x?w=300");
  assert.deepEqual(s.volume, { supported: true, level: 1, muted: false, scope: "system" });
  assert.equal(cleanState(null).now, null);
});

test("who the remote is, in words the TV can show (\"Elia's iPhone\")", () => {
  const { controllerLabel } = devices._internals;
  assert.equal(controllerLabel({ profile: "Elia", device: { os: "iOS", device: "Mobile" } }).word, "iPhone");
  assert.equal(controllerLabel({ device: { os: "Android", device: "Mobile" } }).word, "Android phone");
  assert.equal(controllerLabel({ device: { os: "Windows", device: "Desktop" } }).word, "PC");
  assert.equal(controllerLabel({ device: { os: "macOS" } }, "iPad").word, "iPad", "a known hint from the page wins");
  assert.equal(controllerLabel({ device: { os: "macOS" } }, "<b>hax</b>").word, "Mac", "an unknown one does not");
});

// ---------------------------------------------------------------- realtime.js: proof of profile
test("realtime proveProfile: session first; open mode: a password-free profile by name, a protected one only with its token; never locked or closed-mode claims", () => {
  const profiles = require("../src/profiles");
  const authmode = require("../src/lib/authmode");
  const realtime = require("../src/realtime");
  const { proveProfile } = realtime._internals;
  const saved = { list: profiles.list, isProtected: profiles.isProtected, tokenValid: profiles.tokenValid, resetDue: profiles.resetDue, get: authmode.get };
  let mode = "open";
  profiles.list = () => [{ id: "open1" }, { id: "prot1" }, { id: "lock1", locked: true }, { id: "reset1" }];
  profiles.isProtected = (id) => id === "prot1";
  profiles.tokenValid = (id, tok) => id === "prot1" && tok === "good-token";
  profiles.resetDue = (id) => id === "reset1";
  authmode.get = () => mode;
  try {
    const sock = (extra = {}) => ({ ws: { profileId: null, restricted: null, ...extra } });
    assert.equal(proveProfile(sock(), "open1", null), "open1");
    assert.equal(proveProfile(sock(), "prot1", null), null);
    assert.equal(proveProfile(sock(), "prot1", "bad"), null);
    assert.equal(proveProfile(sock(), "prot1", "good-token"), "prot1");
    assert.equal(proveProfile(sock(), "lock1", null), null, "a locked profile never");
    assert.equal(proveProfile(sock(), "reset1", null), null, "a profile that owes a new password never");
    assert.equal(proveProfile(sock(), "nobody", null), null);
    assert.equal(proveProfile(sock({ restricted: "open1" }), "open1", null), null);
    assert.equal(proveProfile(sock({ profileId: "prot1" }), "prot1", null), "prot1", "a session for it is proof");
    assert.equal(proveProfile(sock({ profileId: "prot1" }), "", null), "prot1", "no claim: the session's profile");
    mode = "closed";
    assert.equal(proveProfile(sock(), "open1", null), null, "closed: no session, nothing");
    assert.equal(proveProfile(sock({ profileId: "prot1" }), "open1", null), null, "closed: only the session's own profile");
    assert.equal(proveProfile(sock({ profileId: "prot1" }), "prot1", null), "prot1");
  } finally {
    Object.assign(profiles, { list: saved.list, isProtected: saved.isProtected, tokenValid: saved.tokenValid, resetDue: saved.resetDue });
    authmode.get = saved.get;
  }
});
