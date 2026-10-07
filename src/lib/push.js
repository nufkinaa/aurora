// Web Push: "your download is ready" on the lock screen of a phone or the
// corner of a laptop, without the tab being open (elia, 2026-10-07).
//
// No dependency and no payload encryption: the push itself is EMPTY — a
// tickle signed with this server's VAPID key — and the service worker asks
// the server what to say (/api/push/pending) when it wakes. The message waits
// in data/push.json under the sha256 of the subscription's endpoint, which
// only that browser and this server know. An empty push needs nothing but a
// signed JWT, so the whole protocol is a dozen lines of node:crypto.
//
// Subscriptions belong to a profile; a push service that answers 404/410
// (the browser unsubscribed, the app was removed) drops the subscription.
"use strict";
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { JsonStore } = require("./jsonstore");

const store = new JsonStore(path.join(config.DATA_DIR, "push.json"), { vapid: null, subs: [], pending: {} });
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const MAX_PENDING = 5;
const PENDING_TTL_MS = 3 * 24 * 3600 * 1000;

const vapid = () => {
  if (!store.data.vapid) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = privateKey.export({ format: "jwk" });
    const pub = publicKey.export({ format: "jwk" });
    // the browser wants the raw uncompressed point: 0x04 | X | Y
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
    store.data.vapid = { publicKey: b64u(raw), jwk };
    store.save();
  }
  return store.data.vapid;
};

const keyOf = (endpoint) => crypto.createHash("sha256").update(String(endpoint)).digest("hex");

const jwtFor = (endpoint) => {
  const v = vapid();
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: config.PUSH_CONTACT || "mailto:admin@aurora.invalid" }));
  const key = crypto.createPrivateKey({ key: v.jwk, format: "jwk" });
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
};

const okEndpoint = (endpoint) => {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && String(endpoint).length < 1200;
  } catch {
    return false;
  }
};

const subscribe = (profileId, endpoint, ua) => {
  if (!profileId || !okEndpoint(endpoint)) return { error: "bad subscription" };
  const key = keyOf(endpoint);
  store.data.subs = (store.data.subs || []).filter((s) => s.key !== key);
  store.data.subs.push({ key, endpoint, profileId, ua: String(ua || "").slice(0, 160), at: Date.now() });
  store.save();
  return { ok: true };
};

const unsubscribe = (endpoint) => {
  const key = keyOf(endpoint);
  const before = (store.data.subs || []).length;
  store.data.subs = (store.data.subs || []).filter((s) => s.key !== key);
  if (store.data.pending) delete store.data.pending[key];
  if (store.data.subs.length !== before) store.save();
  return { ok: true };
};

const dropProfile = (profileId) => {
  for (const s of (store.data.subs || []).filter((x) => x.profileId === profileId)) unsubscribe(s.endpoint);
};

const countFor = (profileId) => (store.data.subs || []).filter((s) => s.profileId === profileId).length;

// What the service worker reads when the tickle lands — and clears.
const takePending = (key) => {
  const p = store.data.pending || {};
  const list = (p[key] || []).filter((m) => Date.now() - m.at < PENDING_TTL_MS);
  if (p[key]) {
    delete p[key];
    store.save();
  }
  return list;
};

const tickle = async (sub) => {
  try {
    const r = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: "86400",
        Urgency: "normal",
        "Content-Length": "0",
        Authorization: `vapid t=${jwtFor(sub.endpoint)}, k=${vapid().publicKey}`,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 404 || r.status === 410) unsubscribe(sub.endpoint);
    else if (!r.ok) console.warn(`[push] ${new URL(sub.endpoint).host} answered ${r.status}`);
  } catch (e) {
    console.warn("[push] send failed:", e && e.message);
  }
};

// { title, body, url, tag } to every device this profile switched on.
const send = (profileId, msg) => {
  const subs = (store.data.subs || []).filter((s) => s.profileId === profileId);
  if (!subs.length) return 0;
  store.data.pending = store.data.pending || {};
  const m = {
    title: String(msg.title || "Aurora").slice(0, 80),
    body: String(msg.body || "").slice(0, 200),
    url: String(msg.url || "/").slice(0, 200),
    tag: String(msg.tag || "aurora").slice(0, 60),
    at: Date.now(),
  };
  for (const s of subs) {
    const q = store.data.pending[s.key] || (store.data.pending[s.key] = []);
    q.push(m);
    while (q.length > MAX_PENDING) q.shift();
  }
  store.save();
  for (const s of subs) tickle(s); // fire-and-forget
  return subs.length;
};

module.exports = {
  publicKey: () => vapid().publicKey,
  subscribe,
  unsubscribe,
  dropProfile,
  countFor,
  takePending,
  send,
  _internals: { keyOf, jwtFor, store, okEndpoint },
};
