// The sign-in audit log (auth-round, 2026-10-31): password resets asked for,
// approved, declined and finished; passwords set and changed; Google sign-ups;
// codes given out. The admin reads it per person in People. NEVER a secret in
// it: no password, no token, no code, no ticket — what happened, to which
// profile, how, from which address and device. The last 400 events, kept in
// data/auth-log.json.
"use strict";
const path = require("path");
const config = require("../config");
const { JsonStore } = require("./jsonstore");

const MAX = 400;
const store = new JsonStore(path.join(config.DATA_DIR, "auth-log.json"), () => ({ events: [] }), { kind: "state" });
if (!Array.isArray(store.data.events)) store.data.events = [];

// What may ride an event: a fixed set of short, non-secret fields.
const KEYS = ["profileId", "via", "ip", "device", "by", "outcome", "others"];
const add = (type, fields = {}) => {
  const e = { at: Date.now(), type: String(type).slice(0, 40) };
  for (const k of KEYS) {
    if (fields[k] == null) continue;
    const v = fields[k];
    e[k] = typeof v === "number" || typeof v === "boolean" ? v
      : String(typeof v === "object" ? [v.browser, v.os].filter(Boolean).join(" on ") || v.device || "" : v).slice(0, 60);
  }
  store.data.events.push(e);
  if (store.data.events.length > MAX) store.data.events.splice(0, store.data.events.length - MAX);
  store.save();
  // one line for the server log as well (same fields: nothing secret)
  console.log(`[auth] ${e.type}${e.profileId ? ` profile=${e.profileId}` : ""}${e.via ? ` via=${e.via}` : ""}${e.outcome ? ` ${e.outcome}` : ""}`);
  return e;
};
const forProfile = (profileId, n = 12) =>
  store.data.events.filter((e) => e.profileId === profileId).slice(-n).reverse();
const recent = (n = 50) => store.data.events.slice(-n).reverse();

module.exports = { add, forProfile, recent, _internals: { store } };
