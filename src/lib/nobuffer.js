// "Don't buffer this" to a reverse proxy in front of the server.
//
// nginx (nufurora.com runs behind one) buffers what it proxies by default:
// it reads the server's answer as fast as the server sends it — a whole film,
// for a direct play — into memory and then into temporary files on its own
// disk (up to 1 GB per answer, proxy_max_temp_file_size), and feeds the
// viewer from there. For a stream that is the wrong way round: the server
// already reads at the viewer's pace (lib/diskread.js, rangeserve.watch),
// and a proxy pulling a film off the disk at full speed into files on the
// same small VPS disk takes the bandwidth every other viewer's segments
// need. nginx honours the X-Accel-Buffering response header per answer;
// every other proxy (Caddy) ignores it. Streams only: /stream/* (files,
// playlists, segments, subtitles, torrents) and saved copies (/offline/file).
"use strict";

const STREAMING = /^\/(stream|offline\/file)\//;
const middleware = (req, res, next) => {
  if (STREAMING.test(req.path)) res.setHeader("X-Accel-Buffering", "no");
  next();
};

module.exports = { middleware, STREAMING };
