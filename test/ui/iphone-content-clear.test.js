// Every screen's first content clears the top controls, on every iPhone, and
// the toast and the phone tab bar stay readable over a bright poster.
//
// elia, 2026-11-03, a photo of his island iPhone (glass, opened from the Home
// Screen, Search with "schmiga" typed): the Search box ran under the logo
// pill, the downloads, gear and avatar buttons; the "Saving — the episode
// shows its progress" toast was a colourful smear over the posters, its words
// lost at the edge; the tab bar's labels were just as hard to read.
//
// The cause of the first: from the Home Screen the page runs under the
// status bar and the glass pills come down by the top inset, but --nav-h,
// which every screen places its first content from, did not.
//
// The insets are Chrome's own safe-area emulation (as iphone-topbar.test.js):
//   Home Screen app   the top inset is 59-62 on an island phone, 47 on a notch
//                     one, 20 on an old one
//   a Safari tab      0 on every iPhone (html.ios-island from the screen size)
//   Android           0
//
// REPORT=1: print every measurement (the numbers in the fix's report).
// SHOTS=<folder>: write a screenshot of each screen's top, and the toast case.
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { suite } = require("./helpers");

const ui = suite();
const REPORT = !!process.env.REPORT;
const SHOTS = process.env.SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

// [case, width, height, top inset, user agent]
const CASES = [
  ["island, Home Screen", 393, 852, 59, IPHONE],
  ["16 Pro, Home Screen", 402, 874, 62, IPHONE],
  ["notch, Home Screen", 390, 844, 47, IPHONE],
  ["old, Home Screen", 375, 667, 20, IPHONE],
  ["island, Safari tab", 393, 852, 0, IPHONE],
  ["notch, Safari tab", 390, 844, 0, IPHONE],
  ["Android", 412, 915, 0, ANDROID],
];
// The gap between the bottom of the top controls and the first thing on the
// screen: at least this, everywhere.
const MIN_GAP = 8;

// [name, route] — every screen with something at its top. The title pages
// and Home open on a picture that runs under the controls on purpose: what
// counts there is the first words or button.
const SCREENS = (lib) => [
  ["Home", "#/"],
  ["Movies", "#/movies"],
  ["Shows", "#/shows"],
  ["My List", "#/list"],
  ["Search", "#/search"],
  ["Search with results", "#/search/Test"],
  ["a film", `#/movie/${lib.film1.id}`],
  ["a show", `#/show/${lib.show.id}`],
  ["Settings", "#/preferences"],
  ["What's new", "#/new"],
  ["My downloads", "#/downloads"],
  ["On this device", "#/saved"],
  ["Wrapped", "#/wrapped"],
  ["Taste", "#/taste"],
  ["Taste list", "#/taste/list"],
  ["Recommended", "#/household"],
  ["You sent", "#/household/sent"],
  ["AI pick", "#/pick"],
  ["Requests", "#/requests"],
];

