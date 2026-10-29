// The /install page's server side (src/lib/installpage.js): release-note
// headlines, the household scrub, the TV/website split — and the QR encoder
// the page draws its code with (public/js/qr.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { _internals: ip } = require("../src/lib/installpage");

test("a bullet's headline: the bold lead, no parentheses, one sentence, a full stop", () => {
  assert.equal(ip.headline("**A memory leak in the website player is fixed.** When the line was slow…"), "A memory leak in the website player is fixed.");
  assert.equal(ip.headline("**Saving offline (measured: 3 s) can't stall**"), "Saving offline can't stall.");
  assert.equal(ip.headline("Asking for a download files it as an episode. An unknown type is refused."), "Asking for a download files it as an episode.");
  assert.equal(ip.headline("the side menu opens — and closes"), "The side menu opens.");
  assert.ok(ip.headline("x".repeat(400)).length <= 171);
});

test("a TV bullet's headline: what it says after its version, whatever the shape", () => {
  assert.equal(ip.tvHeadline("**Aurora TV 5.7.1** (checked on the Mi TV, also with sign-in required): the TV player now recovers by itself — after an error…"), "The TV player now recovers by itself.");
  assert.equal(ip.tvHeadline("**Aurora TV 5.1.25 — smoother on weak boxes, honest on a bad connection.** Tested on…"), "Smoother on weak boxes, honest on a bad connection.");
  assert.equal(ip.tvHeadline("Aurora TV 5.1.22: the logo in the side rail is larger (elia: it read as low-res)."), "The logo in the side rail is larger.");
  assert.equal(ip.tvVersionIn("**Aurora TV 5.6.0** (checked…)"), "5.6.0");
});

const words = (names = [], titles = []) => ({ ready: true, names: names.map((n) => ip.wordRe(n, "iu")), titles: titles.map((t) => ip.wordRe(t, "u")) });

test("the scrub: a headline naming a profile or a library title is dropped whole", () => {
  const w = words(["Dor", "Watcher"], ["Silo", "The Last Airbender"]);
  const kept = ip.scrub([
    "Subtitles no longer hold the picture.",
    "On Silo every intro is now found.",
    "The Last Airbender's false Skip recap is gone.",
    "Asked for by dor.",
    "Door handles are fine.", // (a word, not the name)
    "Zev's report from a Chromecast is answered.",
    "A measuring kit ships in tools/webperf.",
  ], w);
  assert.deepEqual(kept, ["Subtitles no longer hold the picture.", "Door handles are fine."]);
});

test("the notes: TV releases from their bullets (with their indented points), the website's without them", () => {
  const releases = ip.parseChangelog([
    "# Changelog",
    "## 1.2.0 — 2026-10-02",
    "- **Faster Home.** More words.",
    "- **Aurora TV 5.3.0** (checked on the TV):",
    "  - **Smoother.** Rows are native.",
    "  - **One press to play**: Play starts the best source.",
    "- **Aurora TV 5.2.0.** Checked on the Mi TV.",
    "## 1.1.0 — 2026-10-01",
    "- On Silo every intro is found.",
    "- **Aurora TV 5.1.0: the TV app.**",
  ].join("\n"));
  const n = ip.notesFrom(releases, words([], ["Silo"]));
  assert.deepEqual(n.web, [{ version: "1.2.0", date: "2026-10-02", items: ["Faster Home."] }]);
  assert.deepEqual(n.tv.map((r) => r.version), ["5.3.0", "5.2.0", "5.1.0"]);
  assert.deepEqual(n.tv[0].items, ["Smoother.", "One press to play."]);
  assert.deepEqual(n.tv[1].items, [], "a note that only says it was checked says nothing new");
  assert.deepEqual(n.tvShown.map((r) => r.version), ["5.3.0", "5.1.0"]);
  assert.equal(n.tv[2].date, "2026-10-01");
});

test("dates read like dates", () => {
  assert.equal(ip.fmtDate("2026-10-28"), "October 28, 2026");
  assert.equal(ip.fmtDate("soon"), "soon");
});

// ---------- the QR encoder ----------
const qr = () => import("../public/js/qr.js");

test("QR: the function patterns are where the standard puts them, the size follows the length", async () => {
  const { qrMatrix } = await qr();
  for (const [text, size] of [["http://a.b/download", 25], ["http://192.168.50.10:4000/download", 29], ["https://" + "x".repeat(120) + "/download", 49]]) {
    const m = qrMatrix(text, "M");
    assert.equal(m.length, size, `${text.length} bytes`);
    // the three finders: a dark 7x7 ring, a light ring, a dark 3x3 core
    for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      for (let i = 0; i < 7; i++) {
        assert.ok(m[y0][x0 + i] && m[y0 + 6][x0 + i] && m[y0 + i][x0] && m[y0 + i][x0 + 6], "the finder's outer ring");
      }
      assert.ok(!m[y0 + 1][x0 + 1] && m[y0 + 3][x0 + 3], "the finder's light ring and core");
    }
    // the timing lines
    for (let i = 8; i < size - 8; i++) assert.equal(m[6][i], i % 2 === 0, "the timing line");
    // the dark module
    assert.equal(m[size - 8][8], true);
  }
});

test("QR: the drawing for a known address does not change (checked against a camera decoder when written)", async () => {
  const { qrMatrix, qrSvg } = await qr();
  const m = qrMatrix("http://192.168.50.10:4000/download", "M");
  const bits = m.map((r) => r.map((v) => (v ? 1 : 0)).join("")).join("\n");
  // (decoded with OpenCV's QRCodeDetector to exactly this text, 2026-10-28)
  assert.equal(crypto.createHash("sha256").update(bits).digest("hex").slice(0, 16), EXPECTED);
  const svg = qrSvg("http://192.168.50.10:4000/download", { label: 'a "quoted" <label>' });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 37 37"[^>]*aria-label="a &quot;quoted&quot; &lt;label&gt;"/);
  assert.throws(() => qrMatrix("x".repeat(400)), /too long/);
});
const EXPECTED = "eb39b898a5099095";
