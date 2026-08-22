// External subtitles: Hebrew and English only, correct encoding, and a ZIP
// reader written by hand (Wizdom serves archives). Each of these fails silently
// in production — a wrong language filter just quietly adds Portuguese, a bad
// decode gives a screen of question marks — so they are pinned here.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const websubs = require("../src/media/websubs");
const { langOf, decode, firstSubtitleInZip } = websubs._internals;

// ---------- the language policy ----------

test("only Hebrew and English are recognised", () => {
  for (const code of ["heb", "he", "iw", "Hebrew", "HE"]) {
    assert.equal(langOf(code) && langOf(code).key, "heb", `${code} is Hebrew`);
  }
  for (const code of ["eng", "en", "English", "EN-US"]) {
    assert.equal(langOf(code) && langOf(code).key, "eng", `${code} is English`);
  }
});

test("every other language is rejected outright", () => {
  const others = ["fre", "fr", "spa", "es", "ara", "ar", "rus", "por", "ger", "de",
    "ita", "pol", "tur", "chi", "jpn", "kor", "dut", "swe", "", null, undefined];
  for (const code of others) {
    assert.equal(langOf(code), null, `${code} must not be offered`);
  }
});

test("the server advertises exactly two languages", () => {
  assert.deepEqual(websubs.LANGS.map((l) => l.key), ["heb", "eng"]);
  assert.ok(websubs.PER_LANG >= 5, "at least five tracks per language were asked for");
});

// ---------- encoding ----------

test("UTF-8 subtitles come through unchanged", () => {
  const text = "1\n00:00:01,000 --> 00:00:02,000\nשלום עולם\n";
  assert.equal(decode(Buffer.from(text, "utf8")), text);
});

test("a UTF-8 BOM is stripped", () => {
  const text = "WEBVTT\n\n";
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  assert.equal(decode(withBom), text);
});

test("Windows-1255 Hebrew is decoded, not mangled", () => {
  // "שלום" in Windows-1255 — the encoding half the Hebrew catalogue uses.
  const cp1255 = Buffer.from([0xf9, 0xec, 0xe5, 0xed]);
  const out = decode(cp1255);
  assert.equal(out, "שלום");
  assert.ok(!out.includes("�"), "no replacement characters");
});

test("Hebrew that is not valid UTF-8 never yields replacement characters", () => {
  const cp1255Line = Buffer.from([0xe0, 0xe1, 0xe2, 0xe3, 0x20, 0xf9, 0xec, 0xe5, 0xed]);
  const out = decode(cp1255Line);
  assert.equal(out.includes("�"), false);
  assert.match(out, /[֐-׿]/, "decodes to actual Hebrew letters");
});

// ---------- the ZIP reader ----------

// Build a real (tiny) ZIP so the reader is tested against the format, not a mock.
const makeZip = (entries) => {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, content, store } of entries) {
    const raw = Buffer.from(content, "utf8");
    const data = store ? raw : zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(store ? 0 : 8, 8);   // method
    local.writeUInt32LE(data.length, 18);    // compressed size
    local.writeUInt32LE(raw.length, 22);     // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([local, nameBuf, data]));

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
};

test("a deflated subtitle is extracted from a ZIP", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nשלום\n";
  const zip = makeZip([{ name: "movie.heb.srt", content: srt }]);
  assert.equal(decode(firstSubtitleInZip(zip)), srt);
});

test("a stored (uncompressed) subtitle is extracted too", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nhello\n";
  const zip = makeZip([{ name: "a.srt", content: srt, store: true }]);
  assert.equal(decode(firstSubtitleInZip(zip)), srt);
});

test("the subtitle is found past other files in the archive", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nfound me\n";
  const zip = makeZip([
    { name: "readme.txt", content: "ignore me" },
    { name: "poster.nfo", content: "also ignore" },
    { name: "subs/movie.srt", content: srt },
  ]);
  assert.match(decode(firstSubtitleInZip(zip)), /found me/);
});

test("an archive with no subtitle fails loudly", () => {
  const zip = makeZip([{ name: "readme.txt", content: "nothing here" }]);
  assert.throws(() => firstSubtitleInZip(zip), /no subtitle/i);
});

test("something that isn't a ZIP fails loudly", () => {
  assert.throws(() => firstSubtitleInZip(Buffer.from("<html>404</html>")), /not a zip/i);
});

// ---------- writing sidecars ----------

const tmpVideo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subs-test-"));
  const file = path.join(dir, "Some Show S01E01.mkv");
  fs.writeFileSync(file, "not really a video");
  return file;
};


// A believable subtitle: enough cues to pass the "is this real?" check, and
// Hebrew letters when it claims to be Hebrew.
const fakeSrt = (lang, seed) => {
  const line = lang === "Hebrew"
    ? `זאת שורת כתובית לבדיקה מספר ${seed}`
    : `this is a test subtitle line number ${seed}`;
  let out = "";
  for (let i = 1; i <= 8; i++) {
    out += `${i}
00:0${i}:00,000 --> 00:0${i}:02,000
${line} ${i}

`;
  }
  return out;
};

const track = (lang, ref) => ({
  provider: "os", ref, lang: lang === "Hebrew" ? "heb" : "eng", langName: lang, label: lang,
});

test("identical subtitles are written once, however many providers list them", async () => {
  const video = tmpVideo();
  const same = fakeSrt("Hebrew", "identical");
  const res = await websubs.writeSidecars(
    [track("Hebrew", "a"), track("Hebrew", "b"), track("Hebrew", "c")],
    video,
    { fetch: async () => same }
  );
  assert.equal(res.written.length, 1, "one distinct file");
  assert.equal(res.duplicates, 2, "the other two were the same bytes");
  fs.rmSync(path.dirname(video), { recursive: true, force: true });
});

