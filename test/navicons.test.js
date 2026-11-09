// The phone website's More menu wears the Android phone app's icons
// (public/js/navicons.js, elia 2026-11-10: "on the side panel on web mobile put
// icons also"). Held together here, so neither side drifts:
//   - every line of the menu (js/navmore.js MENU and FOOT, and TAG) has an icon,
//     so a line added later cannot ship without one;
//   - each line wears the icon the app's More sheet gives the same place
//     (tv-native/src/phone/moreItems.ts), path for path as the app draws it
//     (tv-native/src/phone/ui/Icon.tsx, then tv-native/src/components/Icon.tsx);
//   - what the app mirrors for right-to-left, the website mirrors.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const load = () => import(pathToFileURL(path.join(ROOT, "public/js/navicons.js")).href);

// Search and Settings keep the website's own line glyphs (the tab bar's
// magnifier, the top bar's gear); the app has those two as well, by these names.
const WEB_OWN = { search: "navSearch", settings: "navGear" };

// The menu's ids, as navmore.js lists them.
const menuIds = () => {
  const src = read("public/js/navmore.js");
  const block = (name) => {
    const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(src);
    assert.ok(m, `${name} is in navmore.js`);
    return [...m[1].matchAll(/^\s*\["(\w+)", "/gm)].map((x) => x[1]);
  };
  const tag = /const TAG = \{([^}]*)\}/.exec(src);
  assert.ok(tag, "TAG is in navmore.js");
  return { menu: [...block("MENU"), ...block("FOOT")], tag: [...tag[1].matchAll(/(\w+): "more\./g)].map((x) => x[1]) };
};

// What a glyph is made of, as comparable strings: path data, rects, circles, stroke.
const parts = (s) => {
  const out = [];
  for (const m of s.matchAll(/\bd=["']([^"']+)["']/g)) out.push(`d:${m[1]}`);
  for (const m of s.matchAll(/<rect\b([^>]*)>/gi)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)=["']([^"']+)["']/g)].map((x) => [x[1], x[2]]));
    out.push(`rect:${a.x},${a.y},${a.width},${a.height},${a.rx || 0}`);
  }
  return out.sort();
};

// The app's glyph for an icon name, the way its Icon component resolves it:
// the phone's LINE set, then its EXTRA set, then the TV's (the site's) set.
const appGlyph = (name) => {
  const phone = read("tv-native/src/phone/ui/Icon.tsx");
  const line = new RegExp(`\\b${name}: \\{\\s*w: ([\\d.]+),\\s*(?:circle: \\[([^\\]]+)\\],\\s*)?d: '([^']+)'`).exec(phone);
  if (line) return { kind: "line", w: line[1], circle: line[2] ? line[2].split(/,\s*/).join(",") : null, parts: [`d:${line[3]}`] };
  const extra = /const EXTRA = \{([\s\S]*?)\n\};/.exec(phone);
  assert.ok(extra, "EXTRA is in the phone's Icon.tsx");
  const e = new RegExp(`^\\s+${name}:\\s*'([^']+)'`, "m").exec(extra[1]);
  if (e) return { kind: "fill", parts: [`d:${e[1]}`] };
  const tv = read("tv-native/src/components/Icon.tsx");
  const at = tv.indexOf(`case '${name}':`);
  assert.ok(at >= 0, `the app has no icon called "${name}"`);
  const next = tv.indexOf("case '", at + 6);
  const chunk = tv.slice(at, next < 0 ? undefined : next);
  return { kind: "fill", parts: parts(chunk.replace(/<Rect/g, "<rect")) };
};

// The app's More sheet: which icon each line wears.
const appMore = () => {
  const src = read("tv-native/src/phone/moreItems.ts");
  return Object.fromEntries([...src.matchAll(/\{key: '(\w+)',[^}]*?icon: '(\w+)'/g)].map((m) => [m[1], m[2]]));
};

test("every line of the More menu has an icon", async () => {
  const { NAV_ICONS, navIcon } = await load();
  const { menu, tag } = menuIds();
  assert.ok(menu.length >= 20, `the menu lists ${menu.length} lines`);
  assert.deepEqual([...tag].sort(), [...menu].sort(), "TAG names every line of MENU and FOOT");
  for (const id of menu) {
    const svg = navIcon(id);
    assert.ok(svg.startsWith("<svg ") && svg.endsWith("</svg>"), `${id}: no icon (add it to public/js/navicons.js)`);
    assert.match(svg, /aria-hidden="true"/, `${id}: the icon is read out`);
    assert.match(svg, /viewBox="0 0 24 24"/, `${id}: not in the 24×24 box`);
    assert.match(svg, /currentColor/, `${id}: not drawn in the line's colour`);
    assert.doesNotMatch(svg, /<svg[^>]*\s(width|height)=/, `${id}: the size is the stylesheet's, not the glyph's`);
  }
  assert.deepEqual(Object.keys(NAV_ICONS).filter((k) => !menu.includes(k)), [], "no icon for a line that is gone");
});

test("each line wears the app's icon for that place, path for path", async () => {
  const { NAV_ICONS } = await load();
  const app = appMore();
  assert.ok(Object.keys(app).length >= 20, "the app's More lines are read");
  for (const [id, [name, svg]] of Object.entries(NAV_ICONS)) {
    assert.ok(app[id], `${id}: the app's More sheet has no such line`);
    assert.equal(name, WEB_OWN[id] || app[id], `${id}: the app's line wears "${app[id]}"`);
    const want = appGlyph(name);
    assert.deepEqual(parts(svg), want.parts.sort(), `${id}: not the app's "${name}"`);
    if (want.kind === "line") {
      assert.match(svg, new RegExp(`fill="none" stroke="currentColor" stroke-width="${want.w}"`), `${id}: the app draws "${name}" as a ${want.w} line`);
      if (want.circle) {
        const [cx, cy, r] = want.circle.split(",");
        assert.match(svg, new RegExp(`<circle cx="${cx}" cy="${cy}" r="${r}"/>`), `${id}: the circle of "${name}"`);
      }
    } else {
      assert.match(svg, /fill="currentColor"/, `${id}: the app's "${name}" is a filled glyph`);
    }
  }
});

test("what the app turns round for right-to-left, the website turns round", async () => {
  const { NAV_ICONS, MIRRORED } = await load();
  const m = /const MIRRORED = new Set<string>\(\[([^\]]*)\]\)/.exec(read("tv-native/src/phone/ui/Icon.tsx"));
  assert.ok(m, "MIRRORED is in the phone's Icon.tsx");
  const appMirrored = new Set([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]));
  for (const [id, [name]] of Object.entries(NAV_ICONS)) assert.equal(MIRRORED.has(id), appMirrored.has(name), `${id} (${name})`);
});
