// Shared by tools/webperf: the browser (the machine's own Chrome through
// playwright-core, channel "chrome"), the devices and lines, a signed-in page,
// small statistics. The instance (a private, throwaway Aurora with a large
// made-up catalogue) is tools/mobile-perf's — see its README.
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const HERE = __dirname;
const OUT = path.join(HERE, "out");

const argv = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] != null && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);
const list = (name, def) => String(argv(name, def)).split(",").map((s) => s.trim()).filter(Boolean);

// The owner's sizes: desktop, the two iPads, the two phones. Touch devices get
// an Android Chrome user agent (the engine IS Chrome: an iPad UA would send the
// app down Safari-only paths that Chrome cannot take).
const UA_PHONE = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const UA_TABLET = "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DEVICES = {
  "desktop-1440": { width: 1440, height: 900, dpr: 1, mobile: false },
  "ipad-1024": { width: 1024, height: 1366, dpr: 2, mobile: true, ua: UA_TABLET },
  "ipad-820": { width: 820, height: 1180, dpr: 2, mobile: true, ua: UA_TABLET },
  "phone-390": { width: 390, height: 844, dpr: 3, mobile: true, ua: UA_PHONE },
  "phone-360": { width: 360, height: 800, dpr: 3, mobile: true, ua: UA_PHONE },
};

// kbit/s down / up, round trip ms (Chrome's own emulation, CDP).
const LINES = {
  none: null,
  "4g": { down: 9000, up: 9000, rtt: 85 },
  fast3g: { down: 3000, up: 1500, rtt: 150 },
  slow3g: { down: 400, up: 400, rtt: 400 },
};

const launch = async ({ extraArgs = [] } = {}) =>
  chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      // nothing leaves the machine: a third-party request fails
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
      "--disable-features=Translate,MediaRouter,OptimizationHints",
      "--disable-background-networking",
      "--disable-component-update",
      "--force-color-profile=srgb",
      "--js-flags=--expose-gc",
      ...extraArgs,
    ],
  });

const newContext = async (browser, device) => {
  const d = DEVICES[device];
  if (!d) throw new Error(`unknown device ${device}`);
  return browser.newContext({
    viewport: { width: d.width, height: d.height },
    deviceScaleFactor: d.dpr,
    isMobile: d.mobile,
    hasTouch: d.mobile,
    ...(d.ua ? { userAgent: d.ua } : {}),
    serviceWorkers: "allow",
  });
};

const throttle = async (cdp, { line = "none", cpu = 1 } = {}) => {
  const l = LINES[line];
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", l
    ? { offline: false, latency: l.rtt, downloadThroughput: (l.down * 1000) / 8, uploadThroughput: (l.up * 1000) / 8 }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
};

// A remembered, password-free profile: written from /robots.txt (same origin,
// no app code, no service worker) before the app is opened.
const prime = async (page, inst, { look = "glass", profile = true, extra = {} } = {}) => {
  await page.goto(`${inst.url}/robots.txt`, { waitUntil: "load" });
  const p = inst.profiles[look];
  await page.evaluate(([id, name, look, profile, extra]) => {
    localStorage.clear();
    sessionStorage.clear();
    if (profile) {
      localStorage.setItem("aurora-profile", id);
      localStorage.setItem("aurora-profile-name", JSON.stringify(name));
    }
    localStorage.setItem("aurora-look", look === "legacy" ? "legacy" : "glass");
    localStorage.setItem("aurora-authmode", "open");
    if (profile) localStorage.setItem("aurora-early", "open");
    localStorage.setItem("aurora-nav-hinted", "1");
    localStorage.setItem("aurora-kbd-hint", "1");
    for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
  }, [p.id, p.name, look, profile, extra]);
};
const clearCaches = async (cdp, origin) => {
  await cdp.send("Network.enable");
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "cache_storage,service_workers" });
};

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
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 1)); };

module.exports = { HERE, OUT, argv, flag, list, DEVICES, LINES, launch, newContext, throttle, prime, clearCaches, sleep, median, spread, writeJson };
