// The start of a film, as arithmetic: which rendition of a quality ladder to
// begin on, when to give a slow first segment up for a lighter one, which
// segment holds the second playback starts at. No imports and nothing of the
// page: the player (screens/player.js) decides with these, and the tests
// (test/playstart.test.js) hold them to their numbers.

// The rendition playlists a master names, in its order (the top one first):
// [{ uri (absolute), bandwidth, v }].
export const masterVariants = (text, masterUrl) => {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const uri = (lines[i + 1] || "").trim();
    if (!uri || uri.startsWith("#")) continue;
    const bw = /(?:^|,)BANDWIDTH=(\d+)/.exec(m[1]);
    out.push({ uri: new URL(uri, masterUrl).href, bandwidth: bw ? +bw[1] : 0, v: (/[?&]v=([^&]+)/.exec(uri) || [])[1] || "copy" });
  }
  return out;
};

// PURE. The rung to start on: `rungs` top first ([{ bandwidth (bit/s) }], as a
// master lists them), `kbps` what the line is known to carry (0 = unknown).
// The highest rung that fits in 80% of the line; the lowest when none does;
// the top when nothing is known (the first segment is then watched as it
// arrives — see the start watch in ladderWire). Returns an index into rungs.
export const START_HEADROOM = 0.8;
export const startRung = (rungs, kbps) => {
  if (!rungs || !rungs.length) return -1;
  if (!(kbps > 0)) return 0;
  const fits = rungs.findIndex((r) => r.bandwidth > 0 && r.bandwidth <= kbps * 1000 * START_HEADROOM);
  return fits >= 0 ? fits : rungs.length - 1;
};
// PURE. A first segment of an ENCODED rung that the server has not begun to
// send: has it been waited for long enough to take the file's own video
// instead (a copy: made at the speed of the disk)? `waited`: ms since it was
// asked for. Only when there is a copied top rung to go to. `thin`: the line
// is KNOWN not to carry that copy (it is why the start is on a lighter rung):
// going up to it buys a first frame and then a long stall (measured
// 2026-10-11, an 8 Mbit/s film on 3 Mbit/s with a starved encoder: frame at
// 6.6 s, then 16 s of nothing) — so the encoder is waited for four times as
// long, and the copy is only the way out of an encode that never comes.
export const START_ENCODE_PATIENCE_MS = 3000;
export const START_ENCODE_PATIENCE_THIN_MS = 12000;
export const startStepUp = ({ waited, encoded, copyTop, thin = false }) =>
  !!encoded && !!copyTop && waited >= (thin ? START_ENCODE_PATIENCE_THIN_MS : START_ENCODE_PATIENCE_MS);

// PURE. Should a first segment that is arriving slowly be given up for a
// lighter rung? `eta`: seconds until it is all here at the rate it is
// arriving; `rate`: that rate, bit/s; `dur`: the segment's length in
// seconds; `lower`: the rungs below the one loading, best first
// ([{ bandwidth }]). A lighter rung has to be MADE first (an encode), so it
// is charged a start-up allowance, and it has to win clearly — a switch
// throws away what has arrived. Of the rungs that win, the best one the
// measured rate can also CARRY (the same 80% a start asks of a line) — a
// rung that is merely quicker to fetch once would be given up again a
// segment later; when none can be carried, the lightest. Returns an index
// into `lower`, or -1 to stay.
export const START_MAKE_SEC = 1.5;
export const startStepDown = ({ eta, rate, dur, lower }) => {
  if (!(eta > 3) || !(rate > 0) || !(dur > 0) || !lower) return -1;
  const quicker = (r) => r.bandwidth > 0 && (r.bandwidth * dur) / rate + START_MAKE_SEC < eta * 0.6;
  const carried = lower.findIndex((r) => quicker(r) && r.bandwidth <= rate * START_HEADROOM);
  if (carried >= 0) return carried;
  const last = lower.length - 1;
  return last >= 0 && quicker(lower[last]) ? last : -1;
};

