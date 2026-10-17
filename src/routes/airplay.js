// AirPlay links: the player asks for one before it hands a film to an Apple
// TV (public/js/airplay.js). What a link is, what it opens and when it stops:
// lib/airtoken.js.
//
//   POST /api/airplay/link   { path: "/stream/…" }
//     -> { url: "/air/<token>/stream/…", expiresAt, needed }
//
// `path` is the stream the RECEIVER should play (the player chooses it: the
// file, the jit stream, the AirPlay master with subtitles). It must be one
// of the stream paths a link may open (airtoken.pathScope), of a title that
// exists, and one the asker may play — the kids gate is asked about exactly
// that path, as the asker, before anything is signed. `needed` says whether
// the receiver needs the link at all: false while the server is open (sign-in
// mode open / transition), where the plain address plays for anyone on the
// network — the player may then keep the stream it has.
//
// Behind the sign-in wall and the reset gate like every /api route: in mode
// "closed" only a signed-in profile gets here, and a profile that owes a new
// password does not.
const express = require("express");
const router = express.Router();
const airtoken = require("../lib/airtoken");
const scanner = require("../media/scanner");
const lazy = require("../lib/lazy");
const authzLib = lazy(require, "../lib/authz");
const authmodeLib = lazy(require, "../lib/authmode");
const profilesLib = lazy(require, "../profiles");
const apiLib = lazy(require, "./api");

// Who is asking: the sign-in session, else an unlock token, else the profile
// the request names (open modes) — for the kids rules and the reset gate.
const askerOf = (req) => {
  const s = authzLib().sessionFor(req);
  if (s) return { profileId: s.profile.id, sessionKey: s.sessionKey };
  const profiles = profilesLib();
  const tok = req.headers["x-profile-token"];
  const byTok = tok ? profiles.tokenProfile(String(tok)) : null;
  if (byTok) return { profileId: byTok, sessionKey: null };
  const named = typeof req.headers["x-profile"] === "string" ? req.headers["x-profile"] : (req.body || {}).profile;
  if (typeof named === "string" && /^[\w-]{1,40}$/.test(named) && profiles.list().some((p) => p.id === named)) {
    return { profileId: named, sessionKey: null };
  }
  return { profileId: null, sessionKey: null };
};

// The kids gate's verdict on a GET of `innerPath`, made as this request.
// Runs the one gate (routes/api.js) on a copy of the request that differs only
// in its method and address — the same rules a request for the stream meets.
const kidsVerdict = (req, innerPath) =>
  new Promise((resolve) => {
    const fake = Object.create(req);
    fake.method = "GET";
    fake.url = innerPath;
    fake._parsedUrl = undefined;
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ ok: false, status: this.statusCode, body }); return this; },
      send(body) { resolve({ ok: false, status: this.statusCode, body }); return this; },
      setHeader() {},
    };
    try {
      apiLib()._internals.kidsGate(fake, res, () => resolve({ ok: true }));
    } catch {
      resolve({ ok: false, status: 500, body: { error: "Couldn't check that for a kids profile.", kids: true } });
    }
  });

router.post("/api/airplay/link", async (req, res) => {
  const raw = String((req.body || {}).path || "");
  const qi = raw.indexOf("?");
  const innerPath = qi < 0 ? raw : raw.slice(0, qi);
  const query = qi < 0 ? "" : raw.slice(qi);
  // the query is the stream's own parameters — short words and numbers only
  if (!innerPath.startsWith("/stream/") || (query && !/^\?[A-Za-z0-9=&_.-]{0,200}$/.test(query))) {
    return res.status(400).json({ error: "That can't be sent with AirPlay." });
  }
  const title = airtoken.pathScope(innerPath);
  if (!title) return res.status(400).json({ error: "That can't be sent with AirPlay." });
  let duration = 0;
  if (title.startsWith("l:")) {
    const id = title.slice(2);
    const entry = scanner.resolve(id);
    if (!entry || entry.kind !== "video") return res.status(404).json({ error: "Not found" });
    const item = scanner.findById(id);
    duration = (item && item.duration) || 0;
  }
  const closed = authmodeLib().get() === "closed";
  const who = askerOf(req);
  if (closed && !who.sessionKey) return res.status(401).json({ error: "sign in first", signinRequired: true });
  const verdict = await kidsVerdict(req, innerPath);
  if (!verdict.ok) return res.status(verdict.status || 403).json(verdict.body || { error: "That one isn't available in a kids profile.", kids: true });
  const kid = apiLib()._internals.kidsFor(req);
  const { token, expiresAt } = airtoken.mint({
    title,
    profileId: who.profileId || (kid && kid.profile) || "",
    sessionKey: who.sessionKey,
    maxAge: kid ? kid.maxAge : null,
    ttlMs: airtoken.ttlFor(duration),
  });
  res.setHeader("Cache-Control", "no-store");
  // A page opened on the server machine itself (localhost): the TV can't
  // reach that name, so it is given this machine's address on the home
  // network instead (`origin`). Any other page: its own address is the one.
  const lan = localHost(req.headers.host) ? lanOrigin(req) : null;
  res.json({ url: `${airtoken.PREFIX}${token}${raw}`, expiresAt, needed: closed, ...(lan ? { origin: lan } : {}) });
});

const localHost = (host) => /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/i.test(String(host || ""));
// This machine's address on the home network: a private IPv4 of a real
// adapter (not a virtual switch, a VPN or a container bridge), 192.168.x
// first. null when there is none.
const VIRTUAL = /vethernet|docker|vbox|virtualbox|vmnet|vmware|wsl|hyper-v|loopback|tailscale|zerotier|utun|^br-|^veth/i;
const lanOrigin = (req) => {
  const os = require("os");
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list || []) {
      if ((a.family === "IPv4" || a.family === 4) && !a.internal) found.push(a.address);
    }
  }
  const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 9);
  const ip = found.filter((x) => rank(x) < 9).sort((a, b) => rank(a) - rank(b))[0];
  const port = req.socket && req.socket.localPort;
  return ip && port ? `${authzLib().isHttps(req) ? "https" : "http"}://${ip}:${port}` : null;
};
router._internals = { localHost, lanOrigin };

module.exports = router;
