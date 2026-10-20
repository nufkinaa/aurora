// "Your TVs": the phone as a remote, and "Play on TV" (owner, 2026-10-19:
// "phone as a remote and 'play on TV' — yes yes I love that!!!").
//
// A channel over the app's one WebSocket (src/realtime.js routes the messages
// here). Two roles, any socket can hold either or both:
//
//   TARGET     — something that plays: the TV app, and the website on a
//                computer or tablet ("Play on this computer"). It ANNOUNCES
//                itself, reports what it is doing, and carries out commands.
//   CONTROLLER — the remote: the website's remote screen (a phone, usually),
//                and every website tab that wants to know whether a TV is on
//                (the "Play on TV" buttons, the Remote entry in the menu).
//
// Pure over a send(clientId, data) function, an identity check and a clock, so
// test/devices.test.js pins every rule without sockets (the party module's
// shape, lib/party.js). In memory only: a device that is not connected is not
// a device — it comes back by announcing itself again.
//
// ---------------------------------------------------------------- the protocol (v1)
//
// TARGET → server
//   {type:"device_announce", deviceId, name, kind:"tv"|"web", form?, model?,
//    profileId, token?, caps:{navigate,volume,playItem,tracks}, state?}
//       deviceId: [A-Za-z0-9_-]{8,48}, the box's own (TV: kept in storage;
//       website: kept in localStorage — several tabs of one browser are ONE
//       device, the tab that announced last is the one that answers).
//       Answered with {type:"device_ok", deviceId, name} or
//       {type:"device_error", error}. Sent again on every (re)connect and
//       whenever name / profile / caps change.
//   {type:"device_state", state}       what it is doing (see cleanState below).
//       A target sends it on every change, and every second while
//       `remote_watch` is on (a remote screen is looking at it), else at most
//       every few seconds.
//   {type:"device_leave"}              stop being a target (the socket stays).
//   {type:"remote_ack", ref, ok, error?, message?}   the answer to a command.
//
// server → TARGET
//   {type:"remote_command", ref, cmd, args, from:{label, profileName}, first}
//       `first`: the first command from this remote since the target
//       announced — the TV shows "Controlled from Elia's iPhone" then.
//   {type:"remote_watch", on}           a remote screen opened / closed on it.
//
// CONTROLLER → server
//   {type:"remote_subscribe", profileId, token?, watch?: deviceId|null, label?, remoteId?}
//       Answered (and whenever the list changes) with
//       {type:"remote_devices", devices:[publicDevice], household}.
//   {type:"remote_unsubscribe"}
//   {type:"remote_command", id, deviceId, cmd, args}
//       Answered with {type:"remote_ack", id, deviceId, ok, error?, message?}:
//       the target's own answer, or the server's refusal ("not-allowed",
//       "gone", "slow-down", "bad-command"), or "timeout" after ACK_MS.
//
// server → CONTROLLER
//   {type:"device_state", deviceId, state}  pushed live: every tick to a
//       controller WATCHING that device, only the changes that matter (another
//       title, paused, tracks, volume…) to the others.
//
// ---------------------------------------------------------------- who may control what
//
// A socket's profile is PROVEN, never just claimed (realtime.js proveProfile):
// its sign-in session; else, on a server that is not "closed", the profile it
// names when that profile has no password, or with the profile's unlock token
// when it has one. Then:
//   - a remote controls the targets signed in to the SAME profile;
//   - with the admin's "household" switch on (settings.json remoteHousehold,
//     off by default), any grown-up profile may also control the household's
//     other targets — a kids profile never: kids control only their own;
//   - a target never appears to itself.
// Every command is checked again when it arrives (a profile switched, the
// admin's switch flipped), not only when the list was sent.
"use strict";

const ACK_MS = 6000;
const MAX_PENDING_PER_TARGET = 24;
// Per remote: commands a second, and at once. A D-pad being swiped is the
// busiest a hand gets (~8 a second); this is twice that, with room for a burst.
const CMD_RATE = 15;
const CMD_BURST = 40;
const MAX_TARGETS_PER_PROFILE = 24;
const STATE_MAX_JSON = 16 * 1024;

const ID_RE = /^[A-Za-z0-9_-]{8,48}$/;
const KINDS = new Set(["tv", "web"]);
const FORMS = new Set(["tv", "computer", "tablet", "phone"]);
const KEYS = new Set(["up", "down", "left", "right", "ok", "back", "home"]);
const LABELS = new Set(["iPhone", "iPad", "Android phone", "Android tablet", "phone", "tablet", "Mac", "PC", "Chromebook", "computer", "TV"]);