// PURE. Is a file that this device could play as itself better played as a
// stream? An MP4 shows nothing until the browser has its whole index — a
// box of megabytes (`indexBytes`) — where a stream starts on a playlist of a
// few kB and the head of its first segment. On a line known to be thin
// (`kbps`: what it carried the last time a film played here) that index is
// the whole wait. Returns the seconds the stream is expected to save (the
// caller asks for more than STREAM_WORTH_SEC), 0 when nothing is known.
//   fileKbps     the file's own bitrate (0 = unknown: a stream's first
//                segment cannot be sized, so nothing is claimed for it)
//   progressive  the player feeds a segment to the decoder as it arrives
//                (else it needs a whole first segment: ~SEGMENT_SEC of film)
export const STREAM_WORTH_SEC = 1.5;
const FIRST_FRAME_BYTES = 400 * 1024; // what a first picture needs past the index, either way
const SEGMENT_SEC = 8; // a first segment's length, give or take (6–10 s)
const STREAM_SETUP_SEC = 0.6; // a stream's own overhead: its playlists, the server making the segment
//
// Only on a line that carries the FILM with room to spare (STREAM_HEADROOM
// times its bitrate — the room the player asks of a line before it leaves a
// file alone): a stream of the same video weighs a little more than the file
// (its container, its re-encoded sound), and on a line the film only just
// fits it is the stream that falls behind — measured 2026-10-10, a 2.5 Mbit/s
// film on a 3 Mbit/s line: the file plays, its stream starves. There the
// index is waited for, as before.
export const STREAM_HEADROOM = 1.3;
export const streamSaves = ({ indexBytes = 0, kbps = 0, fileKbps = 0, progressive = false } = {}) => {
  if (!(indexBytes > 0) || !(kbps > 0)) return 0;
  if (!(fileKbps > 0) || kbps < fileKbps * STREAM_HEADROOM) return 0;
  const line = kbps * 125; // bytes a second
  const asFile = (indexBytes + FIRST_FRAME_BYTES) / line;
  const first = progressive ? FIRST_FRAME_BYTES : fileKbps * 125 * SEGMENT_SEC;
  const asStream = first / line + STREAM_SETUP_SEC;
  return Math.max(0, asFile - asStream);
};

// PURE. Should a film this device could play as the FILE be opened as its
// own picture, copied into a stream, instead? (research-stream-efficiency,
// 2026-11-28.) A file has one bitrate and the browser keeps a few seconds of
// it ahead; a stream is held ~100 s deep by hls.js. The household's films
// carry their busiest 30 s at a median 2.2x their average bitrate (29 films,
// 1.7–3.8x), so only a line known to carry that much keeps the file.
//   fileKbps  the film's average bitrate (0 = unknown: nothing is claimed)
//   kbps      what this device's line carried the last time (0 = unknown)
export const FILM_PEAK_RATIO = 2.2;
export const fileNeedsBuffer = ({ fileKbps = 0, kbps = 0 } = {}) => fileKbps > 0 && (!(kbps > 0) || kbps < fileKbps * FILM_PEAK_RATIO);

// PURE. What a rung of a quality ladder asks of the line before it is taken,
// bit/s (research-stream-efficiency, 2026-11-28). A rung's BANDWIDTH is its
// busiest segment — for the film's own copy that is the file's worst stretch,
// 1.9x its average and more — and 1.4x THAT is what the line had to show.
// With the buffer deep enough to ride out that busiest segment arriving at the
// line's speed (30 s, and three times its fetch at the estimate), the AVERAGE
// is what the line really has to carry: 1.25x it. Below that depth, the rule
// as it was. (Measured: an earlier version that trusted the average from 20 s
// in hand stalled 8–20 s when the line fell from 10 to 2 Mbit/s mid-scene.)
//   peak, avg  the rung's BANDWIDTH and AVERAGE-BANDWIDTH (avg 0: unknown)
//   ahead      seconds buffered; est  the line, bit/s; segSec  the segment length
export const RUNG_AVG_BUFFER_SEC = 30;
export const rungNeeds = ({ peak = 0, avg = 0, ahead = 0, est = 0, segSec = 10 } = {}) => {
  if (!(avg > 0)) return peak * 1.4;
  const fetchSec = est > 0 ? (peak * segSec) / est : Infinity;
  return ahead >= Math.max(RUNG_AVG_BUFFER_SEC, 3 * fetchSec) ? avg * 1.25 : peak * 1.4;
};

