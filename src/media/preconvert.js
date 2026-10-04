// Play-ready copies, made ahead of time — but only where they will be used.
//
// A file whose video a device can't decode is re-encoded while it plays
// (remux.js, the "library/h264" path). On this server that start is slow —
// the household's own numbers say a minute to the first frame on a phone —
// because the encode begins when Play is pressed. The fix is to have a
// playable copy already made: the player asks for one before it starts a
// live encode, and plays it directly if it is there (instant start, every
// seek native, no CPU while watching).
//
// The catch is disk. A copy is the film again, on a server whose disk is
// small. So a copy is made only when ALL of this holds:
//   - the download just landed (this runs once, from the download queue);
//   - its video is not plain 8-bit H.264 (which every device plays as it is);
//   - this household has actually used the live-encode path this month —
//     if every device here plays HEVC, nothing is ever made;
//   - the copies folder is under three quarters of its cap, and the disk
//     has room (offline.js checks both again before starting).
// The copy lives in the same temporary folder as the phone copies, kept for
// six days (long enough to watch what was just downloaded) and then cleared
// like everything else there. `"preconvert": false` in config.json turns it
// off. One conversion at a time, at below-normal priority, in offline.js's
// own queue.
const fs = require("fs");
const config = require("../config");

const KEEP_MS = 6 * 24 * 3600 * 1000;
const QUALITY = "1080";
const MAX_TRIES = 12; // the probe runs after the scan: give it up to ~12 minutes
const RETRY_MS = 60 * 1000;

// Pure: should a copy be made? → { make: bool, why }
const decide = ({ enabled, ffmpeg, video, liveEncodes, folderBytes, capBytes }) => {
  if (!enabled) return { make: false, why: "turned off in config" };
  if (!ffmpeg) return { make: false, why: "no ffmpeg" };
  if (!video || !video.codec) return { make: false, why: "not probed yet", retry: true };
  const plain = video.codec === "h264" && !(video.bitDepth > 8);
  if (plain) return { make: false, why: "plain H.264 plays everywhere as it is" };
  if (!(liveEncodes > 0)) return { make: false, why: "no device here has needed a live encode this month" };
  if (folderBytes > capBytes * 0.75) return { make: false, why: "the copies folder is nearly full" };
  return { make: true, why: `${video.codec}${video.bitDepth > 8 ? " 10-bit" : ""} and ${liveEncodes} live encode${liveEncodes === 1 ? "" : "s"} this month` };
};

const liveEncodesThisMonth = () => {
  try {
    const plays = require("../lib/usage").summary().plays || [];
    return plays.filter((p) => /^library\/h264/.test(p.path)).reduce((n, p) => n + p.n, 0);
  } catch {
    return 0;
  }
};

const folderBytes = (dir) => {
  let total = 0;
  try { for (const f of fs.readdirSync(dir)) { try { total += fs.statSync(require("path").join(dir, f)).size; } catch {} } } catch {}
  return total;
};

// Called when a download has landed in the library. Fire-and-forget.
const consider = (libraryId, tries = 0) => {
  try {
    const scanner = require("./scanner");
    const metadata = require("./metadata");
    const offline = require("./offline");
    const entry = scanner.resolve(libraryId);
    if (!entry || entry.kind !== "video") return;
    const meta = metadata.getCached(entry.path);
    const d = decide({
      enabled: config.preconvert !== false,
      ffmpeg: !!config.ffmpegAvailable,
      video: meta && meta.video,
      liveEncodes: liveEncodesThisMonth(),
      folderBytes: folderBytes(offline.DIR),
      capBytes: offline.MAX_BYTES,
    });
    if (d.retry && tries < MAX_TRIES) {
      setTimeout(() => consider(libraryId, tries + 1), RETRY_MS).unref();
      return;
    }
    if (!d.make) return void console.log(`[preconvert] ${libraryId}: not making a copy — ${d.why}`);
    const st = offline.prepare(libraryId, QUALITY, {}, { keepMs: KEEP_MS });
    console.log(`[preconvert] ${libraryId}: ${st.state === "error" ? `could not start — ${st.error}` : `making a play-ready copy (${d.why})`}`);
  } catch (e) {
    console.warn(`[preconvert] ${libraryId}: ${e.message}`);
  }
};

module.exports = { consider, QUALITY, _internals: { decide } };
