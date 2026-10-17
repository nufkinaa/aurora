// WHO IS READING A STREAM — for "whose goodbye is it" (media/jit.js release
// for the website's jit producers, media/goodbye.js for the TV's offset
// transcodes). Never logged, never sent anywhere; only compared.
//
//   1. the sign-in session, when the request has one (in sign-in mode
//      "closed" every request that reaches a route does);
//   2. the TV app's own tag (X-Aurora-Viewer: one random value per run of
//      the app), tied to the address. A TV reads a stream through ExoPlayer
//      and says goodbye through fetch — two HTTP stacks with two user agents,
//      so the browser rule below would make them two different viewers and
//      the goodbye would stop nothing on an open server. Tied to the address,
//      a copied tag names nobody else;
//   3. else the device as far as it can be told: its address and browser (a
//      browser's segment requests and its goodbye beacon carry the same
//      cookie and user agent, which is all this has to hold).
const crypto = require("crypto");

const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 20);
const TAG = /^[A-Za-z0-9_-]{8,64}$/;

const viewerOf = (req) => {
  try {
    const s = require("./authz").sessionFor(req);
    if (s && s.sessionKey) return `s:${s.sessionKey}`;
  } catch {}
  const tag = req.headers && req.headers["x-aurora-viewer"];
  if (typeof tag === "string" && TAG.test(tag)) return "v:" + hash(`${req.ip || ""}|${tag}`);
  return "d:" + hash(`${req.ip || ""}|${(req.headers && req.headers["user-agent"]) || ""}`);
};

module.exports = { viewerOf };
