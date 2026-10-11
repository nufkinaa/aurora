// Which answers are worth compressing on the way out (server.js hands this to
// the `compression` middleware as its filter).
//
// An allow-list, not `compression`'s default, on purpose: video, HLS segments
// and the APK must stream untouched. Re-compressing an .mp4 wastes CPU for
// nothing, and buffering a range response to deflate it is how you turn
// instant seeking into a stall.
//
// HLS PLAYLISTS are on the list (2026-10-10): plain text under a media type.
// A two-hour film's full-timeline playlist is ~30 kB of near-identical lines
// and ~3 kB compressed — on a new connection that is one round trip instead
// of two (TCP's first flight is ~14 kB), and every start asks for two of
// them. Every HLS client is required to accept gzip for playlists (RFC 8216
// §4), and they only get it when they ask (Accept-Encoding). Segments are
// video/mp2t and video/mp4: never matched.
"use strict";

const COMPRESSIBLE = /^(?:application\/(?:json|javascript|xml|manifest|vnd\.apple\.mpegurl|x-mpegurl)|text\/|image\/svg)/i;

const byType = (contentType) => COMPRESSIBLE.test(String(contentType || ""));

// The middleware's filter.
const filter = (req, res) => {
  if (req.headers["x-no-compression"]) return false;
  // 206 Partial Content is the seek path. Leave it alone.
  if (res.statusCode === 206) return false;
  return byType(res.getHeader("Content-Type"));
};

module.exports = { filter, byType };
