// Two household reports (2026-11-09), held across the server, the website and the
// TV / phone app (tv-native) — the cross-tree halves the TV's jest tests cannot read
// without widening the tv-native CI job's gate:
//
//  - Bigmakdaddy, "stream opened when it shouldn't have": a plain Play on a title
//    not on the server streamed it from the torrent. Play on such a title is the
//    website's "Save & watch" on every client, and the title pages build no
//    torrent play item (tv-native play-best.test.ts holds the TV / phone side).
//  - Jesse, "Problem with this copy: Other": Other now asks for a few words first;
//    "No — just send it" files a report whose first line is the server's own line
//    for a replacement, so the admin reads both the same way.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("Play on a title not on the server: the website's Save & watch is the TV's and the phone's word", () => {
  assert.match(read("public/js/screens/discover-detail.js"), /<span>Save &amp; watch<\/span>/);
  assert.match(read("tv-native/src/playBest.ts"), /export const SAVE_WATCH = 'Save & watch';/);
  for (const f of ["tv-native/src/screens/Detail.tsx", "tv-native/src/phone/screens/Detail.tsx"]) {
    const src = read(f);
    assert.match(src, /SAVE_WATCH/, `${f} says Save & watch`);
    assert.doesNotMatch(src, /streamPlayItem|\/stream\/torrent\//, `${f} builds no torrent play item`);
  }
});

test("\"Other → No, just send it\": its report starts with the server's own line for a replacement", () => {
  const server = read("src/media/replace.js");
  assert.ok(server.includes('text: `Problem with this copy: ${label}${cleanNote ? ` — ${cleanNote}` : ""}'), "the server's line");
  const tv = read("tv-native/src/replaceLogic.ts");
  const web = read("public/js/replaceCopy.js");
  for (const [name, src] of [["tv", tv], ["web", web]]) {
    assert.ok(src.includes("`Problem with this copy: ${") && src.includes("No other version asked for — the copy stays.`"), `${name}: the same report text`);
  }
  // the report keeps the words in its context too (routes/reports.js), as the request does
  assert.match(read("src/routes/reports.js"), /note: clean\(ctx\.note, 300\)/);
  assert.match(server, /itemId: s\.libraryId, note: cleanNote/);
});
