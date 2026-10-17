// Subtitle TIMING repairs for files that come from the outside world.
//
// "Subs are almost always out of sync, especially in Hebrew" (the admin
// inbox, 2026-10). The player's clock is right on every path (measured with
// tools/subs-rig, docs/qa/subtitles/REPORT.md); what is wrong is the FILE: the
// providers' subtitles are timed for whichever release their uploader had —
// another frame rate (a 25 fps PAL release runs 4.3 % faster than the 23.976
// film, so its subtitles drift a minute and a half over two hours), another
// cut, another lead-in. Hebrew suffers most because most Hebrew tracks come
// from one catalogue (Wizdom) that lists every release it ever had, in no
// useful order.
//
// What can be told SAFELY, from the file's own evidence, is repaired here:
//
//   align()       against a track that is right by definition — one the video
//                 file itself carries (any language: dialogue starts where it
//                 starts, translations mostly keep the original's timing).
//                 Finds the frame-rate ratio and the constant offset that line
//                 the cue starts up, and only answers when the match is strong
//                 and clearly better than leaving the file as it is.
//   fpsFactor()   from the provider's own word (OpenSubtitles says which frame
//                 rate a file was timed for) when it is the PAL / film pair and
//                 the video's rate is known.
//   overrunFactor() a track that runs PAST the end of the video by about the
//                 PAL speed-up was timed for the PAL release.
//   fixRtlPunctuation() Hebrew/Arabic files authored for players without
//                 bidirectional text put the full stop at the START of the line
//                 so it would show at the end; on a real renderer it then shows
//                 at the wrong end. Moved back, only when most lines do it.
//
// PURE: text in, text out (test/subsync.test.js).

// ---------- SRT in and out ----------

// hh:mm:ss,mmm (SRT) and hh:mm:ss.mmm / mm:ss.mmm (WebVTT — ffmpeg writes a
// track shorter than an hour without the hours)
const TIME = /(?:(\d{1,3}):)?(\d{2}):(\d{2})[,.](\d{1,3})/;
const toSec = (h, m, s, ms) => +(h || 0) * 3600 + +m * 60 + +s + +String(ms).padEnd(3, "0") / 1000;
const fmt = (sec, sep = ",") => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
};

