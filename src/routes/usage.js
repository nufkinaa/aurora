// Usage stats: the app posts small batches (public/js/usage.js, the TV's
// usage.ts), the admin reads the aggregates (lib/usage.js for screens,
// features and plays; lib/tel for error reports, timings and control counts).
// The POST is deliberately forgiving — it answers 204 to anything malformed
// rather than making a client log errors about its own telemetry.
//
// THE SWITCH IS ENFORCED HERE. A batch names the profile it was made under;
// when that profile has usage stats off (prefs.usageStats === false, the
// switch under Settings → Privacy), or is not a profile this server knows,
// the batch is dropped whole — whatever the client believed — and the answer
// carries `X-Usage: off`, on which both clients stop sending.
const express = require("express");
const usage = require("../lib/usage");
const tel = require("../lib/tel");
const realtime = require("../realtime");

const router = express.Router();
usage.boot();
tel.boot(usage.DIR);
// the household's own words, which a client message must never be stored with
tel.setDictionarySource(() => ({
  titles: require("../media/scanner").allItems().map((i) => i.title),
  people: require("../profiles").list().map((p) => p.name),
}));
process.once("exit", () => { try { tel.flush(); } catch {} }); // synchronous writes: safe in an exit handler

// One address may post this many batches a minute (a client sends three).
const PER_MINUTE = 60;
const hits = new Map(); // ip -> { at, n }
const overLimit = (ip, now = Date.now()) => {
  if (hits.size > 5000) hits.clear();
  let h = hits.get(ip);
  if (!h || now - h.at > 60000) hits.set(ip, (h = { at: now, n: 0 }));
  return ++h.n > PER_MINUTE;
};

router.post("/api/usage", (req, res) => {
  try {
    if (!overLimit(realtime.clientIp(req))) {
      const mode = require("../lib/authmode").get();
      const v = tel.verdict(req.body, {
        profiles: require("../profiles").list(),
        mode,
        session: mode === "closed" ? require("../lib/authz").sessionFor(req) : null,
        admin: mode === "closed" && realtime.isAdmin(req),
      });
      if (v === "drop") res.setHeader("X-Usage", "off");
      else {
        if (v === "all") usage.record(req.body);
        tel.record(req.body, v === "errors" ? { only: ["e"] } : {});
      }
    }
  } catch {}
  res.status(204).end();
});

const adminOnly = (req, res, next) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  res.setHeader("Cache-Control", "no-store");
  next();
};

router.get("/api/admin/usage", adminOnly, (req, res) => {
  // the Copy button gets everything: usage, then errors, timings and most-used
  res.json({ summary: usage.summary(), text: `${usage.text()}

${tel.text()}` });
});

// Error reports, timings and control counts — the admin's "App health" page.
// ?app= &version= &model= &level= narrow the errors; ?device= &net= the timings.
router.get("/api/admin/telemetry", adminOnly, (req, res) => {
  const pick = (v, re) => (typeof v === "string" && re.test(v) ? v : "");
  const q = {
    app: pick(req.query.app, /^(web|tv)$/),
    level: pick(req.query.level, /^(error|warn)$/),
    version: pick(req.query.version, /^[A-Za-z0-9._?-]{1,16}$/),
    model: pick(req.query.model, /^[A-Za-z0-9 ._+/()?-]{1,32}$/),
    device: pick(req.query.device, /^(phone|tablet|desktop|tv)$/),
    net: pick(req.query.net, /^(slow|ok|fast)$/),
  };
  res.json({ ...tel.summary(q), text: tel.text() });
});

// Mark a kind of error known (still shown, never announced as new) or
// ignored (counted, out of the lists, never alerted) — or open again.
router.post("/api/admin/telemetry/errors/:fp/state", adminOnly, (req, res) => {
  const b = req.body || {};
  if (!tel.errors.setState(req.params.fp, b.state, b.note)) return res.status(400).json({ error: "state is open, known or ignored" });
  res.json({ ok: true, state: tel.errors.stateOf(req.params.fp) });
});

// The alert rules (lib/healer-checks/clients.js), kept in data/settings.json.
router.post("/api/admin/telemetry/alert-rules", adminOnly, (req, res) => {
  res.json({ ok: true, alertRules: tel.saveAlertSettings(req.body || {}) });
});

module.exports = router;
module.exports._internals = { overLimit, PER_MINUTE };