const targets = new Map(); // deviceId -> target
const targetOf = new Map(); // clientId -> deviceId
const controllers = new Map(); // clientId -> controller
const pending = new Map(); // ref -> {controllerId, id, deviceId, timer, at}
const counters = { announced: 0, commands: 0, refused: 0, rateLimited: 0, timeouts: 0, acks: 0 };
let refSeq = 0;

// Replaceable by the tests (and wired by realtime.js).
const deps = {
  send: () => false, // (clientId, data) -> bool
  prove: () => null, // (client, profileId, token) -> proven profile id | null
  profile: () => null, // (profileId) -> {id, name, avatar, kids:boolean} | null
  household: () => false, // the admin's switch
  mode: () => "enforce", // the WebSocket limits' mode: "enforce" | "log" | "off"
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
};
const configure = (d) => Object.assign(deps, d || {});

const tidy = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, n);
const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);
const int = (v, lo, hi) => { const n = num(v, lo, hi); return n == null ? null : Math.round(n); };
const bool = (v) => v === true;
// a picture the clients can draw: one of the server's own paths, or http(s)
const pic = (v) => {
  const s = typeof v === "string" ? v.slice(0, 400) : "";
  return /^\/(img|api|media|avatars|stills)\//.test(s) || /^https?:\/\/[^\s"'<>]+$/.test(s) ? s : null;
};
const trackList = (list, max) =>
  Array.isArray(list)
    ? list.slice(0, max).map((t) => (t && typeof t === "object" ? { id: tidy(t.id, 160), label: tidy(t.label, 60), lang: tidy(t.lang, 12) || null } : null)).filter((t) => t && t.id)
    : [];

// What a target may say about itself. Everything is cut to size and typed;
// what does not fit is dropped, never stored as sent.
const cleanState = (s) => {
  if (!s || typeof s !== "object") return { screen: null, appState: "active", now: null, volume: null };
  const out = {
    screen: tidy(s.screen, 24) || null,
    appState: s.appState === "background" ? "background" : "active",
    now: null,
    volume: null,
  };
  const n = s.now;
  if (n && typeof n === "object" && typeof n.id === "string" && n.id) {
    out.now = {
      id: tidy(n.id, 200),
      title: tidy(n.title, 120),
      showTitle: tidy(n.showTitle, 120) || null,
      epTitle: tidy(n.epTitle, 120) || null,
      season: int(n.season, 0, 999),
      episode: int(n.episode, 0, 9999),
      poster: pic(n.poster),
      backdrop: pic(n.backdrop),
      duration: num(n.duration, 0, 24 * 3600) || 0,
      position: num(n.position, 0, 24 * 3600) || 0,
      paused: bool(n.paused),
      buffering: bool(n.buffering),
      canSeek: n.canSeek !== false,
      hasNext: bool(n.hasNext),
      nextLabel: tidy(n.nextLabel, 80) || null,
      subs: trackList(n.subs, 40),
      sub: n.sub == null ? null : tidy(n.sub, 160),
      audios: trackList(n.audios, 16),
      audio: n.audio == null ? null : tidy(n.audio, 160),
      subDelay: num(n.subDelay, -600, 600) || 0,
    };
  }
  const v = s.volume;
  if (v && typeof v === "object") {
    out.volume = {
      supported: bool(v.supported),
      level: num(v.level, 0, 1),
      muted: bool(v.muted),
      // where the level lives: the TV's own volume ("system") or only this
      // player's ("player") — the remote says which
      scope: v.scope === "system" ? "system" : "player",
    };
  }
  try {
    if (JSON.stringify(out).length > STATE_MAX_JSON) { out.now && (out.now.subs = out.now.subs.slice(0, 8)); }
  } catch {}
  return out;
};

// The part of a state whose change every remote hears about (not the position).
const coarse = (s) => {
  if (!s) return "";
  const n = s.now;
  return JSON.stringify([
    s.screen, s.appState,
    n ? [n.id, n.paused, n.buffering, n.hasNext, n.sub, n.audio, n.subs.length, n.audios.length, Math.round(n.duration), n.subDelay] : null,
    s.volume ? [s.volume.supported, s.volume.muted, s.volume.level == null ? null : Math.round(s.volume.level * 20)] : null,
  ]);
};

