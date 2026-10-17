// Subtitle timing repairs (media/subsync.js) — "subs are almost always out of
// sync, especially in Hebrew".
const test = require("node:test");
const assert = require("node:assert/strict");
const s = require("../src/media/subsync");

// A believable dialogue track: lines of 1-4 s with gaps of 0.3-6 s, seeded so
// every run is the same.
const track = (n = 400, seed = 7) => {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [];
  let t = 12;
  for (let i = 0; i < n; i++) {
    const len = 1 + rnd() * 3;
    out.push({ start: Math.round(t * 1000) / 1000, end: Math.round((t + len) * 1000) / 1000, text: `line ${i}` });
    t += len + 0.3 + rnd() * 5.7;
  }
  return out;
};

test("SRT and WebVTT parse to the same cues, and SRT round-trips", () => {
  const srt = "1\n00:00:01,500 --> 00:00:03,000\nHello\n\n2\n00:01:02,250 --> 00:01:04,000\nTwo\nlines\n";
  const vtt = "WEBVTT\n\n00:00:01.500 --> 00:00:03.000 line:90%\nHello\n\nid-2\n00:01:02.250 --> 00:01:04.000\nTwo\nlines\n";
  const a = s.parse(srt);
  assert.deepEqual(a, s.parse(vtt).map((c) => ({ ...c })));
  assert.deepEqual(a.map((c) => [c.start, c.end, c.text]), [[1.5, 3, "Hello"], [62.25, 64, "Two\nlines"]]);
  assert.deepEqual(s.parse(s.toSrt(a)), a);
});

test("WebVTT without hours (what ffmpeg writes for a track under an hour) parses", () => {
  const c = s.parse("WEBVTT\n\n00:02.000 --> 00:03.844\nOne\n\n59:04.616 --> 59:06.749\nTwo\n");
  assert.deepEqual(c.map((x) => [x.start, x.end]), [[2, 3.844], [3544.616, 3546.749]]);
});

test("retime moves every cue by scale and offset, and drops what falls before 0", () => {
  const c = [{ start: 1, end: 2, text: "a" }, { start: 10, end: 12, text: "b" }];
  assert.deepEqual(s.retime(c, 2, -3).map((x) => [x.start, x.end]), [[0, 1], [17, 21]]);
  assert.equal(s.retime(c, 1, -5).length, 1);
});

test("a track off by a constant is lined up against the video's own", () => {
  const ref = track();
  const sub = ref.map((c) => ({ ...c, start: c.start - 4.3, end: c.end - 4.3 }));
  const a = s.align(sub, ref);
  assert.equal(a.apply, true, a.why);
  assert.equal(a.scale, 1);
  assert.ok(Math.abs(a.offset - 4.3) < 0.05, `offset ${a.offset}`);
});

test("a track timed for the 25 fps release is found and brought back to 23.976", () => {
  const ref = track(600);
  // the PAL release runs 25/23.976 faster: every time is shorter by that ratio, plus a different lead-in
  const sub = ref.map((c) => ({ ...c, start: (c.start * 23.976) / 25 + 1.2, end: (c.end * 23.976) / 25 + 1.2 }));
  const a = s.align(sub, ref);
  assert.equal(a.apply, true, a.why);
  assert.ok(Math.abs(a.scale - 25 / 23.976) < 1e-9, `scale ${a.scale}`);
  const fixed = s.retime(sub, a.scale, a.offset);
  const worst = Math.max(...fixed.map((c, i) => Math.abs(c.start - ref[i].start)));
  assert.ok(worst < 0.1, `worst line off by ${worst}`);
});