// SRT or WebVTT -> [{ start, end, text }] (in file order)
const parse = (text) => {
  const out = [];
  for (const block of String(text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n+/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->");
    const ma = TIME.exec(a);
    const mb = TIME.exec(b || "");
    if (!ma || !mb) continue;
    out.push({ start: toSec(ma[1], ma[2], ma[3], ma[4]), end: toSec(mb[1], mb[2], mb[3], mb[4]), text: lines.slice(at + 1).join("\n").replace(/\s+$/, "") });
  }
  return out;
};

const toSrt = (cues) => cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`).join("\n");

// Every time t becomes t * scale + offset (cues pushed before 0 are dropped).
const retime = (cues, scale = 1, offset = 0) =>
  cues
    .map((c) => ({ ...c, start: c.start * scale + offset, end: c.end * scale + offset }))
    .filter((c) => c.end > 0)
    .map((c) => ({ ...c, start: Math.max(0, c.start) }));

// ---------- against a reference track ----------

// Frame-rate ratios a subtitle can be out by: PAL vs film, PAL vs 24, 24 vs film.
const SCALES = [1, 25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25, 24 / 23.976, 23.976 / 24];
const TOL = 0.3; // a cue start within this of a reference start is the same line

const nearestWithin = (sorted, x, tol) => {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  const cand = [sorted[lo], sorted[lo - 1]].filter((v) => v != null);
  return cand.some((v) => Math.abs(v - x) <= tol);
};
const matches = (subStarts, ref, scale, offset) => {
  let n = 0;
  for (const s of subStarts) if (nearestWithin(ref, s * scale + offset, TOL)) n++;
  return n;
};

// The (scale, offset) that best lines `sub` up with `ref` (cue lists), or a
// verdict that the file is fine / that nothing can be said.
//   -> { apply: bool, scale, offset, matched, identity, total, why }
const align = (sub, ref, { maxShift = 600 } = {}) => {
  const subStarts = sub.map((c) => c.start).filter((t) => t >= 0).sort((a, b) => a - b);
  const refStarts = ref.map((c) => c.start).filter((t) => t >= 0).sort((a, b) => a - b);
  const total = subStarts.length;
  if (total < 30 || refStarts.length < 30) return { apply: false, why: "too few cues to judge", total };
  const identity = matches(subStarts, refStarts, 1, 0);
  // sample the subtitle's starts (a two-hour film has ~1500): plenty to vote
  const step = Math.max(1, Math.floor(total / 400));
  const sample = subStarts.filter((_, i) => i % step === 0);
  let best = { matched: -1 };
  for (const scale of SCALES) {
    const votes = new Map();
    let j0 = 0;
    for (const s of sample) {
      const x = s * scale;
      while (j0 < refStarts.length && refStarts[j0] < x - maxShift) j0++;
      for (let j = j0; j < refStarts.length && refStarts[j] <= x + maxShift; j++) {
        const bin = Math.round((refStarts[j] - x) * 10); // 0.1 s bins
        votes.set(bin, (votes.get(bin) || 0) + 1);
      }
    }
    // the peak, smoothed over its neighbours
    let peak = null;
    let peakVotes = -1;
    for (const [bin, v] of votes) {
      const sm = v + (votes.get(bin - 1) || 0) + (votes.get(bin + 1) || 0);
      if (sm > peakVotes) { peakVotes = sm; peak = bin; }
    }
    if (peak == null) continue;
    // refine: the median of the differences that voted for the peak
    const near = [];
    let k0 = 0;
    for (const s of sample) {
      const x = s * scale + peak / 10;
      while (k0 < refStarts.length && refStarts[k0] < x - 0.25) k0++;
      for (let k = k0; k < refStarts.length && refStarts[k] <= x + 0.25; k++) near.push(refStarts[k] - s * scale);
    }
    near.sort((a, b) => a - b);
    const offset = near.length ? near[Math.floor(near.length / 2)] : peak / 10;
    const matched = matches(sample, refStarts, scale, offset);
    if (matched > best.matched) best = { scale, offset, matched };
  }
  // the winner, counted over every cue
  best.matched = matches(subStarts, refStarts, best.scale, best.offset);
  const out = { scale: best.scale, offset: Math.round(best.offset * 1000) / 1000, matched: best.matched, identity, total };
  // (the reference may have fewer lines than the subtitle — an SDH track
  // against a plain one — so "strong" is counted against the smaller)
  const strong = best.matched >= Math.max(30, Math.min(total, refStarts.length) * 0.3);
  const better = best.matched >= identity * 1.2 + 10;
  const worth = best.scale !== 1 || Math.abs(best.offset) >= 0.2;
  if (!strong) return { ...out, apply: false, why: "no strong match with the reference" };
  if (!worth || !better) return { ...out, apply: false, why: "already in time" };
  return { ...out, apply: true, why: best.scale !== 1 ? "frame rate and offset" : "constant offset" };
};

// ---------- from metadata ----------

const isPalFilmPair = (a, b) => {
  const r = a / b;
  return SCALES.slice(1).some((s) => Math.abs(r - s) < 0.002);
};

// The provider timed this for `subFps`; the video runs at `videoFps`.
// -> the factor to multiply its times by, or 1.
const fpsFactor = (subFps, videoFps) => {
  const a = Number(subFps);
  const b = Number(videoFps);
  if (!(a > 10 && b > 10)) return 1;
  return isPalFilmPair(a, b) ? a / b : 1;
};

// A track that ends well after the film does, by about a frame-rate ratio, was
// timed for a slower release: -> the factor that brings it back, or 1.
const overrunFactor = (cues, duration) => {
  if (!(duration > 600) || !cues.length) return 1;
  const last = Math.max(...cues.map((c) => c.end));
  if (last <= duration * 1.015) return 1;
  for (const s of [23.976 / 25, 24 / 25, 23.976 / 24]) {
    const scaled = last * s;
    if (scaled <= duration * 1.005 && scaled >= duration * 0.85) return s;
  }
  return 1;
};

// ---------- Hebrew / Arabic punctuation ----------

const RTL = /[֐-׿؀-ۿ]/;
const LEAD = /^([.,!?:;…]+)(\s*)(?=[֐-׿؀-ۿ"'])/;

// Lines like ".שלום" / "?מה" (full stop first, so a renderer without bidi
// would show it last): put the punctuation back at the end — and a dialogue
// dash parked at the end ("שלום -") back at the front. Only when such lines
// are common in the file (one in five of its RTL lines): a correctly written
// file is never touched.
const fixRtlPunctuation = (text) => {
  const lines = String(text || "").split("\n");
  const rtl = lines.filter((l) => RTL.test(l));
  if (rtl.length < 20) return { text, changed: 0 };
  const reversed = rtl.filter((l) => LEAD.test(l.replace(/<[^>]*>/g, "").trim()) || /[֐-׿؀-ۿ]\s*-\s*$/.test(l)).length;
  if (reversed < rtl.length * 0.2) return { text, changed: 0 };
  let changed = 0;
  const out = lines.map((line) => {
    if (!RTL.test(line)) return line;
    const m = /^(\s*(?:<[^>]+>)*)(.*?)((?:<\/[^>]+>)*\s*)$/.exec(line);
    let [, pre, body, post] = m;
    const before = body;
    const lead = LEAD.exec(body);
    if (lead) body = body.slice(lead[0].length) + lead[1];
    const dash = /\s*-\s*$/.exec(body);
    if (dash && RTL.test(body.slice(0, dash.index).slice(-1))) body = "- " + body.slice(0, dash.index);
    if (body !== before) changed++;
    return pre + body + post;
  });
  return { text: out.join("\n"), changed };
};

// ---------- the whole repair, for one fetched file ----------
//
//   srt      the provider's file, as SRT
//   facts    { fps, duration } of the video; ref: cue list of a track the video
//            carries (or null); subFps: the frame rate the provider says
// -> { srt, how: [what was done, in words] }
const repair = (srt, { fps = null, duration = null, ref = null, subFps = null } = {}) => {
  let cues = parse(srt);
  const how = [];
  if (!cues.length) return { srt, how };
  let done = false;
  if (ref && ref.length) {
    const a = align(cues, ref);
    if (a.apply) {
      cues = retime(cues, a.scale, a.offset);
      how.push(`aligned to the video's own track: ×${a.scale.toFixed(4)} ${a.offset >= 0 ? "+" : ""}${a.offset.toFixed(2)} s (${a.matched}/${a.total} lines matched, ${a.identity} before)`);
      done = true;
    } else if (a.why === "already in time") {
      done = true; // the reference says it is right: nothing below may move it
    }
  }
  if (!done) {
    const f = fpsFactor(subFps, fps);
    const o = f === 1 ? overrunFactor(cues, duration) : 1;
    const k = f !== 1 ? f : o;
    // a factor that would push the track past the film's end is not believed
    const last = Math.max(...cues.map((c) => c.end));
    if (k !== 1 && (!(duration > 0) || last * k <= duration * 1.02)) {
      cues = retime(cues, k, 0);
      how.push(f !== 1 ? `frame rate ${subFps} -> ${fps} (×${k.toFixed(4)})` : `ran past the end of the film: ×${k.toFixed(4)}`);
    }
  }
  let out = how.length ? toSrt(cues) : srt;
  const rtl = fixRtlPunctuation(out);
  if (rtl.changed) {
    out = rtl.text;
    how.push(`punctuation of ${rtl.changed} right-to-left line(s) put back at the end`);
  }
  return { srt: out, how };
};

module.exports = { parse, toSrt, retime, align, fpsFactor, overrunFactor, fixRtlPunctuation, repair, SCALES, fmt };