// PURE. A SEEK ON A LADDER WHOSE LOWER RUNGS ARE ENCODES (2026-11-28, stream
// round 2). After a seek the buffer is empty, and hls.js's rule for an empty
// buffer asks that a WHOLE next segment come within 4 s (maxStarvationDelay).
// jit segments are 6–16 s long, so on a line that carries the film several
// times over it still picks a lighter rung — and here a lighter rung is a
// live encode: an encoder started (two ffmpegs: the fast first segment and the
// hand-over), a segment the server has to make before the first byte, a
// smaller picture and a quality chip, all because the viewer skipped ahead.
// Measured on the rig (8 Mbit/s, a 1.9 Mbit/s film): a far seek took 5.2 s to
// show its frame and started 4 encoders. The segment is also played as it
// arrives (progressive), so what a seek waits on is the start of it, not the
// whole. So: during a seek, a step down onto an ENCODED rung is not taken
// while the line, as measured, carries the rung being left on AVERAGE with
// SEEK_HOLD_HEADROOM to spare. A line that does not carry it falls through to
// hls.js as before (a real thin line still steps down).
//   levels: [{ avg, peak, encoded }] in hls.js's order; cur: the level being
//   loaded; pick: hls.js's choice; est: bits/s; cap: autoLevelCapping (-1 none)
// …and only while a segment of that rung, at its average, comes in hls.js's
// own 4 s (maxStarvationDelay): hls.js judges by the BUSIEST segment, which is
// what sent a 1.9 Mbit/s film's seek onto an encode on an 8 Mbit/s line; but a
// 3.2 Mbit/s HEVC copy's 10-s segments on that line take 4.3 s by their
// average, and holding it made that seek SLOWER than the encode (rig: 3.9 →
// 8.7 s) — that one stays hls.js's choice.
//   fragSec: the segment length (s)
export const SEEK_HOLD_HEADROOM = 1.25;
export const SEEK_HOLD_FETCH_S = 4;
export const seekHold = ({ seeking = false, cur = -1, pick = -1, levels = [], est = 0, cap = -1, fragSec = 0 } = {}) => {
  if (!seeking || !(cur >= 0) || !(pick >= 0) || pick >= cur) return pick;
  if (cap >= 0 && cur > cap) return pick;
  const lc = levels[cur];
  const lp = levels[pick];
  if (!lc || !lp || !lp.encoded) return pick;
  const rate = lc.avg > 0 ? lc.avg : lc.peak;
  const need = rate * SEEK_HOLD_HEADROOM;
  if (!(need > 0) || est < need) return pick;
  if (fragSec > 0 && (rate * fragSec) / est > SEEK_HOLD_FETCH_S) return pick;
  return cur;
};

