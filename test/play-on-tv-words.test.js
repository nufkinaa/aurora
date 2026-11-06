// "Play on TV" / "Continue on this phone" say the same words on the website
// and in the phone app (parity): public/js/playOnWords.js and
// tv-native/src/remote/playOnWords.ts are each LOADED and run on the same
// inputs, and every sentence must come out identical. (The TS file is
// stripped of its types by esbuild, the optional dependency the server uses
// for the website's JavaScript; without it the test says why it skipped.)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "public", "js", "playOnWords.js");
const APP = path.join(ROOT, "tv-native", "src", "remote", "playOnWords.ts");

let esbuild = null;
try { esbuild = require("esbuild"); } catch {}

const load = async (file, code) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playon-words-"));
  const out = path.join(dir, path.basename(file).replace(/\.ts$/, ".mjs").replace(/\.js$/, ".mjs"));
  fs.writeFileSync(out, code);
  try { return await import(pathToFileURL(out).href); } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
};

test("Play on TV: the website and the phone app say every sentence the same", { skip: !esbuild && "esbuild (optional dependency) is not installed" }, async () => {
  const web = await load(WEB, fs.readFileSync(WEB, "utf8"));
  const appTs = fs.readFileSync(APP, "utf8");
  assert.ok(!/^import /m.test(appTs), "the phone's words file imports nothing");
  const app = await load(APP, esbuild.transformSync(appTs, { loader: "ts", format: "esm" }).code);

  const keys = Object.keys(web.PLAY_ON).sort();
  assert.deepEqual(Object.keys(app.PLAY_ON).sort(), keys, "the same sentences on both");
  const ARGS = [["Living room TV", "Arrival"], ["Bedroom TV", ""], ["", "Silo · S1 E3"], []];
  for (const k of keys) {
    const w = web.PLAY_ON[k];
    const a = app.PLAY_ON[k];
    assert.equal(typeof a, typeof w, k);
    if (typeof w === "string") assert.equal(a, w, k);
    else for (const args of ARGS) assert.equal(a(...args), w(...args), `${k}(${args.join(", ")})`);
  }
  const RESULTS = [
    { ok: true, status: "playing" }, { ok: true }, { ok: true, status: "needs-pin" }, { ok: true, status: "needs-password" },
    { ok: false, error: "timeout", message: "No answer — is it still on?" }, { ok: false, error: "superseded" },
    { ok: false, error: "not-allowed", message: "This profile can't control that device" }, { ok: false }, null,
  ];
  for (const r of RESULTS) assert.equal(app.playOnResult(r, "Living room TV", "Arrival"), web.playOnResult(r, "Living room TV", "Arrival"), JSON.stringify(r));
  for (const it of [{ title: "Arrival" }, { title: "Pilot", showTitle: "Silo", season: 1, episode: 3 }, { showTitle: "Silo" }, null]) {
    assert.equal(app.playOnTitle(it), web.playOnTitle(it), JSON.stringify(it));
  }
  // the words the brief asked for, exactly
  assert.equal(web.PLAY_ON.playing("Living room TV"), "Playing on Living room TV");
  assert.equal(web.playOnResult({ ok: false, error: "timeout" }, "Living room TV"), "Living room TV didn't answer");
  assert.equal(web.PLAY_ON.continueHere("phone"), "Continue on this phone");
});

test("the server's own answer for a silent TV reads the same as the senders' (devices.js)", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "lib", "devices.js"), "utf8");
  assert.ok(src.includes("message: `${t.name} didn't answer`"), "devices.js: <TV> didn't answer");
  assert.ok(src.includes("`Something else was just started on ${t.name}`"), "devices.js: superseded");
});
