// Shared by the harness scripts: the browser, the device and line profiles,
// a signed-in page, small statistics.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

const HERE = __dirname;
const OUT = path.join(HERE, "out");

const argv = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] != null && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const list = (name, def) => String(argv(name, def)).split(",").map((s) => s.trim()).filter(Boolean);

// ---------- the browser ----------
// The Chrome already on the machine (as the UI tests do); nothing is downloaded.
const chromePath = () => {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const c = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find((p) => fs.existsSync(p));
  if (!c) throw new Error("No Chrome found: set CHROME_PATH");
  return c;
};

// Nothing may leave the machine: every host name but the loopback resolves to
// nothing, so a third-party request FAILS and shows up in the request log —
// that is how "the site calls out to nobody" is verified, not assumed.
const launch = async ({ headless = true, extraArgs = [], spki = null } = {}) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-mp-chrome-"));
  // Chrome draws its experiment groups ("field trials") from a number it
  // rolls once per profile folder — and some of those experiments change how
  // a picture is scaled, by a few levels of colour: two fresh folders gave two
  // slightly different renderings of the same page. The first folder's
  // "Local State" (where the roll is kept) is saved and handed to every later
  // one, so every launch on this machine is in the same groups.
  const keptState = path.join(HERE, ".cache", "chrome-local-state.json");
  try { if (fs.existsSync(keptState)) fs.copyFileSync(keptState, path.join(userDataDir, "Local State")); } catch {}
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless,
    userDataDir,
    defaultViewport: null,
    args: [
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
      "--disable-features=Translate,MediaRouter,OptimizationHints",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--force-color-profile=srgb",
      ...(spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : []),
      ...extraArgs,
    ],
  });
  const close = async () => {
    try { await browser.close(); } catch {}
    try {
      if (!fs.existsSync(keptState) && fs.existsSync(path.join(userDataDir, "Local State"))) {
        fs.mkdirSync(path.dirname(keptState), { recursive: true });
        fs.copyFileSync(path.join(userDataDir, "Local State"), keptState);
      }
    } catch {}
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); break; } catch { await sleep(150); }
    }
  };
  return { browser, close, userDataDir };
};

// ---------- devices ----------
// CSS viewport, density, touch. The three phone sizes the owner named, plus a
// tablet and a desktop so nothing regresses there.
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const DEVICES = {
  "phone-360": { width: 360, height: 740, dpr: 3, mobile: true },
  "phone-390": { width: 390, height: 844, dpr: 3, mobile: true },
  "phone-412": { width: 412, height: 915, dpr: 2.625, mobile: true },
  "tablet-820": { width: 820, height: 1180, dpr: 2, mobile: true },
  "desktop-1440": { width: 1440, height: 900, dpr: 1, mobile: false },
};
const emulate = async (page, device) => {
  const d = typeof device === "string" ? DEVICES[device] : device;
  await page.setViewport({ width: d.width, height: d.height, deviceScaleFactor: d.dpr, isMobile: d.mobile, hasTouch: d.mobile });
  if (d.mobile) await page.setUserAgent(UA_ANDROID);
};

// ---------- lines and processors ----------
// kbit/s down, kbit/s up, round trip in ms, CPU slowdown. The network ones are
// the owner's list; "applied" by Chrome itself (CDP), every request really
// waits. (CDP adds the latency per request and does not model the handshake of
// a new connection or packet loss — tools/throttle-proxy.js does, and net.js
// can be pointed through it with --proxy.)
const LINES = {
  none: null,
  "slow3g": { down: 400, up: 400, rtt: 400 },
  "regular3g": { down: 1500, up: 750, rtt: 300 },
  "fast3g": { down: 3000, up: 1500, rtt: 150 },
  "lh-slow4g": { down: 1638, up: 675, rtt: 150 },
};
const throttle = async (cdp, { line = "none", cpu = 1 } = {}) => {
  const l = LINES[line];
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", l
    ? { offline: false, latency: l.rtt, downloadThroughput: (l.down * 1000) / 8, uploadThroughput: (l.up * 1000) / 8 }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
};