const cleanCaps = (c) => ({
  navigate: !!(c && c.navigate),
  volume: !!(c && c.volume),
  playItem: c ? c.playItem !== false : true,
  tracks: c ? c.tracks !== false : true,
});

// The arguments each command takes, typed and bounded. null = refused.
const cleanItem = (it) => {
  if (!it || typeof it !== "object" || typeof it.id !== "string" || !it.id || it.id.length > 300) return null;
  return {
    id: it.id.slice(0, 300),
    title: tidy(it.title, 120),
    showTitle: tidy(it.showTitle, 120) || null,
    epTitle: tidy(it.epTitle, 120) || null,
    season: int(it.season, 0, 999),
    episode: int(it.episode, 0, 9999),
    type: it.type === "show" ? "show" : it.type === "movie" ? "movie" : null,
    imdbId: /^tt\d{5,10}$/.test(String(it.imdbId || "")) ? it.imdbId : null,
    poster: pic(it.poster),
    duration: num(it.duration, 0, 24 * 3600),
  };
};
const COMMANDS = {
  play_item: (a) => {
    const item = cleanItem(a && a.item);
    if (!item) return null;
    const lang = (v) => (v === "off" ? "off" : /^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(String(v || "")) ? String(v) : null);
    return {
      item,
      position: num(a.position, 0, 24 * 3600),
      restart: bool(a.restart),
      subLang: lang(a.subLang),
      audioLang: lang(a.audioLang) === "off" ? null : lang(a.audioLang),
    };
  },
  play: () => ({}),
  pause: () => ({}),
  toggle: () => ({}),
  stop: () => ({}),
  next: () => ({}),
  seek: (a) => { const to = num(a && a.to, 0, 24 * 3600); return to == null ? null : { to }; },
  skip: (a) => { const by = num(a && a.by, -3600, 3600); return by == null || by === 0 ? null : { by }; },
  sub: (a) => (a && (a.id === null || a.id === "off") ? { id: null } : a && typeof a.id === "string" && a.id ? { id: a.id.slice(0, 160) } : null),
  audio: (a) => (a && typeof a.id === "string" && a.id ? { id: a.id.slice(0, 160) } : null),
  sub_delay: (a) => {
    const value = num(a && a.value, -600, 600);
    const by = num(a && a.by, -60, 60);
    return value != null ? { value } : by != null && by !== 0 ? { by } : null;
  },
  volume: (a) => {
    const level = num(a && a.level, 0, 1);
    const step = a && (a.step === 1 || a.step === -1) ? a.step : null;
    return level != null ? { level } : step != null ? { step } : null;
  },
  mute: (a) => ({ on: a ? a.on !== false : true }),
  key: (a) => (a && KEYS.has(a.key) ? { key: a.key } : null),
  rename: (a) => { const name = tidy(a && a.name, 40); return name ? { name } : null; },
};

const firstOf = (t) => (t.clientIds.length ? t.clientIds[t.clientIds.length - 1] : null);

// May the remote on `ctl` control target `t`? (both proven; see the header)
const mayControl = (ctl, t) => {
  if (!ctl || !t || !ctl.profileId || !t.profileId) return false;
  if (ctl.clientId && t.clientIds.includes(ctl.clientId)) return false; // not yourself
  if (ctl.ownDeviceId && ctl.ownDeviceId === t.deviceId) return false;
  if (ctl.profileId === t.profileId) return true;
  const me = deps.profile(ctl.profileId);
  if (!me || me.kids) return false;
  return !!deps.household();
};

const publicDevice = (t, ctl) => {
  const p = deps.profile(t.profileId) || { id: t.profileId, name: "Someone", avatar: null };
  return {
    deviceId: t.deviceId,
    name: t.name,
    kind: t.kind,
    form: t.form,
    model: t.model,
    profile: { id: p.id, name: p.name, avatar: p.avatar || null, avatarImage: p.avatarImage || null },
    mine: !!ctl && ctl.profileId === t.profileId,
    caps: t.caps,
    state: t.state,
    since: t.since,
    stateAt: t.stateAt,
  };
};

const listFor = (ctl) => {
  const out = [];
  for (const t of targets.values()) if (mayControl(ctl, t)) out.push(publicDevice(t, ctl));
  // mine first, then TVs, then by name
  out.sort((a, b) => (b.mine - a.mine) || ((a.kind === "tv" ? 0 : 1) - (b.kind === "tv" ? 0 : 1)) || a.name.localeCompare(b.name));
  return out;
};

