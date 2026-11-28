#!/usr/bin/env node
// Streaming round 2 (TV): one measured play on the Mi TV, against a private
// tv-instance.js (--direct) reached through tv-local.sh (the TV's own
// 127.0.0.1:4000: films pushed to the TV answered from its storage — a fast
// source — everything else from the PC).
//
// What it measures, all on the TV's own clock (adb logcat -v epoch):
//   cold   the app force-stopped, the title opened by its deep link: from the
//          launcher's START line to the player's first frame
//   warm   the app up (Home), the title sent by the phone-remote protocol
//          (play_item, as "Play on TV" does): the player's own mount ->
//          first frame (the TV's press is the player's mount)
//   seeks  sent as remote `seek` commands at given moments: from the moment
//          the TV received the command, and from the player's commit (after
//          its 450 ms debounce), to the end of the buffering that follows
//   stalls every buffering on/off after the first frame (short ones too)
//   resume where the first frame landed against where it was sent
//   blips  `relay-off` / `freeze` moments (tv-local.sh's relay stopped, or its
//          film readers paused with SIGSTOP), and the time to moving again
//
//   node tools/stream-net-rig/tv-rig2.js --log <tv-instance log> --label base \
//        --title thevc --mode cold|warm [--at 0] [--watch 40] \
//        [--seek 15:+10,25:600]   (at 15 s after the first frame: +10 s; at 25 s: to 600 s)
//        [--blip 20:freeze:15]    (20 s in: freeze the film's readers 15 s; or relay-off)
//        [--source local|pc]      (only labels the row: which source carried the film)
//
// Every adb call has a timeout; the app is only force-stopped and started.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const DEV = arg("device", "192.168.50.31:5555");
const LOG = arg("log");
const PORT = Number(arg("port", 47400));
const TITLE = arg("title", "thevc");
const MODE = arg("mode", "warm");
const AT = Number(arg("at", 0));
const WATCH = Number(arg("watch", 40));
const LABEL = arg("label", "tv2");
const SOURCE = arg("source", "local");
const SEEKS = (arg("seek", "") || "").split(",").filter(Boolean).map((s) => {
  const [after, to] = s.split(":");
  return { after: Number(after), rel: /^[+-]/.test(to), to: Number(to) };
});
const BLIPS = (arg("blip", "") || "").split(",").filter(Boolean).map((s) => {
  const [after, kind, secs] = s.split(":");
  return { after: Number(after), kind, secs: Number(secs) };
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
const adb = (...a) => execFileSync("adb", ["-s", DEV, ...a], { encoding: "utf8", timeout: 20000, env });

// ---------------------------------------------------------------- logcat
const lines = [];
const startLogcat = () => {
  try { adb("logcat", "-c"); } catch {}
  const p = spawn("adb", ["-s", DEV, "logcat", "-v", "epoch", "ReactNativeJS:I", "ActivityTaskManager:I", "*:S"], { env });
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      const m = /^\s*(\d+\.\d+)\s+\d+\s+\d+\s+\w\s+(\S+)\s*:\s?(.*)$/.exec(l);
      if (m) lines.push({ t: Math.round(Number(m[1]) * 1000), tag: m[2], msg: m[3] });
    }
  });
  return p;
};
const find = (re, from = 0) => lines.find((l) => l.t >= from && re.test(l.msg));
const waitFor = async (re, ms, from = 0) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const l = find(re, from); if (l) return l; await sleep(150); }
  return null;
};
// the TV's clock now (logcat stamps are the TV's)
const tvNow = () => Math.round(Number(adb("shell", "date", "+%s.%N").trim()) * 1000) || Date.now();

