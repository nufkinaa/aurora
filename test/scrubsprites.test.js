// The progress bar's preview pictures (media/scrubsprites.js): the plan, the
// index arithmetic every client copies, and one real ffmpeg run on a made-up
// film whose colour changes every ten seconds — so "the picture at second t"
// is checked by its colour, not by trusting the filter.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const config = require("../src/config");
const sprites = require("../src/media/scrubsprites");
const { planFor, tileAt, argsFor, cpuMsOf, jpegSize, parseQuiet, inQuiet, keyOf, deps } = sprites._internals;

test("plan: one picture every 10 s, 100 to a sheet; a very long file gets a wider step, never more sheets", () => {
  assert.equal(planFor(0), null);
  assert.equal(planFor(NaN), null);
  assert.deepEqual(planFor(3113.8), { interval: 10, cols: 10, rows: 10, per: 100, count: 312, sheets: 4 });
  assert.deepEqual(planFor(55), { interval: 10, cols: 10, rows: 10, per: 100, count: 6, sheets: 1 });
  assert.equal(planFor(5).count, 1);
  const long = planFor(5 * 3600); // five hours
  assert.equal(long.interval, 15);
  assert.ok(long.count <= 1200 && long.sheets <= 12);
});

test("tileAt: the nearest picture, its sheet and its place on the sheet", () => {
  const idx = { count: 312, interval: 10, w: 240, h: 120, cols: 10, rows: 10 };
  assert.deepEqual(tileAt(idx, 0), { i: 0, sheet: 0, x: 0, y: 0, w: 240, h: 120 });
  assert.deepEqual(tileAt(idx, 14.9), { i: 1, sheet: 0, x: 240, y: 0, w: 240, h: 120 });
  assert.deepEqual(tileAt(idx, 15), { i: 2, sheet: 0, x: 480, y: 0, w: 240, h: 120 });
  assert.deepEqual(tileAt(idx, 1234), { i: 123, sheet: 1, x: 3 * 240, y: 2 * 120, w: 240, h: 120 });
  // past the end and before the start: the last / first picture
  assert.equal(tileAt(idx, 99999).i, 311);
  assert.equal(tileAt(idx, 99999).sheet, 3);
  assert.equal(tileAt(idx, -5).i, 0);
  assert.equal(tileAt(null, 5), null);
  assert.equal(tileAt({ ...idx, count: 0 }, 5), null);
});

test("the ffmpeg run: key frames only, one input read, low on threads, the chain tiles", () => {
  const a = argsFor("/m/film.mkv", "/out", planFor(600), { threads: 1 });
  const s = a.join(" ");
  assert.match(s, /-skip_frame nokey -i \/m\/film\.mkv/);
  assert.match(s, /-threads 1 /);
  assert.match(s, /-vf fps=1\/10:eof_action=pass,scale=240:-2:flags=bilinear,tile=10x10 /);
  assert.match(s, /-an -sn -dn/);
  assert.equal(a[a.length - 1], path.join("/out", "%d.jpg"));
  // an HDR source's tone-map chain replaces the plain scale
  const hdr = argsFor("/m/hdr.mkv", "/out", planFor(600), { vf: "scale=240:-2,zscale=t=linear" }).join(" ");
  assert.match(hdr, /fps=1\/10:eof_action=pass,scale=240:-2,zscale=t=linear,tile=10x10/);
});

test("small readers: the CPU time from -benchmark, a JPEG's size, the quiet hours", () => {
  assert.equal(cpuMsOf("frame=  4\nbench: utime=19.750s stime=3.781s rtime=21.798s\nbench: maxrss=1kB"), 23531);
  assert.equal(cpuMsOf("nothing"), null);
  assert.equal(jpegSize(Buffer.from([1, 2, 3])), null);
  assert.deepEqual(parseQuiet(""), { from: 2, to: 7 });
  assert.deepEqual(parseQuiet("22-6"), { from: 22, to: 6 });
  const at = (h) => new Date(2026, 10, 9, h, 30);
  assert.equal(inQuiet({ from: 2, to: 7 }, at(1)), false);
  assert.equal(inQuiet({ from: 2, to: 7 }, at(2)), true);
  assert.equal(inQuiet({ from: 2, to: 7 }, at(6)), true);
  assert.equal(inQuiet({ from: 2, to: 7 }, at(7)), false);
  assert.equal(inQuiet({ from: 22, to: 6 }, at(23)), true);
  assert.equal(inQuiet({ from: 22, to: 6 }, at(3)), true);
  assert.equal(inQuiet({ from: 22, to: 6 }, at(12)), false);
  // a changed file (another date) is another folder
  assert.notEqual(keyOf("/a.mkv", 1), keyOf("/a.mkv", 2));
});