test("a translation with its own line breaks still aligns (only some starts coincide)", () => {
  const ref = track(500);
  // keep 60 % of the lines, merge the rest away, and add 15 % lines of its own
  const sub = ref.filter((_, i) => i % 5 < 3).map((c) => ({ ...c, start: c.start + 2.5, end: c.end + 2.5 }));
  for (let i = 0; i < 75; i++) sub.push({ start: 20 + i * 37.3, end: 21 + i * 37.3, text: "extra" });
  const a = s.align(sub, ref);
  assert.equal(a.apply, true, a.why);
  assert.ok(Math.abs(a.offset + 2.5) < 0.05, `offset ${a.offset}`);
});

test("a track that is already right is left alone, and so is one with nothing in common", () => {
  const ref = track();
  const same = ref.map((c) => ({ ...c, start: c.start + 0.04, end: c.end + 0.04 }));
  const a = s.align(same, ref);
  assert.equal(a.apply, false);
  assert.equal(a.why, "already in time");
  const other = track(400, 99);
  assert.equal(s.align(other, ref).apply, false);
  assert.equal(s.align(ref.slice(0, 10), ref).apply, false, "too few lines to judge");
});

test("frame rate from the provider's word: only the PAL / film pairs", () => {
  assert.ok(Math.abs(s.fpsFactor(25, 23.976) - 25 / 23.976) < 1e-9);
  assert.ok(Math.abs(s.fpsFactor(23.976, 25) - 23.976 / 25) < 1e-9);
  assert.equal(s.fpsFactor(23.976, 23.976), 1);
  assert.equal(s.fpsFactor(30, 23.976), 1, "not a pair a subtitle is converted between");
  assert.equal(s.fpsFactor(null, 23.976), 1);
});

test("a track that runs past the film's end by the PAL ratio was timed for the slower release", () => {
  const dur = 6000;
  const cues = [{ start: 30, end: 33 }, { start: dur * (25 / 23.976) - 60, end: dur * (25 / 23.976) - 57 }];
  assert.ok(Math.abs(s.overrunFactor(cues, dur) - 23.976 / 25) < 1e-9);
  assert.equal(s.overrunFactor([{ start: 30, end: 33 }, { start: dur - 120, end: dur - 117 }], dur), 1);
});

test("Hebrew punctuation authored for players without bidi is put back — and a correct file is not touched", () => {
  const reversed = Array.from({ length: 30 }, (_, i) => `${i + 1}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},900\n${i % 2 ? ".שלום לכולם" : "?מה קורה"}\n`).join("\n");
  const r = s.fixRtlPunctuation(reversed);
  assert.ok(r.changed >= 30);
  assert.match(r.text, /שלום לכולם\./);
  assert.match(r.text, /מה קורה\?/);
  assert.doesNotMatch(r.text, /^\.ש/m);
  const correct = reversed.replace(/\.שלום לכולם/g, "שלום לכולם.").replace(/\?מה קורה/g, "מה קורה?");
  assert.equal(s.fixRtlPunctuation(correct).changed, 0);
  // a dialogue dash parked at the end goes back to the front
  const dashes = Array.from({ length: 25 }, () => "שלום -").join("\n");
  assert.match(s.fixRtlPunctuation(dashes).text, /^- שלום$/m);
});

test("repair: the reference wins; without one the provider's frame rate; nothing when nothing is known", () => {
  const ref = track(500);
  const pal = ref.map((c) => ({ ...c, start: (c.start * 23.976) / 25, end: (c.end * 23.976) / 25 }));
  const srt = s.toSrt(pal);
  const withRef = s.repair(srt, { fps: 23.976, duration: 4000, ref, subFps: 25 });
  assert.match(withRef.how.join(" "), /aligned to the video's own track/);
  const noRef = s.repair(srt, { fps: 23.976, duration: 4000, subFps: 25 });
  assert.match(noRef.how.join(" "), /frame rate 25 -> 23.976/);
  const fixed = s.parse(noRef.srt);
  assert.ok(Math.abs(fixed[100].start - ref[100].start) < 0.01);
  const nothing = s.repair(srt, {});
  assert.deepEqual(nothing.how, []);
  assert.equal(nothing.srt, srt, "untouched, byte for byte");
});