// ---------------------------------------------------------------- remote protocol
const connect = (profileId) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  const st = { ws, devices: [], state: null, states: [], acks: new Map() };
  ws.onopen = () => ws.send(JSON.stringify({ type: "remote_subscribe", profileId, label: "PC" }));
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "remote_devices") { st.devices = m.devices || []; if (st.devices.length) resolve(st); }
    else if (m.type === "device_state") { st.state = m.state; st.states.push({ at: Date.now(), s: m.state }); }
    else if (m.type === "remote_ack") st.acks.set(m.id, m);
  };
  ws.onerror = (e) => reject(new Error("ws " + (e.message || "error")));
  setTimeout(() => reject(new Error("no TV in the device list (is the app up and signed in?)")), 20000);
});
let seq = 0;
const command = async (st, deviceId, cmd, args) => {
  const id = `c${++seq}`;
  st.ws.send(JSON.stringify({ type: "remote_command", id, deviceId, cmd, args }));
  for (let i = 0; i < 80; i++) { await sleep(100); if (st.acks.has(id)) return st.acks.get(id); }
  return { ok: false, error: "no-ack" };
};

// ---------------------------------------------------------------- the relay on the TV
const D = "/data/local/tmp/aurora-qa";
// the film readers tv-local-srv.sh runs (dd off the TV's storage)
const readerPids = () => adb("shell", `for p in $(pidof dd); do grep -q aurora-qa/media /proc/$p/cmdline 2>/dev/null && echo $p; done`).split(/\s+/).filter(Boolean);
const blip = async (b) => {
  if (b.kind === "freeze") {
    // the line goes silent without closing (a Wi-Fi drop, a router losing the flow)
    const pids = readerPids();
    if (pids.length) adb("shell", `kill -STOP ${pids.join(" ")}`);
    await sleep(b.secs * 1000);
    if (pids.length) adb("shell", `kill -CONT ${pids.join(" ")}`);
    return { pids: pids.length };
  }
  if (b.kind === "relay-off") {
    // the server goes away (a restart): new connections refused, open ones cut
    const relay = adb("shell", `cat ${D}/relay.pid`).trim();
    const pids = readerPids();
    adb("shell", `kill -STOP ${relay}; kill ${pids.join(" ")} 2>/dev/null; true`);
    await sleep(b.secs * 1000);
    adb("shell", `kill -CONT ${relay}`);
    return { pids: pids.length };
  }
  return {};
};

