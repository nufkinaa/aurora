// Real glass: the lens at the rim of the website's chrome (public/js/
// glasslens.js, glass.css "Real glass").
//   - Only Chromium may be given the lens: Safari parses url() inside
//     backdrop-filter and then draws NO backdrop filter at all (the bar would
//     lose its dim and its words) — so an iPhone, whatever the browser is
//     called, and Firefox must never get html[data-lens].
//   - The map itself: straight through on the face, bent inwards at the rim,
//     and the same on both sides.
//   - The stylesheet only uses a url() under html[data-lens].
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const UA = {
  chromeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  oldChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
  ipadDesktopMode: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
  firefoxIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15",
};
const win = (over = {}) => ({ CSS: { supports: () => true }, localStorage: { getItem: () => null }, ...over });

test("the lens is given to Chromium and to nothing else", async () => {
  const { lensSupported } = await import("../public/js/glasslens.js");
  for (const k of ["chromeWin", "chromeAndroid", "edge"]) assert.equal(lensSupported({ userAgent: UA[k] }, win()), true, k);
  for (const k of ["oldChrome", "safariMac", "iphoneSafari", "iphoneChrome", "ipadDesktopMode", "firefox", "firefoxIos"]) {
    assert.equal(lensSupported({ userAgent: UA[k] }, win()), false, k);
  }
  // a browser that says "Chrome" in its name but lists no Chromium brand
  assert.equal(lensSupported({ userAgent: UA.chromeWin, userAgentData: { brands: [{ brand: "Mystery", version: "1" }] } }, win()), false);
  assert.equal(lensSupported({ userAgent: UA.chromeWin, userAgentData: { brands: [{ brand: "Chromium", version: "141" }] } }, win()), true);
  // no backdrop-filter with a url() in it, no lens
  assert.equal(lensSupported({ userAgent: UA.chromeWin }, win({ CSS: { supports: () => false } })), false);
  // the switch: localStorage aurora-lens = "off"
  assert.equal(lensSupported({ userAgent: UA.chromeWin }, win({ localStorage: { getItem: (k) => (k === "aurora-lens" ? "off" : null) } })), false);
  // nothing to ask (a test runner, a worker): no lens, no throw
  assert.equal(lensSupported(null, null), false);
});

test("the map: straight through on the face, pulled inwards at the rim, the same both sides", async () => {
  const { lensMap, lensGeometry } = await import("../public/js/glasslens.js");
  const w = 120, h = 60;
  const px = new Map();
  lensMap(w, h, 999, (x, y, r, g, b) => px.set(`${x},${y}`, [r, g, b]));
  assert.equal(px.size, w * h);
  const { bezel, r } = lensGeometry(w, h, 999);
  assert.equal(r, 30, "a pill's corner is half its height");
  assert.ok(bezel >= 5 && bezel <= 13);
  // the middle of the face: no bend, not the bezel's
  assert.deepEqual(px.get("60,30").map(Math.round), [128, 128, 0]);
  // the top edge, mid-way along: pulled DOWN (from further inside), fully the bezel's
  const top = px.get("60,0");
  assert.ok(top[1] > 200 && Math.abs(top[0] - 128) < 1, `top ${top}`);
  // (no line of light along the top: the bevel shows there at half strength, in full along the foot)
  assert.ok(Math.abs(top[2] - 127.5) < 1 && px.get("60,59")[2] > 250, `the veil: top ${top[2]}, foot ${px.get("60,59")[2]}`);
  // the foot: pulled up by the same amount
  const foot = px.get("60,59");
  assert.ok(Math.abs(top[1] - 128 + (foot[1] - 128)) < 1, "top and foot mirror each other");
  // the two ends mirror each other too
  const l = px.get("0,30"), rt = px.get("119,30");
  assert.ok(l[0] > 200 && rt[0] < 56 && Math.abs(l[0] - 128 + (rt[0] - 128)) < 1, `ends ${l} ${rt}`);
  // every value is a colour
  for (const v of px.values()) for (const c of v) assert.ok(c >= 0 && c <= 255);
  // a thicker look has a wider bezel
  assert.ok(lensGeometry(w, h, 999, 1.5).bezel > bezel);
});