const sendList = (ctl) => deps.send(ctl.clientId, { type: "remote_devices", devices: listFor(ctl), household: !!deps.household(), now: deps.now() });
const sendLists = () => { for (const c of controllers.values()) sendList(c); };

const watchers = (deviceId) => {
  let n = 0;
  for (const c of controllers.values()) if (c.watch === deviceId) n++;
  return n;
};
// tell a target whether a remote screen is open on it (only on a change)
const syncWatch = (deviceId) => {
  const t = targets.get(deviceId);
  if (!t) return;
  const on = watchers(deviceId) > 0;
  if (on === t.watched) return;
  t.watched = on;
  const cid = firstOf(t);
  if (cid) deps.send(cid, { type: "remote_watch", on });
};

// ---------------------------------------------------------------- targets

const announce = (client, msg) => {
  const m = msg || {};
  const deviceId = String(m.deviceId || "");
  if (!ID_RE.test(deviceId)) return { error: "bad-device-id" };
  const kind = KINDS.has(m.kind) ? m.kind : null;
  if (!kind) return { error: "bad-kind" };
  const profileId = deps.prove(client, String(m.profileId || "").slice(0, 40), typeof m.token === "string" ? m.token.slice(0, 200) : null);
  if (!profileId) return { error: "not-signed-in" };
  // a socket announces ONE device: another id from the same socket replaces it
  const had = targetOf.get(client.id);
  if (had && had !== deviceId) leaveTarget(client.id, { quiet: true });
  let t = targets.get(deviceId);
  if (t && t.profileId !== profileId) {
    // the same box, signed in to another profile now: it is that profile's
    // device from here on — whoever had it loses it
    for (const cid of t.clientIds) if (cid !== client.id) targetOf.delete(cid);
    t.clientIds = [];
    t.state = cleanState(null);
    t.firstFrom = new Set();
  }
  if (!t) {
    let mine = 0;
    for (const o of targets.values()) if (o.profileId === profileId) mine++;
    if (mine >= MAX_TARGETS_PER_PROFILE) return { error: "too-many-devices" };
    t = { deviceId, clientIds: [], profileId, since: deps.now(), state: cleanState(null), coarse: "", stateAt: 0, watched: false, firstFrom: new Set() };
    targets.set(deviceId, t);
  }
  t.profileId = profileId;
  t.kind = kind;
  t.form = FORMS.has(m.form) ? m.form : kind === "tv" ? "tv" : "computer";
  t.name = tidy(m.name, 40) || (kind === "tv" ? "Living room TV" : "This computer");
  t.model = tidy(m.model, 60) || null;
  t.caps = cleanCaps(m.caps);
  t.clientIds = t.clientIds.filter((c) => c !== client.id);
  t.clientIds.push(client.id);
  targetOf.set(client.id, deviceId);
  if (m.state) {
    t.state = cleanState(m.state);
    t.coarse = coarse(t.state);
    t.stateAt = deps.now();
  }
  t.watched = null; // force the next syncWatch to say it to this socket
  counters.announced++;
  sendLists();
  syncWatch(deviceId);
  if (t.watched === null) { t.watched = false; }
  return { device: { deviceId, name: t.name } };
};

// `quiet`: the caller sends the lists itself
const leaveTarget = (clientId, { quiet = false } = {}) => {
  const deviceId = targetOf.get(clientId);
  if (!deviceId) return false;
  targetOf.delete(clientId);
  const t = targets.get(deviceId);
  if (!t) return false;
  t.clientIds = t.clientIds.filter((c) => c !== clientId);
  if (!t.clientIds.length) {
    targets.delete(deviceId);
    // what was waiting for an answer from it gets one now
    for (const [ref, p] of pending) {
      if (p.deviceId !== deviceId) continue;
      finish(ref, { ok: false, error: "gone", message: `${t.name} went away` });
    }
  } else {
    // the tab underneath answers from now on: it is told whether it is watched
    t.watched = null;
    syncWatch(deviceId);
    if (t.watched === null) t.watched = false;
  }
  if (!quiet) sendLists();
  return true;
};