const ff = (args) => spawnSync(config.FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true });
// rgb of the centre of tile i of a sheet
const tileColour = (sheet, idx, i) => {
  const out = spawnSync(config.FFMPEG, ["-v", "error", "-i", sheet, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const W = idx.w * idx.cols;
  const t = tileAt(idx, i * idx.interval);
  const x = t.x + Math.floor(idx.w / 2), y = t.y + Math.floor(idx.h / 2);
  const o = (y * W + x) * 3;
  return [out.stdout[o], out.stdout[o + 1], out.stdout[o + 2]];
};

test("a real file: the picture at 0, 10, 20 … s is the one the film shows there", { skip: !config.ffmpegAvailable && "no ffmpeg", timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-scrub-"));
  const film = path.join(tmp, "Colours (2020).mp4");
  // 0-5 red, then ten seconds each of green, blue, white, yellow, magenta:
  // second 10·i falls in the middle of colour i
  const colours = [["red", 5], ["lime", 10], ["blue", 10], ["white", 10], ["yellow", 10], ["magenta", 10]];
  const inputs = colours.flatMap(([c, d]) => ["-f", "lavfi", "-i", `color=c=${c}:s=320x180:r=24:d=${d}`]);
  const chain = colours.map((_, i) => `[${i}:v]`).join("") + `concat=n=${colours.length}:v=1:a=0[v]`;
  const made = ff([...inputs, "-filter_complex", chain, "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-pix_fmt", "yuv420p", film]);
  assert.equal(made.status, 0, String(made.stderr));
  const before = deps.dir;
  deps.dir = path.join(tmp, "scrub");
  try {
    const r = await sprites.make(film, 55, { threads: 1 });
    assert.ok(r.ok, JSON.stringify(r));
    const idx = r.index;
    assert.equal(idx.v, sprites.V);
    assert.equal(idx.interval, 10);
    assert.equal(idx.count, 6);
    assert.equal(idx.sheets, 1);
    assert.equal(idx.w, 240);
    assert.equal(idx.h, 136); // 320x180 → 240 wide, an even height
    assert.ok(idx.bytes > 1000);
    assert.ok(idx.cpuMs == null || idx.cpuMs >= 0);
    const dir = fs.readdirSync(deps.dir).filter((n) => !n.endsWith(".part"));
    assert.equal(dir.length, 1, "one folder, no .part left behind");
    const sheet = path.join(deps.dir, dir[0], "0.jpg");
    const want = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [255, 255, 0], [255, 0, 255]];
    for (let i = 0; i < 6; i++) {
      const got = tileColour(sheet, idx, i);
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(got[c] - want[i][c]) < 40, `tile ${i}: ${got} is not ${want[i]}`);
    }
    // the index on disk is what make() returned
    const disk = JSON.parse(fs.readFileSync(path.join(deps.dir, dir[0], "index.json"), "utf8"));
    assert.equal(disk.count, 6);
    assert.equal(disk.w, 240);
  } finally {
    deps.dir = before;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a file ffmpeg cannot read: no pictures, no folder left behind", { skip: !config.ffmpegAvailable && "no ffmpeg", timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-scrub-"));
  const bad = path.join(tmp, "Broken.mkv");
  fs.writeFileSync(bad, Buffer.alloc(4096, 7));
  const before = deps.dir;
  deps.dir = path.join(tmp, "scrub");
  try {
    const r = await sprites.make(bad, 600, { threads: 1 });
    assert.equal(r.failed, true);
    assert.deepEqual(fs.existsSync(deps.dir) ? fs.readdirSync(deps.dir) : [], []);
  } finally {
    deps.dir = before;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("stopped for a viewer: the run is thrown away, nothing is kept", { skip: !config.ffmpegAvailable && "no ffmpeg", timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-scrub-"));
  const film = path.join(tmp, "Long.mp4");
  assert.equal(ff(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=60", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", film]).status, 0);
  const before = deps.dir;
  deps.dir = path.join(tmp, "scrub");
  try {
    let stopped = false;
    const r = await sprites.make(film, 60, { threads: 1, aborted: () => stopped, onChild: (c) => { stopped = true; c.kill("SIGKILL"); } });
    assert.deepEqual(r, { aborted: true });
    assert.deepEqual(fs.existsSync(deps.dir) ? fs.readdirSync(deps.dir) : [], []);
  } finally {
    deps.dir = before;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