// The bottom of the top controls and the top of the first content on screen.
const measure = () => {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const visible = (el) => {
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return null;
    if (b.bottom <= 0 || b.top >= vh || b.right <= 0 || b.left >= vw) return null;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    return b;
  };
  let controls = 0;
  const parts = {};
  for (const sel of [".nav-logo", ".nav-dl", ".nav-gear", ".nav-profile"]) {
    const el = document.querySelector(sel);
    const b = el && visible(el);
    if (b) { controls = Math.max(controls, b.bottom); parts[sel] = Math.round(b.bottom * 10) / 10; }
  }
  const screen = document.querySelector("#app .screen") || document.getElementById("app");
  let first = null;
  const MEDIA = new Set(["IMG", "PICTURE", "VIDEO", "CANVAS", "svg"]);
  const INTERACTIVE = new Set(["INPUT", "BUTTON", "SELECT", "TEXTAREA"]);
  for (const el of screen.querySelectorAll("*")) {
    if (el.closest("[aria-hidden='true']")) continue;
    const pos = getComputedStyle(el).position;
    if (pos === "fixed") continue; // sheets, toasts: not the page's first content
    const tag = el.tagName;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const isMedia = MEDIA.has(tag) || tag === "svg";
    // a painted box (the Search field's glass pill, a card): its edge is
    // what meets the controls, not the words inside it
    const cs = getComputedStyle(el);
    const painted = (cs.backgroundImage !== "none" || !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) ||
      (cs.backdropFilter && cs.backdropFilter !== "none")) && el !== screen;
    if (!ownText && !isMedia && !painted && !INTERACTIVE.has(tag)) continue;
    if (isMedia && el.closest("button, a, label")) continue; // the button counts, not its icon
    const b = visible(el);
    if (!b) continue;
    // a backdrop picture (the full-width art under a hero, a title's
    // cover) runs under the controls on purpose: it is not content
    if (isMedia && b.width >= vw * 0.9) continue;
    if (painted && !ownText && !isMedia && (b.height >= vh * 0.4 || b.width >= vw * 0.97)) continue;
    let top = b.top;
    if (ownText) {
      // the words themselves, not a tall box they sit at the bottom of
      const r = document.createRange();
      r.selectNodeContents(el);
      const rects = [...r.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
      if (rects.length) top = Math.min(...rects.map((x) => x.top));
    }
    if (!first || top < first.top) {
      first = { top, what: `${tag.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""} "${(el.textContent || el.getAttribute("placeholder") || el.getAttribute("aria-label") || "").trim().slice(0, 30)}"` };
    }
  }
  return {
    controls: Math.round(controls * 10) / 10,
    parts,
    first: first ? { top: Math.round(first.top * 10) / 10, what: first.what } : null,
    sat: (() => {
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;top:0;height:env(safe-area-inset-top,0px)";
      document.body.append(d);
      const h = d.getBoundingClientRect().height;
      d.remove();
      return h;
    })(),
    sw: document.documentElement.scrollWidth,
    vw,
  };
};

const report = {};
const profiles = {};
const setupProfile = async ({ api, freshProfile }, look) => {
  if (profiles[look]) return profiles[look];
  const me = await freshProfile();
  const h = await api.as(me);
  if (look === "legacy") await api.ok("PUT", `/api/profiles/${me.id}`, { look: "legacy" }, h);
  profiles[look] = me;
  return me;
};
const emulate = async (page, context, inset) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: inset, topMax: inset, bottom: inset ? 34 : 0, bottomMax: inset ? 34 : 0 } });
};
const settle = async (page) => {
  // the glass screens rise in (opacity only on a phone); fonts and the
  // late rows land within a few frames
  await page.waitForTimeout(700);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};

