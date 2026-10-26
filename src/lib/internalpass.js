// A pass for requests this server makes to ITSELF over loopback (the blur-up
// maker reading /img/*). Random per process, never written anywhere, never
// sent to a client: the sign-in wall lets a request through only when it
// carries exactly this value. (The address alone proves nothing — behind a
// reverse proxy every request arrives from 127.0.0.1.)
const crypto = require("crypto");
const HEADER = "x-aurora-internal";
const value = crypto.randomBytes(32).toString("hex");
const ok = (req) => {
  const got = req && req.headers && req.headers[HEADER];
  if (typeof got !== "string" || got.length !== value.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(value));
};
// The same pass for ffmpeg / ffprobe reading this server's own torrent route
// (http://127.0.0.1:<port>/stream/torrent/…): on a server that requires
// sign-in, those reads carry no session, and without the pass the wall
// answered them 401 — the torrent probe failed and a torrent that was not yet
// whole on disk could not be repackaged or encoded (measured 2026-10-26,
// docs/qa/capacity-2026-10/REPORT.md). Input options, placed before the URL.
const CRLF = String.fromCharCode(13, 10);
const ffArgs = () => ["-headers", `${HEADER}: ${value}${CRLF}`];
module.exports = { HEADER, value, ok, ffArgs };