// PURE. The segment of a media playlist that holds second `sec`: its URI as
// written, or null. (hls.js starts on that one for startPosition = sec.)
export const segmentAt = (playlistText, sec) => {
  let t = 0;
  let dur = null;
  let last = null;
  for (const raw of String(playlistText || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^#EXTINF:([\d.]+)/.exec(line);
    if (m) { dur = parseFloat(m[1]); continue; }
    if (line.startsWith("#") || dur == null) continue;
    if (sec < t + dur) return line;
    t += dur;
    dur = null;
    last = line;
  }
  return last;
};

// PURE. The decode-stall watchdog's reading, once a second: is the picture
// frozen with film in hand — the device failing to DECODE (then the player
// takes the server's copy or encode instead)? Only with film buffered AT the
// playhead (the range that holds it, more than 3 s of it) and the element
// saying it has it (readyState 3+), not while a seek is under way. It used to
// look at the LAST buffered range: after a seek back, film far ahead of the
// new playhead read as "in hand" while the browser was still fetching the new
// spot — three seconds of a slow disk or line, and a file that plays as it
// is went to the server's transcode for the rest of the film.
//   ranges: [[start, end], …] (video.buffered)  -> true when it counts
export const decodeStalled = ({ ranges = [], ct = 0, lastCT = -1, paused = false, seeking = false, readyState = 0 } = {}) => {
  if (paused || seeking || readyState < 3 || ct !== lastCT) return false;
  for (const [a, b] of ranges) if (a <= ct + 0.3 && b > ct) return b - ct > 3;
  return false;
};

// PURE. A segment's load stats, made to say what the LINE did. hls.js
// measures the line by a segment's bytes over the time from asking to the
// last byte, less a first-byte wait up to what it expects one to be — so
// the seconds the SERVER spent making the segment (an encode on a small CPU:
// 5–7 s for one 1080p segment on two cores; a torrent's swarm) were counted
// as a slow line. It then stepped down a rung — a new encode from scratch,
// slower still — and down again: measured on a 2-CPU instance (tools/ttff
// vps.js jit-encode-seek), 1080p → 720p → 480p within 25 s on a 100 Mbit/s
// line, each step a new encoder, and the film stopped. The wait for the
// first byte beyond `floor` ms (a far line's round trip) is not the line's:
// the load's start is moved up to `floor` before its first byte.
//   stats: hls.js LoadStats (mutated) -> the ms taken off (0 if none)
export const SERVER_WAIT_FLOOR_MS = 250;
export const lineTimeOnly = (stats, floor = SERVER_WAIT_FLOOR_MS) => {
  const l = stats && stats.loading;
  if (!l || !(l.first > 0) || !(l.start > 0)) return 0;
  const wait = l.first - l.start;
  if (wait <= floor) return 0;
  l.start = l.first - floor;
  return Math.round(wait - floor);
};

// PURE. A torrent start that is going nowhere: the source the viewer was put
// on has nobody sharing it. The server waits up to 90 s for peers before it
// gives up ("Timed out finding peers") and the player said "Still trying…" at
// 60 s — a minute and a half of a spinner for a source that was never going
// to play, while the sources list had others. Nobody at all after 25 s, or
// nothing at all arrived after 45 s, and the next source is tried. (The TV
// app keeps the same rule: tv-native/src/playerRules.ts deadSource.)
export const DEAD_SOURCE_PEERLESS_MS = 25000;
export const DEAD_SOURCE_EMPTY_MS = 45000;
export const deadSource = ({ elapsedMs = 0, peers = 0, progress = 0, everPlayed = false } = {}) =>
  !everPlayed && !(progress > 0) && ((elapsedMs >= DEAD_SOURCE_PEERLESS_MS && !(peers > 0)) || elapsedMs >= DEAD_SOURCE_EMPTY_MS);

// PURE. The sources to fall back to, best first: the live ones a person could
// pick (not a cam, a pre-release, a dub, a release reported bad here), most
// seeders first, the chosen one left out.
export const fallbackSources = (streams = [], chosen = null, n = 3) =>
  (streams || [])
    .filter((x) => x && x !== chosen && !(chosen && x.infoHash === chosen.infoHash && x.fileIdx === chosen.fileIdx))
    .filter((x) => !x.cam && !x.prerelease && !x.dubbed && !x.badHere && x.seeders > 0)
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
    .slice(0, n);

// A jit playlist for a NATIVE player (an iPhone's) that begins at `at`
// seconds: the start point rides along (?start=…&until=…) and the playlist
// answers with EXT-X-START (media/jit.js playlistStart) — the phone's own
// player then begins there instead of fetching the top of the film first.
// `until`: a few minutes from now — an address that is handed on later
// (AirPlay's twin) no longer carries it. Anything else is returned as it is.
const NATIVE_START_FOR_S = 5 * 60;
export const nativeStartUrl = (url, at, nowMs = Date.now()) => {
  if (!(at > 0.5) || typeof url !== "string" || !/\/jit\/index\.m3u8(\?|$)/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}start=${Math.floor(at)}&until=${Math.floor(nowMs / 1000) + NATIVE_START_FOR_S}`;
};