for (const look of ["glass", "legacy"]) {
  for (const [name, width, height, inset, userAgent] of CASES) {
    const device = { screen: { width, height }, deviceScaleFactor: 3, userAgent };
    ui.test(`${look}, ${name}: every screen starts at least ${MIN_GAP}px under the top controls`, { viewport: { width, height }, device }, async (h) => {
      const { page, context, lib, signIn, goto } = h;
      const me = await setupProfile(h, look);
      await emulate(page, context, inset);
      await signIn(me);
      const rows = [];
      for (const [screen, route] of SCREENS(lib)) {
        await goto(route);
        await page.evaluate(() => window.scrollTo(0, 0));
        await settle(page);
        const m = await page.evaluate(measure);
        assert.ok(Math.abs(m.sat - inset) <= 1, `the emulated inset is ${m.sat}, not ${inset}`);
        rows.push({ screen, ...m, gap: m.first ? Math.round((m.first.top - m.controls) * 10) / 10 : null });
        if (SHOTS) {
          const file = `${look}-${name}-${screen}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
          await page.screenshot({ path: path.join(SHOTS, `${file}.png`), clip: { x: 0, y: 0, width, height: Math.min(height, 360) } }).catch(() => {});
        }
      }
      // the profile menu opens under the avatar, not over it
      await page.click("#nav-profile");
      await page.waitForSelector(".nav-menu", { state: "visible" });
      // (it drops in: measured once its animation is over)
      await page.waitForFunction(() => document.querySelector(".nav-menu-wrap, .nav-menu").parentElement
        .getAnimations({ subtree: true })
        .every((a) => a.playState !== "running" || !a.effect || a.effect.getComputedTiming().iterations === Infinity));
      await page.waitForTimeout(100);
      const menu = await page.evaluate(() => ({
        top: document.querySelector(".nav-menu").getBoundingClientRect().top,
        avatar: document.querySelector(".nav-profile").getBoundingClientRect().bottom,
      }));
      await page.keyboard.press("Escape").catch(() => {});
      rows.push({ screen: "the profile menu", controls: Math.round(menu.avatar * 10) / 10, first: { top: Math.round(menu.top * 10) / 10, what: ".nav-menu" }, gap: Math.round((menu.top - menu.avatar) * 10) / 10 });
      report[`${look} | ${name}`] = rows;
      if (REPORT) {
        console.log(`\n== ${look} | ${name} (inset ${inset})`);
        for (const r of rows) console.log(`  ${r.screen.padEnd(20)} controls ${String(r.controls).padStart(6)}  first ${String(r.first && r.first.top).padStart(6)}  gap ${String(r.gap).padStart(6)}  ${r.first ? r.first.what : "-"}`);
      }
      const bad = rows.filter((r) => r.first == null || r.gap < (r.screen === "the profile menu" ? 0 : MIN_GAP));
      assert.deepEqual(bad.map((r) => `${r.screen}: ${r.first ? `${r.first.what} at ${r.first.top}, controls end at ${r.controls} (gap ${r.gap})` : "nothing on screen"}`), [],
        "screens whose first content is not clear of the top controls");
      for (const r of rows) if (r.sw != null) assert.ok(r.sw <= r.vw + 1, `${r.screen} scrolls sideways (${r.sw} > ${r.vw})`);
    });
  }
}

// From the Home Screen, the page moves exactly as far as the controls do:
// each screen keeps the gap it has in a Safari tab on the same phone. (Not
// the screens whose first words sit at the foot of a picture or in the
// middle of the screen: those follow the screen's height, not the top.)
const NOT_FROM_THE_TOP = new Set(["Home", "a film", "a show", "Taste list"]);
for (const look of ["glass", "legacy"]) {
  for (const [home, tab] of [["island, Home Screen", "island, Safari tab"], ["notch, Home Screen", "notch, Safari tab"]]) {
    ui.test(`${look}: ${home} keeps every screen's gap from the ${tab}`, async () => {
      const a = report[`${look} | ${home}`];
      const b = report[`${look} | ${tab}`];
      assert.ok(a && b, "the cases above did not run");
      const off = [];
      for (const r of a) {
        if (NOT_FROM_THE_TOP.has(r.screen)) continue;
        const s = b.find((x) => x.screen === r.screen);
        if (s && r.gap != null && s.gap != null && Math.abs(r.gap - s.gap) > 2) off.push(`${r.screen}: ${r.gap} from the Home Screen, ${s.gap} in a tab`);
      }
      assert.deepEqual(off, []);
    });
  }
}

// ---------- the toast and the tab bar over a bright poster ----------
// A bright, saturated poster is laid under the bottom of the screen (between
// the page and the floating glass), the way a row of posters scrolls under
// them. The colour each surface ends up showing is read off a screenshot —
// the real blur and tint, as drawn — at the brightest spot beside its words,
// and the words' colour is laid over it.
const lum = ([r, g, b]) => {
  const c = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// (a colour made by color-mix() computes to "color(srgb r g b)", channels 0..1)
const parseColor = (s) => {
  const m = s.match(/[\d.]+/g).map(Number);
  const unit = /^color\(srgb/.test(s);
  return { rgb: m.slice(0, 3).map((v) => (unit ? Math.round(v * 255) : v)), a: m.length > 3 ? m[3] : 1 };
};
const over = (fg, bg) => fg.rgb.map((v, i) => v * fg.a + bg[i] * (1 - fg.a));

// (not pointer-events: none — navTone.js reads what is under the nav the way
// a tap would find it, and must see the poster as it sees a real one)
const POSTER = `position:fixed;inset:0;z-index:50;background:
  linear-gradient(90deg, #ffffff 0 18%, #fff36b 18% 34%, #7af7ff 34% 50%, #ff9cf4 50% 66%, #ffffff 66% 82%, #b8ff9a 82%)`;

// pixels of a PNG screenshot, without a dependency: Chrome writes 8-bit RGBA
// (colour type 6) or RGB (2), non-interlaced
const zlib = require("zlib");
const decodePng = (buf) => {
  let pos = 8; let width = 0; let height = 0; let type = 6; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const kind = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; assert.equal(data[8], 8, "8-bit PNG"); }
    if (kind === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp; const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0; const b = y ? out[(y - 1) * stride + x] : 0; const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, at: (x, y) => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2]]; } };
};