// ---------- a signed-in page ----------
// The door lets a remembered, password-free profile straight in: that memory
// is three localStorage keys. They are written from a page of the same origin
// that is NOT the app (/robots.txt), so no app code runs and no service
// worker registers before the measurement.
const prime = async (page, inst, { look = "glass", profile = true, extra = {} } = {}) => {
  await page.goto(`${inst.origin || inst.url}/robots.txt`, { waitUntil: "load" });
  const p = inst.profiles[look];
  await page.evaluate((id, name, look, profile, extra) => {
    localStorage.clear();
    sessionStorage.clear();
    if (profile) {
      localStorage.setItem("aurora-profile", id);
      localStorage.setItem("aurora-profile-name", JSON.stringify(name));
    }
    localStorage.setItem("aurora-look", look === "legacy" ? "legacy" : "glass");
    // what a device that has been here before knows (index.html's early
    // requests go by these; code from before them ignores both)
    localStorage.setItem("aurora-authmode", "open");
    if (profile) localStorage.setItem("aurora-early", "open");
    // the one-time hints, already seen: they are not what is being measured
    localStorage.setItem("aurora-nav-hinted", "1");
    localStorage.setItem("aurora-kbd-hint", "1");
    for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
  }, p.id, p.name, look, profile, extra);
  await page.goto("about:blank");
};
// Cold: no HTTP cache, no service worker, no Cache Storage. (localStorage is
// left to prime().)
const clearCaches = async (cdp, origin) => {
  await cdp.send("Network.enable");
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "cache_storage,service_workers,indexeddb" });
};

// ---------- numbers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => {
  const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const spread = (a) => {
  const s = a.filter((x) => x != null && Number.isFinite(x));
  return s.length ? { min: Math.min(...s), median: median(s), max: Math.max(...s), n: s.length } : null;
};
const outDir = (label, kind) => {
  const d = path.join(OUT, label, kind);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); };

// ---------- a real slow line ----------
// tools/throttle-proxy.js (the repo's own) between the browser and the front:
// one shared bandwidth budget and added latency for EVERYTHING — the page,
// its service worker, the live socket, the TLS handshake — which CDP's
// emulation does not cover (it skips the worker's own requests).
const freePort = () => new Promise((resolve, reject) => {
  const s = require("net").createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const startLine = async (targetOrigin, line, { loss = 0 } = {}) => {
  const l = typeof line === "string" ? LINES[line] : line;
  if (!l) return { origin: targetOrigin, stop: async () => {} };
  const { spawn } = require("child_process");
  const t = new URL(targetOrigin);
  const port = await freePort();
  const child = spawn(process.execPath, [
    path.join(HERE, "..", "throttle-proxy.js"),
    "--listen", String(port), "--to", t.port, "--down", String(l.down), "--up", String(l.up),
    "--latency", String(Math.round(l.rtt / 2)), "--loss", String(loss),
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("throttle-proxy did not start")), 8000);
    child.stdout.on("data", (c) => { if (/throttle:/.test(String(c))) { clearTimeout(to); resolve(); } });
    child.on("exit", (code) => reject(new Error(`throttle-proxy exited ${code}`)));
  });
  return {
    origin: `${t.protocol}//127.0.0.1:${port}`,
    stop: async () => { try { child.kill(); } catch {} },
  };
};

// ---------- everything a script needs, in one call ----------
// The instance (a running by-hand one, or a new one), the HTTP/2 front before
// it (--front h1 measures the server bare, as on the home network), a browser.
// `origin` is where pages are opened.
const open = async ({ headless = true, extraArgs = [] } = {}) => {
  const { getInstance } = require("./instance");
  const { startFront } = require("./front");
  const inst = await getInstance();
  const h2 = argv("front", "h2") !== "h1";
  const front = h2 ? await startFront(inst.url) : null;
  const origin = front ? front.url : inst.url;
  const b = await launch({ headless, extraArgs, spki: front && front.spki });
  return {
    inst: { ...inst, origin }, origin, browser: b.browser, protocol: h2 ? "h2" : "h1",
    // the same app behind a slow line: { inst (with its own origin), stop }
    line: async (name, opts) => {
      const l = await startLine(origin, name, opts);
      return { inst: { ...inst, origin: l.origin }, origin: l.origin, stop: l.stop };
    },
    close: async () => { await b.close(); if (front) await front.stop(); await inst.stop(); },
  };
};

module.exports = { open, startLine, freePort, HERE, OUT, argv, flag, list, launch, DEVICES, emulate, LINES, throttle, prime, clearCaches, sleep, median, spread, outDir, writeJson, UA_ANDROID };
