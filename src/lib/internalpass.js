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
module.exports = { HEADER, value, ok };