// the brightest colour of a surface's own ground: a band of pixels in the
// padding above and below its words, across its width (less `side` at each end)
const shot = async (page) => decodePng(await page.screenshot({ scale: "css" }));
const groundOf = (png, box, textBox, side = 18) => {
  let worst = null;
  const rows = [];
  for (let y = Math.ceil(box.top + 3); y < Math.floor(textBox.top - 1); y++) rows.push(y);
  for (let y = Math.ceil(textBox.bottom + 1); y < Math.floor(box.bottom - 3); y++) rows.push(y);
  for (const y of rows) {
    for (let x = Math.ceil(box.left + side); x < Math.floor(box.right - side); x += 2) {
      const px = png.at(x, y);
      if (!worst || lum(px) > lum(worst)) worst = px;
    }
  }
  assert.ok(worst, "no ground to read beside the words");
  return worst;
};
// the poster goes in, and navTone.js (which turns the nav's words dark over
// something bright) is given its scroll to look again
const addPoster = async (page) => {
  await page.evaluate((css) => {
    const d = document.createElement("div");
    d.id = "bright-poster";
    d.style.cssText = css;
    document.body.append(d);
    document.dispatchEvent(new Event("scroll"));
  }, POSTER);
  await page.waitForTimeout(900);
};

const TOAST_TEXT = "Saving — the episode shows its progress";

for (const look of ["glass", "legacy"]) {
  // (and a desktop window: the same glass toast, in the corner over the rows)
  for (const width of [320, 375, 393, 430, 1280]) {
    const phone = width < 600;
    ui.test(`${look}, ${width}px: the toast's words wrap inside it and read over a bright poster`, { viewport: { width, height: 800 }, device: phone ? { deviceScaleFactor: 2, userAgent: IPHONE } : null }, async (h) => {
      const { page, signIn, goto } = h;
      const me = await setupProfile(h, look);
      await signIn(me);
      await goto("#/search/Test");
      await addPoster(page);
      await page.evaluate(async (text) => { const { toast } = await import("/js/ui.js"); toast(text, "⬇️"); }, TOAST_TEXT);
      const t = await page.waitForSelector(".toast:not(.hide)");
      await page.waitForTimeout(500); // the toast's slide-in
      const m = await t.evaluate((node) => {
        const words = [...node.children].find((c) => c.textContent.includes("Saving"));
        const r = document.createRange(); r.selectNodeContents(words);
        const lines = [...r.getClientRects()];
        const b = node.getBoundingClientRect();
        const wb = words.getBoundingClientRect();
        const cs = getComputedStyle(node);
        return {
          box: { top: b.top, bottom: b.bottom, left: b.left, right: b.right },
          text: { top: Math.min(...lines.map((x) => x.top)), bottom: Math.max(...lines.map((x) => x.bottom)), right: Math.max(...lines.map((x) => x.right)) },
          padRight: parseFloat(cs.paddingRight),
          overflow: words.scrollWidth > words.clientWidth + 1,
          lineTops: new Set(lines.map((x) => Math.round(x.top))).size,
          spanRight: wb.right,
          color: getComputedStyle(words).color,
          vw: document.documentElement.clientWidth,
        };
      });
      assert.ok(m.box.left >= 0 && m.box.right <= m.vw, `the toast runs off the screen (${m.box.left}..${m.box.right} of ${m.vw})`);
      assert.ok(m.text.right <= m.box.right - m.padRight + 1, `the words run out of the toast (they end at ${m.text.right}, its inside ends at ${m.box.right - m.padRight})`);
      assert.ok(!m.overflow, "the words overflow their line");
      const ground = groundOf(await shot(page), m.box, m.text);
      const c = ratio(over(parseColor(m.color), ground), ground);
      if (REPORT) console.log(`  toast ${look} ${width}px: ${m.lineTops} line(s), ground rgb(${ground.join(",")}), contrast ${c.toFixed(2)}`);
      if (SHOTS && (width === 393 || width === 1280)) await page.screenshot({ path: path.join(SHOTS, `${look}-toast-${width}.png`) }).catch(() => {});
      assert.ok(c >= 4.5, `the toast's words: contrast ${c.toFixed(2)} over rgb(${ground.join(",")}) (AA wants 4.5)`);
    });
  }
}

