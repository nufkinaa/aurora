#!/usr/bin/env node
// One play on the Mi TV against tv-instance.js (REPORT.md "Built", item 7):
// sets the server's tvPlayer tuning and line, the resume point, opens the
// title with the app's own deep link (aurora://open?a=play), watches, then
// reads the play's marks from the server: first frame (and the start buffer
// the app says it used), every stall and how long it lasted.
//
//   node tools/stream-net-rig/tv-play.js --cmd <tv-instance cmd file> --log <its log>
//        --title mp4 --at 390 --down 4000 --lat 35 --start 1000 --rebuffer 5000 --watch 120 --label x
//
// Every adb call is wrapped in a timeout; the app is only ever force-stopped and
// started (no power keys, no other app). Rows go to .runs/<label>.jsonl.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const DEV = arg("device", "192.168.50.31:5555");
const CMD = arg("cmd");
const LOG = arg("log");
const TITLE = arg("title", "mp4");
const AT = Number(arg("at", 0));
const DOWN = Number(arg("down", 4000));
const LAT = Number(arg("lat", 35));
const START = Number(arg("start", 1000));
const REBUF = Number(arg("rebuffer", 5000));
const WATCH = Number(arg("watch", 120));
const LABEL = arg("label", "tv");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync("adb", ["-s", DEV, ...a], { encoding: "utf8", timeout: 20000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });

const send = async (line, want) => {
  const before = fs.readFileSync(LOG, "utf8").length;
  fs.appendFileSync(CMD, line + "\n");
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const add = fs.readFileSync(LOG, "utf8").slice(before);
    const m = add.split("\n").find((l) => l.startsWith(want) || l.startsWith("err"));
    if (m) { if (m.startsWith("err")) throw new Error(m); return m; }
  }
  throw new Error(`no answer to ${line}`);
};

const main = async () => {
  const items = JSON.parse(fs.readFileSync(LOG, "utf8").split("\n").find((l) => l.startsWith("items ")).slice(6));
  const it = items[TITLE];
  await send(`tuning ${JSON.stringify({ startBufferMs: START, rebufferMs: REBUF })}`, "ok tuning");
  await send(`line ${DOWN} ${LAT}`, "ok");
  await send(`progress ${TITLE} ${AT}`, "ok progress");
  await send("marks", "marks"); // (forget what came before)
  await sleep(2500); // the tuning file is read every 2 s
  adb("shell", "am", "force-stop", "com.auroratv");
  await sleep(1500);
  const link = `aurora://open?a=play&d=${encodeURIComponent(JSON.stringify({ id: it.id, title: it.title, type: "movie", videoUrl: it.videoUrl, transcodeBase: it.transcodeBase, inLibrary: true }))}`;
  const t0 = Date.now();
  adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${link}'`, "com.auroratv");
  await sleep(WATCH * 1000);
  const marksLine = await send("marks", "marks");
  const marks = JSON.parse(marksLine.slice(6));
  try { adb("shell", "screencap", "-p", "/sdcard/qa-tv-play.png"); } catch {}
  adb("shell", "am", "force-stop", "com.auroratv");
  const ff = marks.find((l) => / first-frame /.test(l));
  const ffMs = ff ? Number((/\+(\d+)ms/.exec(ff) || [])[1]) : null;
  const buf = ff ? Number((/ buf=(\d+)/.exec(ff) || [])[1]) : null;
  const stalls = marks.filter((l) => / stall-end /.test(l)).map((l) => ({ at: Number((/ at=(\d+)/.exec(l) || [])[1]), ms: Number((/ lasted=(\d+)/.exec(l) || [])[1]), plusMs: Number((/\+(\d+)ms/.exec(l) || [])[1]) }));
  const stallStarts = marks.filter((l) => / stall /.test(l) && !/stall-end/.test(l)).length;
  const firstMin = stalls.filter((s) => ffMs != null && s.plusMs - s.ms <= ffMs + 60000);
  const row = {
    label: LABEL, at: new Date().toISOString(), title: TITLE, resumeAt: AT, down: DOWN, rttMs: LAT * 2, startBufferMs: START, rebufferMs: REBUF, watchSec: WATCH,
    firstFrameMs: ffMs, bufSeen: buf, stalls: stalls.length, stallMarks: stallStarts, stallMs: stalls.reduce((s, x) => s + x.ms, 0),
    stallsFirstMinute: firstMin.length, stallMsFirstMinute: firstMin.reduce((s, x) => s + x.ms, 0),
    encodeStarts: marks.filter((l) => /^\[rig-encode\]/.test(l)).length, marks: marks.slice(0, 40), wallSec: Math.round((Date.now() - t0) / 1000),
  };
  fs.mkdirSync(path.join(__dirname, ".runs"), { recursive: true });
  fs.appendFileSync(path.join(__dirname, ".runs", `${LABEL}.jsonl`), JSON.stringify(row) + "\n");
  console.log(`  ${TITLE} at ${AT} ${DOWN}k start ${START}: first frame ${ffMs} ms (buf ${buf}), stalls ${row.stalls} / ${(row.stallMs / 1000).toFixed(1)} s (first minute ${row.stallsFirstMinute} / ${(row.stallMsFirstMinute / 1000).toFixed(1)} s), encodes ${row.encodeStarts}`);
};
main().catch((e) => { console.error(e.message); process.exit(1); });
