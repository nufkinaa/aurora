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

test("the map: the face pulls gently towards the middle and sits a little to one side, the bevel turns the picture over", async () => {
  const { lensMap, lensGeometry, lensReach } = await import("../public/js/glasslens.js");
  const w = 240, h = 60;
  const look = { thick: 1, face: 6, shift: 9 };
  const geo = lensGeometry(w, h, 999, 1);
  const reach = lensReach(geo, look);
  const px = new Map();
  lensMap(w, h, 999, (x, y, r, g) => px.set(`${x},${y}`, [((r - 128) * reach) / 127, ((g - 128) * reach) / 127]), 1, look);
  assert.equal(px.size, w * h);
  assert.equal(geo.r, 30, "a pill's corner is half its height");
  // the middle of the face: only the shift (so red parts from blue there too), mostly across
  const mid = px.get("120,30");
  assert.ok(mid[0] > 6 && mid[0] < 9.5 && mid[1] > 2 && mid[1] < 5.5, `middle ${mid}`);
  // without a shift the middle is straight through, and top and foot mirror each other
  const flat = new Map();
  lensMap(w, h, 999, (x, y, r, g) => flat.set(`${x},${y}`, [r - 128, g - 128]), 1, { thick: 1, face: 6, shift: 0 });
  assert.ok(Math.abs(flat.get("120,30")[0]) < 1.5 && Math.abs(flat.get("120,30")[1]) < 1.5);
  const top = flat.get("120,0"), foot = flat.get("120,59");
  assert.ok(top[1] > 60 && foot[1] < -60 && Math.abs(top[1] + foot[1]) < 1.5, `top ${top} foot ${foot}: the rim looks inwards`);
  // the pull grows from the middle outwards: nearer the edge, further inwards
  assert.ok(flat.get("120,20")[1] > flat.get("120,28")[1]);
  for (const v of px.values()) for (const c of v) assert.ok(Math.abs(c) <= reach + 1);
  assert.ok(lensGeometry(w, h, 999, 1.5).bezel > geo.bezel);
});

test("the colours of the fringe: every colour adds up to one, red bent most, blue least", async () => {
  const { lensTaps } = await import("../public/js/glasslens.js");
  for (const n of [2, 3, 5]) {
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
  // the surfaces that stand alone take it while they are there; never a repeated item
  const whileOpen = list("WHILE_OPEN");
  assert.ok(whileOpen.includes(".search-box") && whileOpen.includes(".nav-more-sheet"));
  for (const x of whileOpen) assert.ok(css.includes(`html[data-look="glass"][data-lens] ${x}`), `glass.css gives ${x} the lens`);
  for (const x of [".episode", ".dl-row", ".calg-day", ".chip", ".source-row", ".wn-card", ".pref-section"]) {
    assert.ok(!whileOpen.includes(x) && !always.includes(x), `${x} is not given a lens by the script`);
    // (no lens rule names it: every rule that sets --rg-lens or a url() under [data-lens])
    for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
      if (!/\[data-lens\]/.test(rule) || !/--rg-lens|url\(#rg-/.test(rule)) continue;
      const sel = rule.slice(0, rule.lastIndexOf("{"));
      assert.ok(!sel.split(",").some((one) => one.trim().split(/\s+/).pop().split(/(?=[.:\[])/).includes(x)), `${x} has no lens in the stylesheet`);
    }
  }
  // the rest take it only while a film is paused — never at rest
  for (const x of atTimes) {
    const at = `html[data-look="glass"][data-lens] .player.is-paused:not(.glass-rest) ${x}`;
    assert.ok(css.includes(at), `glass.css gives ${x} the lens at its time (${at})`);
    // (at rest: the bare selector, followed straight by "," or "{", must not be in a lens rule)
    for (const end of [",", " {"]) assert.ok(!css.includes(`html[data-look="glass"][data-lens] ${x}${end}`), `${x} has no lens at rest`);
  }
  // the small buttons never take it (nothing but the lists above is in a lens rule)
  for (const x of [".nav-gear", ".nav-dl", ".nav-remote", ".nav-logo", ".nav-profile", ".detail-actions"]) assert.ok(!new RegExp(`\[data-lens\][^{]*\${x}[^{]*\{[^}]*--rg-lens`).test(css), `${x} has no lens`);
  // the map is a data: image (a CSP img-src without data: would break the lens): said where it is made
  assert.match(js, /toDataURL\("image\/png"\)/);
  assert.match(js, /img-src left out data:/);
  // a resting paused player keeps its frost and its dim: only the url() goes
  assert.match(css, /\.player\.is-paused\.glass-rest \.player-bottom,[\s\S]{0,400}--g-blur: blur\(var\(--rg-soft\)\) saturate\(2\) brightness\(0\.44\);/);
  // a closed player arms no timers: its last `pause` arrives after the clean-up
  const player = fs.readFileSync(path.join(__dirname, "..", "public", "js", "screens", "player.js"), "utf-8");
  const sc = player.slice(player.indexOf("const showControls = () => {"));
  assert.ok(sc.indexOf("if (exited) return;") > 0 && sc.indexOf("if (exited) return;") < sc.indexOf("overlay.classList.remove("), "showControls does nothing once the player has been closed");
  // never over a PLAYING film: every lens rule on the player's chrome is under .player.is-paused
  for (const m of css.matchAll(/\[data-lens\]([^{,]*\.(?:player-bottom|player-top|upnext|resume-card|quality-pill|party-pill)[^{,]*)/g)) assert.match(m[1], /\.player\.is-paused/, `a lens over a playing film: ${m[0]}`);
  // and no light along the top of a pane: no positive-y white inset line in the rim
  const rim = /--rg-rim:([\s\S]*?);/.exec(css)[1];
  assert.doesNotMatch(rim, /inset 0 1px 0[^,]*rgba\(255, 255, 255/, "no white line along the top");
});