test("the colours of the fringe: every colour adds up to one, red bent most, blue least", async () => {
  const { lensTaps } = await import("../public/js/glasslens.js");
  for (const n of [3, 5]) {
    const taps = lensTaps(n, 0.1);
    assert.equal(taps.length, n);
    for (const ch of [0, 1, 2]) assert.ok(Math.abs(taps.reduce((a, t) => a + t.rgb[ch], 0) - 1) < 1e-9, `channel ${ch} of ${n}`);
    assert.ok(Math.abs(taps[0].k - 1.1) < 1e-9 && Math.abs(taps[n - 1].k - 0.9) < 1e-9);
    assert.ok(taps[0].rgb[0] > 0 && taps[0].rgb[2] === 0 && taps[n - 1].rgb[2] > 0 && taps[n - 1].rgb[0] === 0);
    for (let i = 1; i < n; i++) assert.ok(taps[i].k < taps[i - 1].k);
  }
});

test("the stylesheet shows a url() backdrop only under html[data-lens], and the scripts agree on the surfaces", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "css", "glass.css"), "utf-8");
  const js = fs.readFileSync(path.join(__dirname, "..", "public", "js", "glasslens.js"), "utf-8");
  // every rule that mentions url(#rg-…) is scoped to [data-lens]
  const rules = css.split("}");
  let seen = 0;
  for (const rule of rules) {
    if (!/url\(#rg-/.test(rule)) continue;
    seen++;
    const sel = rule.slice(0, rule.lastIndexOf("{")).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const one of sel.split(",")) assert.match(one, /\[data-lens\]/, `a url() backdrop outside [data-lens]: ${one.trim()}`);
  }
  assert.ok(seen >= 1, "the lens rule is there");
  // the script's surfaces are the stylesheet's
  const list = (name) => { const from = js.indexOf(`const ${name} = [`); return js.slice(from, js.indexOf("];", from)).match(/"[^"]+"/g).map((x) => x.slice(1, -1)); };
  const always = list("ALWAYS"), atTimes = list("AT_TIMES");
  assert.ok(always.includes(".nav-items"));
  for (const x of always) assert.ok(css.includes(`html[data-look="glass"][data-lens] ${x}`), `glass.css gives ${x} the lens`);
  // the rest take it only while a film is paused — never at rest
  for (const x of atTimes) {
    const at = `html[data-look="glass"][data-lens] .player.is-paused:not(.glass-rest) ${x}`;
    assert.ok(css.includes(at), `glass.css gives ${x} the lens at its time (${at})`);
    // (at rest: the bare selector, followed straight by "," or "{", must not be in a lens rule)
    for (const end of [",", " {"]) assert.ok(!css.includes(`html[data-look="glass"][data-lens] ${x}${end}`), `${x} has no lens at rest`);
  }
  // the small buttons never take it (nothing but the lists above is in a lens rule)
  for (const x of [".nav-gear", ".nav-dl", ".nav-remote", ".nav-logo", ".nav-profile", ".detail-actions"]) assert.ok(!new RegExp(`\[data-lens\][^{]*\${x}[^{]*\{[^}]*--rg-lens`).test(css), `${x} has no lens`);
  // never over a PLAYING film: every lens rule on the player's chrome is under .player.is-paused
  for (const m of css.matchAll(/\[data-lens\]([^{,]*\.(?:player-bottom|player-top|upnext|resume-card|quality-pill|party-pill)[^{,]*)/g)) assert.match(m[1], /\.player\.is-paused/, `a lens over a playing film: ${m[0]}`);
  // and no light along the top of a pane: no positive-y white inset line in the rim
  const rim = /--rg-rim:([\s\S]*?);/.exec(css)[1];
  assert.doesNotMatch(rim, /inset 0 1px 0[^,]*rgba\(255, 255, 255/, "no white line along the top");
});