const stateFrom = (client, s) => {
  const deviceId = targetOf.get(client.id);
  const t = deviceId && targets.get(deviceId);
  if (!t) return false;
  if (firstOf(t) !== client.id) return false; // an older tab of the same browser: not the one answering
  t.state = cleanState(s);
  t.stateAt = deps.now();
  const k = coarse(t.state);
  const changed = k !== t.coarse;
  t.coarse = k;
  for (const c of controllers.values()) {
    if (!(c.watch === deviceId || changed)) continue;
    if (!mayControl(c, t)) continue;
    deps.send(c.clientId, { type: "device_state", deviceId, state: t.state, at: t.stateAt });
  }
  return true;
};

// ---------------------------------------------------------------- controllers

const controllerLabel = (client, hint) => {
  const p = client.profile || null;
  const word = LABELS.has(hint) ? hint : (() => {
    const d = client.device || {};
    if (d.os === "iOS") return "iPhone";
    if (d.os === "Android") return d.device === "Mobile" ? "Android phone" : "Android tablet";
    if (d.os === "macOS") return "Mac";
    if (d.os === "Windows") return "PC";
    if (d.device === "TV") return "TV";
    return "phone";
  })();
  return { word, profileName: p };
};

const subscribe = (client, msg) => {
  const m = msg || {};
  const profileId = deps.prove(client, String(m.profileId || "").slice(0, 40), typeof m.token === "string" ? m.token.slice(0, 200) : null);
  if (!profileId) {
    unsubscribe(client.id);
    deps.send(client.id, { type: "remote_devices", devices: [], household: !!deps.household(), error: "not-signed-in", now: deps.now() });
    return { error: "not-signed-in" };
  }
  let c = controllers.get(client.id);
  const oldWatch = c ? c.watch : null;
  if (!c) {
    c = { clientId: client.id, bucket: { tokens: CMD_BURST, at: deps.now() } };
    controllers.set(client.id, c);
  }
  c.profileId = profileId;
  c.ownDeviceId = ID_RE.test(String(m.ownDeviceId || "")) ? m.ownDeviceId : null;
  // the remote's own id, kept across its reconnects (the browser's device id)
  c.remoteId = ID_RE.test(String(m.remoteId || "")) ? m.remoteId : c.ownDeviceId;
  c.watch = typeof m.watch === "string" && ID_RE.test(m.watch) ? m.watch : null;
  const prof = deps.profile(profileId);
  c.label = controllerLabel({ ...client, profile: prof ? prof.name : client.profile }, m.label);
  sendList(c);
  if (oldWatch && oldWatch !== c.watch) syncWatch(oldWatch);
  if (c.watch) syncWatch(c.watch);
  return { ok: true };
};

const unsubscribe = (clientId) => {
  const c = controllers.get(clientId);
  if (!c) return false;
  controllers.delete(clientId);
  if (c.watch) syncWatch(c.watch);
  return true;
};

const takeToken = (c) => {
  const now = deps.now();
  const b = c.bucket;
  b.tokens = Math.min(CMD_BURST, b.tokens + ((now - b.at) / 1000) * CMD_RATE);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
};

const refuse = (client, id, deviceId, error, message) => {
  counters.refused++;
  deps.send(client.id, { type: "remote_ack", id, deviceId, ok: false, error, message });
  return { error };
};

