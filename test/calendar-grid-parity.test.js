// The Calendar's month grid says the same words and follows the same rules on
// the website (public/js/calgrid.js, screens/calendar.js, the --k-* colours in
// components.css) and in the TV and phone apps (tv-native/src/calendar.ts):
// the words and colours are read from the apps' source and compared; the
// website's helpers are run against the cases tv-native/__tests__/logic/
// calendar-grid.test.ts pins for the apps.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const web = () => import(pathToFileURL(path.join(ROOT, "public/js/calgrid.js")).href);

// `export const NAME = { a: 'x', … } as const;` → { a: "x" }
const tsObject = (src, name) => {
  const m = new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\} as const;`).exec(src);
  assert.ok(m, `${name} is in tv-native/src/calendar.ts`);
  const out = {};
  for (const x of m[1].matchAll(/(\w+):\s*(['"])(.*?)\2/g)) out[x[1]] = x[3];
  return out;
};

test("the month view's words are the same on the website and in the apps", async () => {
  const { CAL_WORDS, KINDS } = await web();
  const ts = read("tv-native/src/calendar.ts");
  assert.deepEqual(tsObject(ts, "CAL_WORDS"), CAL_WORDS);
  assert.match(ts, new RegExp(`export const KINDS = \\[${KINDS.map((k) => `'${k}'`).join(", ")}\\] as const;`));
  // the legend's film words are the server's own
  const server = read("src/media/calendar.js");
  assert.ok(server.includes(`"${CAL_WORDS.cinema}"`) && server.includes(`"${CAL_WORDS.home}"`));
  assert.ok(server.includes(`"${CAL_WORDS.have}"`));
  // the TV's and the phone's screens print them from calendar.ts, never their own spelling
  for (const f of ["tv-native/src/screens/CalendarMonth.tsx", "tv-native/src/phone/ui/CalendarGrid.tsx"]) {
    const code = read(f).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join(" ");
    for (const w of ["Next up", "Previous month", "Next month", "Out to stream or buy"]) assert.ok(!code.includes(`'${w}'`), `${f} spells "${w}" itself`);
  }
});

test("the kinds' colours: the website's CSS, its helper and the apps agree", async () => {
  const { KIND_COLORS } = await web();
  assert.deepEqual(tsObject(read("tv-native/src/calendar.ts"), "KIND_COLORS"), KIND_COLORS);
  const css = read("public/css/components.css");
  for (const k of ["premiere", "cinema", "home", "have"]) {
    assert.ok(css.includes(`--k-${k}: ${KIND_COLORS[k]};`), `--k-${k} is ${KIND_COLORS[k]}`);
  }
  assert.equal(KIND_COLORS.episode, "#8b7bff"); // the accent (--k-episode: var(--accent))
});

test("the website's helpers hold the apps' cases", async () => {
  const { monthWeeks, firstPick, monthPick, cellOf } = await web();
  const sun = monthWeeks("2026-11", 0);
  assert.equal(sun.length, 5);
  assert.deepEqual([sun[0][0], sun[4][6]], ["2026-11-01", "2026-12-05"]);
  const mon = monthWeeks("2026-11", 1);
  assert.equal(mon.length, 6);
  assert.deepEqual([mon[0][0], mon[0][6], mon[5][6]], ["2026-10-26", "2026-11-01", "2026-12-06"]);
  assert.equal(monthWeeks("2026-02", 0).length, 4);
  assert.equal(monthWeeks("2026-08", 6)[0][0], "2026-08-01");

  const byDay = {};
  for (let t = Date.parse("2026-09-25T00:00:00Z"); t <= Date.parse("2027-02-14T00:00:00Z"); t += 86400000) {
    byDay[new Date(t).toISOString().slice(0, 10)] = { label: "", date: null, items: [] };
  }
  const m = (key, last) => ({ key, first: `${key}-01`, last });
  const grid = { byDay, to: "2027-02-14", months: [m("2026-10", "2026-10-31"), m("2026-11", "2026-11-30"), m("2026-12", "2026-12-31"), m("2027-01", "2027-01-31")] };
  const cal = (days) => {
    const g = { ...grid, byDay: { ...byDay } };
    for (const d of days) g.byDay[d] = { label: "", date: null, items: [{ key: d }] };
    return { today: "2026-11-09", grid: g };
  };
  assert.equal(firstPick(cal(["2026-11-09", "2026-11-11"])), "2026-11-09");
  assert.equal(firstPick(cal(["2026-11-02", "2026-11-11"])), "2026-11-11");
  assert.equal(firstPick(cal(["2026-12-20"])), "2026-12-20");
  assert.equal(firstPick(cal(["2026-11-02"])), "2026-11-09");
  assert.equal(monthPick(grid, "2026-10-31", "2026-11", "2026-11-09"), "2026-11-09");
  assert.equal(monthPick(grid, "2026-12-31", "2026-10", "2026-11-09"), "2026-10-31");
  assert.equal(monthPick(grid, "2027-01-31", "2026-12", "2026-11-09"), "2026-12-31");
  assert.equal(monthPick(grid, "2026-12-15", "2026-11", "2026-11-09", true), "2026-11-15");
  const c = cellOf(cal(["2026-11-09"]).grid, "2026-11-09", "2026-11", "2026-11-09");
  assert.deepEqual([c.n, c.inMonth, c.past, c.today, c.items.length], [9, true, false, true, 1]);
});