for (const look of ["glass", "legacy"]) {
  ui.test(`${look}: the tab bar's words read over a bright poster`, { viewport: { width: 393, height: 852 }, device: { screen: { width: 393, height: 852 }, deviceScaleFactor: 3, userAgent: IPHONE } }, async (h) => {
    const { page, signIn, goto } = h;
    const me = await setupProfile(h, look);
    await signIn(me);
    await goto("#/list");
    await addPoster(page);
    const bar = await page.evaluate(() => {
      const b = document.querySelector(".nav-items").getBoundingClientRect();
      const items = [...document.querySelectorAll(".nav-items > .nav-item")].filter((a) => a.getBoundingClientRect().width > 0 && a.textContent.trim());
      return {
        bottom: b.bottom,
        items: items.map((a) => {
          const ib = a.getBoundingClientRect();
          const r = document.createRange(); r.selectNodeContents(a);
          const tb = r.getBoundingClientRect();
          return {
            label: a.textContent.trim(), active: a.classList.contains("active"), tone: a.dataset.tone || "",
            box: { top: ib.top, bottom: ib.bottom, left: ib.left, right: ib.right },
            text: { top: tb.top, bottom: tb.bottom, left: tb.left, right: tb.right },
            color: getComputedStyle(a).color,
          };
        }),
      };
    });
    assert.ok(bar.bottom > 600, "the tab bar is not at the bottom");
    assert.ok(bar.items.length >= 4, "the tab bar's words are not on screen");
    const png = await shot(page);
    const low = [];
    let worst = Infinity;
    for (const it of bar.items) {
      // the ground right above and below each label, inside its own pill (as
      // wide as the word: the lit pill's rim light curves down at its ends)
      const ground = groundOf(png, { ...it.box, left: it.text.left, right: it.text.right }, it.text, 0);
      const c = ratio(over(parseColor(it.color), ground), ground);
      worst = Math.min(worst, c);
      if (REPORT) console.log(`  tab bar ${look} ${it.label}${it.active ? " (lit)" : ""}${it.tone ? ` tone=${it.tone}` : ""}: ground rgb(${ground.join(",")}), words ${it.color}, contrast ${c.toFixed(2)}`);
      if (c < 4.5) low.push(`${it.label}: ${c.toFixed(2)} over rgb(${ground.join(",")})`);
    }
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${look}-tabbar.png`), clip: { x: 0, y: 852 - 140, width: 393, height: 140 } }).catch(() => {});
    assert.deepEqual(low, [], `the tab bar's words under AA (4.5); the worst is ${worst.toFixed(2)}`);
  });
}

ui.run({ concurrency: 1 });