const command = (client, msg) => {
  const m = msg || {};
  const id = tidy(m.id, 32) || null;
  const deviceId = String(m.deviceId || "");
  const c = controllers.get(client.id);
  if (!c) return refuse(client, id, deviceId, "not-subscribed", "Open the remote first");
  // proven again: the profile or the household switch may have changed
  const t = targets.get(deviceId);
  if (!t || !t.clientIds.length) return refuse(client, id, deviceId, "gone", "That device is not connected");
  if (!mayControl(c, t)) return refuse(client, id, deviceId, "not-allowed", "This profile can't control that device");
  const clean = Object.prototype.hasOwnProperty.call(COMMANDS, m.cmd) ? COMMANDS[m.cmd](m.args || {}) : null;
  if (!clean) return refuse(client, id, deviceId, "bad-command", "That command isn't known");
  if (m.cmd === "key" && !t.caps.navigate) return refuse(client, id, deviceId, "unsupported", `${t.name} can't be steered with arrows`);
  if (m.cmd === "play_item" && !t.caps.playItem) return refuse(client, id, deviceId, "unsupported", `${t.name} can't open titles`);
  const mode = deps.mode();
  if (mode !== "off" && !takeToken(c)) {
    counters.rateLimited++;
    if (mode === "enforce") return refuse(client, id, deviceId, "slow-down", "Too many presses at once — slow down a little");
  }
  let mine = 0;
  for (const p of pending.values()) if (p.deviceId === deviceId) mine++;
  if (mine >= MAX_PENDING_PER_TARGET) return refuse(client, id, deviceId, "busy", `${t.name} is busy — try again`);
  const ref = `r${(++refSeq).toString(36)}`;
  const timer = deps.setTimeout(() => {
    counters.timeouts++;
    finish(ref, { ok: false, error: "timeout", message: `${t.name} didn't answer` });
  }, ACK_MS);
  if (timer && timer.unref) timer.unref();
  pending.set(ref, { controllerId: client.id, id, deviceId, timer, at: deps.now(), cmd: m.cmd });
  const first = !t.firstFrom.has(client.id);
  t.firstFrom.add(client.id);
  counters.commands++;
  const sent = deps.send(firstOf(t), {
    type: "remote_command",
    ref,
    cmd: m.cmd,
    args: clean,
    from: { label: c.label.word, profileName: c.label.profileName || null, ...(c.remoteId ? { id: c.remoteId } : {}) },
    first,
  });
  if (!sent) finish(ref, { ok: false, error: "gone", message: `${t.name} went away` });
  return { ref };
};

const finish = (ref, res) => {
  const p = pending.get(ref);
  if (!p) return false;
  pending.delete(ref);
  deps.clearTimeout(p.timer);
  deps.send(p.controllerId, {
    type: "remote_ack",
    id: p.id,
    deviceId: p.deviceId,
    ok: !!res.ok,
    ...(res.error ? { error: tidy(res.error, 32) } : {}),
    ...(res.message ? { message: tidy(res.message, 160) } : {}),
    ms: deps.now() - p.at,
  });
  return true;
};

// The target's answer. Only the socket the command went to may answer it.
const ack = (client, msg) => {
  const m = msg || {};
  const p = pending.get(String(m.ref || ""));
  if (!p) return false;
  const t = targets.get(p.deviceId);
  if (!t || !t.clientIds.includes(client.id)) return false;
  counters.acks++;
  return finish(String(m.ref), { ok: m.ok !== false, error: m.ok === false ? m.error || "failed" : null, message: m.message || null });
};

// A socket closed: whatever it was, it is not any more.
const dropClient = (clientId) => {
  const wasController = unsubscribe(clientId);
  const wasTarget = leaveTarget(clientId);
  // a remote that went away: its commands are answered to nobody
  for (const [ref, p] of pending) {
    if (p.controllerId !== clientId) continue;
    deps.clearTimeout(p.timer);
    pending.delete(ref);
  }
  return wasController || wasTarget;
};

// The household switch or a profile changed (a kids flag, a sign-out): every
// list is sent again, and watches that are no longer allowed are dropped.
const recheck = () => {
  for (const c of controllers.values()) {
    if (c.watch) {
      const t = targets.get(c.watch);
      if (t && !mayControl(c, t)) { c.watch = null; syncWatch(t.deviceId); }
    }
  }
  sendLists();
};

// A profile was signed out everywhere / locked: its targets and remotes stop.
const dropProfile = (profileId) => {
  for (const [cid, c] of controllers) if (c.profileId === profileId) { controllers.delete(cid); if (c.watch) syncWatch(c.watch); }
  for (const t of [...targets.values()]) if (t.profileId === profileId) for (const cid of [...t.clientIds]) leaveTarget(cid, { quiet: true });
  sendLists();
};

const status = () => ({
  targets: targets.size,
  controllers: controllers.size,
  pending: pending.size,
  ...counters,
});

const _reset = () => {
  for (const p of pending.values()) deps.clearTimeout(p.timer);
  targets.clear(); targetOf.clear(); controllers.clear(); pending.clear();
  for (const k of Object.keys(counters)) counters[k] = 0;
};

module.exports = {
  configure,
  announce,
  leaveTarget,
  stateFrom,
  subscribe,
  unsubscribe,
  command,
  ack,
  dropClient,
  recheck,
  dropProfile,
  status,
  listFor,
  mayControl,
  ACK_MS,
  CMD_RATE,
  CMD_BURST,
  _internals: { targets, targetOf, controllers, pending, cleanState, coarse, COMMANDS, cleanItem, controllerLabel, _reset, deps },
};
