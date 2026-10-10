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
// asked for. Only when there is a copied top rung to go to.
export const START_ENCODE_PATIENCE_MS = 3000;
export const startStepUp = ({ waited, encoded, copyTop }) => !!encoded && !!copyTop && waited >= START_ENCODE_PATIENCE_MS;

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