// ---------------------------------------------------------------- one play
const main = async () => {
  const logTxt = fs.readFileSync(LOG, "utf8");
  const items = JSON.parse(logTxt.split("\n").find((l) => l.startsWith("items ")).slice(6));
  const profile = /profile=(\w+)/.exec(logTxt.split("\n").find((l) => l.startsWith("ready ")))[1];
  // a title by its key, or any library item by `id:<item id>` (an episode)
  let it = items[TITLE];
  if (!it && TITLE.startsWith("id:")) {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/api/item/${TITLE.slice(3)}`)).json();
    it = { id: j.id, title: j.title, duration: j.duration, videoUrl: j.videoUrl, transcodeBase: j.transcodeBase, type: j.type };
  }
  if (!it) throw new Error(`no title ${TITLE} (have ${Object.keys(items)})`);
  const lc = startLogcat();
  await sleep(800);
  const row = { label: LABEL, at: new Date().toISOString(), title: TITLE, mode: MODE, source: SOURCE, resumeAt: AT, watchSec: WATCH };
  let st = null;
  let deviceId = null;
  let t0 = 0; // TV clock: the press (cold: the launcher's START; warm: the player's mount)
  if (MODE === "cold") {
    // the resume point as the profile's progress (the deep link opens where the profile stands)
    const CMD = arg("cmd");
    if (CMD) {
      const before = fs.readFileSync(LOG, "utf8").length;
      fs.appendFileSync(CMD, `progress ${TITLE} ${AT}
`);
      for (let i = 0; i < 40 && !/ok progress|err /.test(fs.readFileSync(LOG, "utf8").slice(before)); i++) await sleep(250);
    }
    adb("shell", "am", "force-stop", "com.auroratv");
    await sleep(1500);
    const link = `aurora://open?a=play&d=${encodeURIComponent(JSON.stringify({ id: it.id, title: it.title, type: "movie", videoUrl: it.videoUrl, transcodeBase: it.transcodeBase, inLibrary: true }))}`;
    const from = tvNow();
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${link}'`, "com.auroratv");
    const start = await waitFor(/START u0 .*com\.auroratv/, 8000, from - 2000);
    t0 = start ? start.t : from;
  } else {
    // the app on its feet first (Home), then the title sent like Play on TV
    const top = adb("shell", "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity' | head -1");
    if (!/com\.auroratv/.test(top)) { adb("shell", "am", "start", "-n", "com.auroratv/.MainActivity"); await sleep(9000); }
  }
  try { st = await connect(profile); } catch (e) { row.error = e.message; }
  const tv = st && st.devices.find((d) => d.kind === "tv");
  deviceId = tv ? tv.deviceId : null;
  if (st && deviceId) st.ws.send(JSON.stringify({ type: "remote_subscribe", profileId: profile, label: "PC", watch: deviceId }));
  if (MODE === "warm") {
    if (!deviceId) throw new Error(row.error || "no TV");
    const from = tvNow();
    const ack = await command(st, deviceId, "play_item", { item: { id: it.id, title: it.title, type: "movie", duration: it.duration }, position: AT || null, restart: !AT });
    row.ack = ack.ok ? "ok" : ack.error;
    const mount = await waitFor(/\[player\] first frame \+\d+ms/, 60000, from);
    t0 = mount ? mount.t - Number(/\+(\d+)ms/.exec(mount.msg)[1]) : from;
  }
  const ff = await waitFor(/\[player\] first frame \+\d+ms/, 60000, t0 - 1000);
  row.firstFrameMs = ff ? ff.t - t0 : null;
  row.mountToFrameMs = ff ? Number(/\+(\d+)ms/.exec(ff.msg)[1]) : null;
  row.coldBootMs = MODE === "cold" && ff ? row.firstFrameMs - row.mountToFrameMs : null;
  // where the picture started: the device's next state, else the ready line
  if (ff) {
    const pcFF = Date.now();
    await sleep(1500);
    const s = st && st.states.find((x) => x.at >= pcFF && x.s && x.s.now && x.s.now.position > 0);
    row.startPos = s ? Math.round(s.s.now.position * 10) / 10 : null;
    const rd = find(/\[player\] ready at /, t0);
    row.readyAt = rd ? Number(/ready at ([\d.]+)/.exec(rd.msg)[1]) : null;
  }
  // the watch: seeks and blips at their moments after the first frame
  const tFF = ff ? ff.t : tvNow();
  const events = [...SEEKS.map((s) => ({ ...s, type: "seek" })), ...BLIPS.map((b) => ({ ...b, type: "blip" }))].sort((a, b) => a.after - b.after);
  const t0pc = Date.now();
  row.seeks = [];
  row.blips = [];
  for (const e of events) {
    const wait = e.after * 1000 - (Date.now() - t0pc);
    if (wait > 0) await sleep(wait);
    if (e.type === "seek" && deviceId) {
      const pos = st.state && st.state.now ? st.state.now.position : null;
      const to = e.rel ? (pos || 0) + e.to : e.to;
      const sent = tvNow();
      await command(st, deviceId, "seek", { to });
      row.seeks.push({ sent, to: Math.round(to), from: pos });
    } else if (e.type === "blip") {
      const from = tvNow();
      const r = await blip(e);
      row.blips.push({ kind: e.kind, secs: e.secs, from, until: tvNow(), ...r });
    }
  }
  const rest = WATCH * 1000 - (Date.now() - t0pc);
  if (rest > 0) await sleep(rest);
  const tEnd = tvNow();
  // ---- read it back
  const after = lines.filter((l) => l.t >= tFF && l.t <= tEnd + 500);
  const buf = after.filter((l) => /\[player\] buffering (on|off)/.test(l.msg)).map((l) => ({ t: l.t, on: / on /.test(l.msg + " ") || /buffering on/.test(l.msg), at: Number((/at ([\d.]+)/.exec(l.msg) || [])[1]) }));
  // pair them: each on -> the next off
  const waits = [];
  let on = null;
  for (const b of buf) { if (b.on && on == null) on = b; else if (!b.on && on) { waits.push({ t: on.t, ms: b.t - on.t, at: on.at }); on = null; } }
  if (on) waits.push({ t: on.t, ms: tEnd - on.t, at: on.at, open: true });
  // a wait that follows a seek (within 3 s of its commit) is the seek's
  const commits = after.filter((l) => /\[player\] seek /.test(l.msg)).map((l) => ({ t: l.t, to: Number((/-> ([\d.]+)/.exec(l.msg) || [])[1]) }));
  for (const s of row.seeks) {
    const c = commits.find((x) => x.t >= s.sent - 200 && Math.abs(x.to - s.to) < 2);
    const w = c ? waits.find((x) => x.t >= c.t - 100 && x.t <= c.t + 3000) : null;
    s.commitMs = c ? c.t - s.sent : null;
    s.pictureMs = w ? w.t + w.ms - s.sent : c ? 0 : null; // no wait at all: the picture was there
    s.fromCommitMs = w && c ? w.t + w.ms - c.t : null;
    if (w) w.seek = true;
  }
  const blipWaits = (b) => waits.filter((w) => w.t >= b.from - 500 && w.t <= b.until + 60000);
  for (const b of row.blips) {
    const ws = blipWaits(b);
    for (const w of ws) w.blip = true;
    const moving = lines.find((l) => l.t >= b.from && /\[player\] moving again/.test(l.msg));
    b.stalledMs = ws.reduce((s, w) => s + w.ms, 0);
    b.backAfterMs = ws.length ? ws[ws.length - 1].t + ws[ws.length - 1].ms - b.from : 0;
    b.watcher = after.filter((l) => l.t >= b.from && /the same source again|stall-|the card/.test(l.msg)).map((l) => l.msg).slice(0, 6);
    b.moving = !!moving;
  }
  // the next episode (Up next): the second first frame of the play, and what it took
  const ffs = lines.filter((l) => l.t >= t0 && /\[player\] first frame \+\d+ms/.test(l.msg));
  if (ffs.length > 1) {
    const n = ffs[1];
    row.next = { mountToFrameMs: Number(/\+(\d+)ms/.exec(n.msg)[1]), meta: Number((/meta=(\d+)/.exec(n.msg) || [])[1]), armed: Number((/armed=(\d+)/.exec(n.msg) || [])[1]) };
  }
  const stalls = waits.filter((w) => !w.seek && !w.blip);
  row.stalls = stalls.length;
  row.stallMs = stalls.reduce((s, w) => s + w.ms, 0);
  row.longestStallMs = stalls.reduce((m, w) => Math.max(m, w.ms), 0);
  row.watchedMs = tEnd - tFF;
  row.rebufferRatio = row.watchedMs > 0 ? Math.round((row.stallMs / row.watchedMs) * 10000) / 10000 : null;
  const last = st && st.state && st.state.now;
  row.endPos = last ? Math.round(last.position) : null;
  row.endBuffering = last ? !!last.buffering : null;
  row.states = st ? st.states.length : 0;
  row.stateSample = st && st.states[0] ? JSON.stringify(st.states[0].s).slice(0, 300) : null;
  row.log = after.filter((l) => /\[player\]|\[av\]|\[remote\]/.test(l.msg)).slice(0, 60).map((l) => `${l.t - t0} ${l.msg}`);
  fs.mkdirSync(path.join(__dirname, ".runs"), { recursive: true });
  fs.appendFileSync(path.join(__dirname, ".runs", `${LABEL}.jsonl`), JSON.stringify(row) + "\n");
  const sk = row.seeks.map((s) => `${s.to}:${s.pictureMs}ms(c${s.commitMs})`).join(" ");
  const bl = row.blips.map((b) => `${b.kind}${b.secs}:stalled ${b.stalledMs}ms back ${b.backAfterMs}ms`).join(" ");
  if (row.next) console.log(`  next episode: mount->frame ${row.next.mountToFrameMs} ms (meta ${row.next.meta}, armed ${row.next.armed})`);
  console.log(`  ${MODE} ${TITLE} @${AT}: first frame ${row.firstFrameMs} ms (mount->frame ${row.mountToFrameMs}), start ${row.startPos}, stalls ${row.stalls}/${row.stallMs} ms${sk ? ", seeks " + sk : ""}${bl ? ", " + bl : ""}`);
  lc.kill();
  if (st) st.ws.close();
  process.exit(0);
};
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
