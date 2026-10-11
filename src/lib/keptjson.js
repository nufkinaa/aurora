// A JSON answer that stays the same until something changes, made ONCE and
// sent many times — instead of being stringified, hashed for its ETag and
// compressed again for every request.
//
//   const keptjson = require("../lib/keptjson");
//   let kept = null;                                   // remade when what it was made from changes
//   router.get("/api/thing", (req, res) => {
//     if (!kept || changed()) kept = keptjson.make(req.app, value());
//     if (!kept) return res.json(value());             // (this app's JSON settings are not the defaults)
//     keptjson.send(req, res, kept);
//   });
//
// send() does not go through res.json, so a handler that uses it must itself
// take care of what the res.json wrappers would have done (the kids gate
// filters lists; lib/blurup.js adds "_blur") — see /api/library.
//
// What goes out is what `res.json(value)` sends: the same bytes once decoded,
// the same Content-Type, the same ETag (Express's own function makes it), a
// 304 for a client whose copy is current, `Vary: Accept-Encoding`. The one
// difference a client could see: a compressed answer carries a Content-Length
// instead of arriving chunked, because it was compressed beforehand.
//
// Measured (docs/qa/backend-efficiency, /api/library of 1,261 titles on a
// two-core box): 23 ms of CPU per request before — and 12 ms for a 304, the
// body was built and hashed just to find out the client already had it.
const zlib = require("zlib");

// The quality server.js gives the compression middleware (measured there).
const BROTLI_QUALITY = 6;
const THRESHOLD = 1024; // the middleware's: smaller answers are not compressed

// `value` -> what is kept. Returns null when this app's JSON settings are not
// the defaults (then nothing here can promise res.json's bytes: use res.json).
const make = (app, value) => {
  if (app.get("json replacer") || app.get("json spaces") || app.get("json escape")) return null;
  const buf = Buffer.from(JSON.stringify(value), "utf8");
  const etagFn = app.get("etag fn");
  return { buf, etag: etagFn ? etagFn(buf) : null, br: null, gzip: null, sent: 0 };
};

// Compressed copies, made off the event loop the first time an answer is sent
// a SECOND time (one that is only ever sent once is not worth it). Until each
// is ready the answer goes out through the compression middleware, as it
// always did.
const precompress = (kept) => {
  if (kept.buf.length < THRESHOLD) return;
  zlib.brotliCompress(kept.buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: kept.buf.length } }, (err, out) => { if (!err) kept.br = out; });
  zlib.gzip(kept.buf, (err, out) => { if (!err) kept.gzip = out; });
};

// Which ready-made encoding this client gets, or null to let the compression
// middleware decide as before. Only the plain case is decided here — a list
// with no weights and no wildcard ("gzip, deflate, br", what browsers, the TV
// app and Node send), where the middleware's choice is known: br when it is
// listed, else gzip. Anything else (q-values, "*", "identity") goes the old way.
const choose = (header) => {
  if (typeof header !== "string" || !header || /[;*]/.test(header)) return null;
  const list = header.toLowerCase().split(",").map((s) => s.trim());
  if (list.includes("identity")) return null;
  if (list.includes("br")) return "br";
  if (list.includes("gzip")) return "gzip";
  return null;
};

const send = (req, res, kept) => {
  if (++kept.sent === 2) precompress(kept);
  res.set("Content-Type", "application/json"); // (Express adds "; charset=utf-8", as it does for res.json)
  if (kept.etag) res.set("ETag", kept.etag);
  // a client whose copy is current gets its 304 from Express, built from the headers above
  if (!req.fresh && !req.headers["x-no-compression"] && res.statusCode === 200) {
    const enc = choose(req.headers["accept-encoding"]);
    const body = enc === "br" ? kept.br : enc === "gzip" ? kept.gzip : null;
    if (body) {
      res.set("Content-Encoding", enc); // the compression middleware sees it and leaves the body alone
      res.vary("Accept-Encoding");
      return res.send(body);
    }
  }
  return res.send(kept.buf);
};

module.exports = { make, send, choose, precompress, BROTLI_QUALITY };