test("distinct subtitles are numbered per language", async () => {
  const video = tmpVideo();
  let n = 0;
  const res = await websubs.writeSidecars(
    [track("Hebrew", "a"), track("Hebrew", "b"), track("English", "c")],
    video,
    { fetch: async (t) => fakeSrt(t.langName, ++n) }
  );
  const names = res.written.sort();
  assert.equal(names.length, 3);
  assert.ok(names.some((f) => f.endsWith(".Hebrew.srt")), names.join(","));
  assert.ok(names.some((f) => f.endsWith(".Hebrew 2.srt")), names.join(","));
  assert.ok(names.some((f) => f.endsWith(".English.srt")), names.join(","));
  fs.rmSync(path.dirname(video), { recursive: true, force: true });
});

test("an existing sidecar is left alone unless forced", async () => {
  const video = tmpVideo();
  const body = fakeSrt("Hebrew", "original");
  await websubs.writeSidecars([track("Hebrew", "a")], video, { fetch: async () => body });
  const file = path.join(path.dirname(video), "Some Show S01E01.Hebrew.srt");
  fs.writeFileSync(file, "MINE - do not overwrite".padEnd(200, "."));

  const second = await websubs.writeSidecars([track("Hebrew", "a")], video, { fetch: async () => body });
  assert.equal(second.written.length, 0, "no overwrite by default");
  assert.match(fs.readFileSync(file, "utf8"), /do not overwrite/);

  await websubs.writeSidecars([track("Hebrew", "a")], video, { fetch: async () => body, force: true });
  assert.match(fs.readFileSync(file, "utf8"), /original/, "--force replaces it");
  fs.rmSync(path.dirname(video), { recursive: true, force: true });
});

test("junk from a provider is not written to the library", async () => {
  const video = tmpVideo();
  const res = await websubs.writeSidecars(
    [track("Hebrew", "a"), track("Hebrew", "b")],
    video,
    { fetch: async (t) => (t.ref === "a" ? "404 not found" : null) } // too short / nothing
  );
  assert.equal(res.written.length, 0, "an error page is not a subtitle");
  fs.rmSync(path.dirname(video), { recursive: true, force: true });
});

test("a provider that throws doesn't lose the tracks that worked", async () => {
  const video = tmpVideo();
  const good = fakeSrt("English", "fine");
  const res = await websubs.writeSidecars(
    [track("Hebrew", "boom"), track("English", "ok")],
    video,
    { fetch: async (t) => { if (t.ref === "boom") throw new Error("provider down"); return good; } }
  );
  assert.equal(res.written.length, 1);
  assert.ok(res.written[0].endsWith(".English.srt"));
  fs.rmSync(path.dirname(video), { recursive: true, force: true });
});

// ---------- formats that arrive wearing an .srt name ----------
//
// A real library turned up three of these, and every one of them is unplayable
// if stored as-is: MicroDVD (frame-based), SubStation, and files whose language
// simply isn't what the provider said it was.

const { toSrt, rejectReason, microDvdToSrt, subStationToSrt } = websubs._internals;

test("MicroDVD is converted to SRT", () => {
  const micro = "{0}{0}25\n{25}{75}שורה ראשונה\n{100}{150}שורה שנייה|המשך\n";
  const srt = toSrt(micro);
  assert.match(srt, /-->/, "has real timestamps now");
  // 25 frames at the declared 25 fps is exactly one second.
  assert.match(srt, /00:00:01,000 --> 00:00:03,000/);
  assert.match(srt, /המשך/, "the | line break is kept as a second line");
});

test("MicroDVD without a declared frame rate still converts", () => {
  const srt = toSrt("{24}{48}hello\n{100}{200}world\n");
  assert.match(srt, /-->/);
  assert.equal((srt.match(/-->/g) || []).length, 2);
});

test("SubStation (.ass/.ssa) is converted to SRT", () => {
  const ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\i1}שלום עולם{\i0}",
    "Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,line two\\Nsecond half",
  ].join("\n");
  const srt = toSrt(ass);
  assert.match(srt, /00:00:01,000 --> 00:00:03,500/);
  assert.match(srt, /שלום עולם/, "style overrides are stripped, text kept");
  assert.match(srt, /line two\nsecond half/, "a literal backslash-N becomes a real line break");
});

test("SRT passes through untouched", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nalready fine\n";
  assert.equal(toSrt(srt), srt);
});

test("something that isn't a subtitle at all converts to nothing", () => {
  assert.equal(toSrt("<html><body>404</body></html>"), "");
  assert.equal(toSrt(""), "");
});

test("a track claiming Hebrew but containing none is refused", () => {
  const english = Array.from({ length: 8 }, (_, i) =>
    `${i + 1}\n00:0${i}:00,000 --> 00:0${i}:02,000\nthis line is in english\n`).join("\n");
  assert.match(rejectReason(english, "heb"), /Hebrew/);
  assert.equal(rejectReason(english, "eng"), null, "the same file is fine as English");
});

test("a track claiming English but written in Hebrew is refused", () => {
  const hebrew = Array.from({ length: 8 }, (_, i) =>
    `${i + 1}\n00:0${i}:00,000 --> 00:0${i}:02,000\nזאת שורה בעברית בלבד\n`).join("\n");
  assert.match(rejectReason(hebrew, "eng"), /English/);
  assert.equal(rejectReason(hebrew, "heb"), null);
});

test("a near-empty signs-only track is refused", () => {
  const twoCues = "1\n00:00:46,416 --> 00:00:49,916\nBA SING SE\n\n2\n00:17:36,125 --> 00:17:39,708\nBLOOD FROM A STONE\n";
  assert.match(rejectReason(twoCues, "eng"), /cue/);
});
