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

// The JWT's `sub` (who to contact about this sender). Apple's push service is
// strict about it and refuses a token whose subject it does not like — the
// placeholder "mailto:admin@aurora.invalid" is the likely reason the first
// iPhone test got nothing (elia, 2026-10-08). So the subject is, in order: the
// configured contact ("pushContact" in config.json, e.g. "mailto:you@…"); the
// site's own https origin, remembered from the subscribing request; and only
// then the placeholder.
const subjectFor = (origin) => {
  const c = String(config.PUSH_CONTACT || "").trim();
  if (/^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/\S+)$/.test(c)) return c;
  if (typeof origin === "string" && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) return origin;
  return "mailto:admin@aurora.invalid";
};
const jwtFor = (endpoint, origin) => {
  const v = vapid();
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subjectFor(origin) }));
  const key = crypto.createPrivateKey({ key: v.jwk, format: "jwk" });
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
};

// A subscription's endpoint is a URL this server will POST to, handed in by
// whoever is signed in — so it may only ever be one of the browsers' real
// push services, never "any https host" (which would let a signed-in person
// aim the server's requests wherever they like). The services, by browser:
//   Chrome, Edge on Android, Brave, Opera, Vivaldi, Samsung Internet (FCM)
//                         fcm.googleapis.com
//   Firefox               updates.push.services.mozilla.com   (*.push.services.mozilla.com)
//   Edge on Windows (WNS) <region>.notify.windows.com         (*.notify.windows.com)
//   Safari, iOS/iPadOS    web.push.apple.com                  (*.push.apple.com)
// A name matches exactly or as a whole-label suffix ("evilpush.apple.com"
// and "push.apple.com.evil.net" do not). Anything else a household turns out
// to need goes in config.json: "pushHosts": ["push.example.com", "*.push.example.net"].
const PUSH_HOSTS = ["fcm.googleapis.com", "*.push.services.mozilla.com", "*.notify.windows.com", "*.push.apple.com"];
const IPV4ISH = /^[0-9.]+$|^0x[0-9a-f]+$/i;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// One rule, "host" or "*.suffix" -> does this hostname pass it?
const hostMatches = (host, rule) => {
  const r = String(rule || "").trim().toLowerCase();
  if (r.startsWith("*.")) {
    const suffix = r.slice(2);
    return HOSTNAME.test(suffix) && host.endsWith(`.${suffix}`);
  }
  return HOSTNAME.test(r) && host === r;
};

// https, a real hostname (no IP literal, no trailing dot), the default port,
// no user:password@, and a host on the list.
const okEndpoint = (endpoint, extraHosts = config.PUSH_HOSTS) => {
  try {
    if (typeof endpoint !== "string" || endpoint.length >= 1200) return false;
    const u = new URL(endpoint);
    if (u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    if (u.port && u.port !== "443") return false; // (URL already drops an explicit :443)
    const host = u.hostname.toLowerCase();
    if (host.startsWith("[") || IPV4ISH.test(host) || !HOSTNAME.test(host)) return false;
    const rules = [...PUSH_HOSTS, ...(Array.isArray(extraHosts) ? extraHosts : [])];
    return rules.some((rule) => hostMatches(host, rule));
  } catch {
    return false;
  }
};

// Subscriptions kept from before the rule (or from a host since taken off the
// list) are dropped, with whatever was waiting for them. Returns how many.
const pruneBadSubs = (data = store.data, extraHosts = config.PUSH_HOSTS) => {
  const subs = Array.isArray(data.subs) ? data.subs : [];
  const good = subs.filter((s) => s && okEndpoint(s.endpoint, extraHosts));
  const dropped = subs.length - good.length;
  if (!dropped) return 0;
  const keys = new Set(good.map((s) => s.key));
  for (const s of subs) if (s && !keys.has(s.key) && data.pending) delete data.pending[s.key];
  data.subs = good;
  return dropped;
};
{
  const dropped = pruneBadSubs();
  if (dropped) {
    console.warn(`[push] dropped ${dropped} subscription(s) whose endpoint is not a known push service`);
    store.save();
  }
}

const subscribe = (profileId, endpoint, ua, origin) => {
  if (!profileId || !okEndpoint(endpoint)) return { error: "bad subscription" };
  const key = keyOf(endpoint);
  store.data.subs = (store.data.subs || []).filter((s) => s.key !== key);
  store.data.subs.push({ key, endpoint, profileId, ua: String(ua || "").slice(0, 160), origin: /^https:\/\//.test(String(origin || "")) ? String(origin).slice(0, 200) : null, at: Date.now() });
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
    if (!okEndpoint(sub.endpoint)) return void unsubscribe(sub.endpoint); // never POST anywhere else
    const r = await fetch(sub.endpoint, {
      method: "POST",
      redirect: "manual", // a push service has no business sending us elsewhere
      headers: {
        TTL: "86400",
        Urgency: "normal",
        "Content-Length": "0",
        Authorization: `vapid t=${jwtFor(sub.endpoint, sub.origin)}, k=${vapid().publicKey}`,
      },
      signal: AbortSignal.timeout(10000),
    });
    // one tally per outcome, for the healer ("subscriptions failing in bulk")
    try { require("./signals").hit("push", r.status === 404 || r.status === 410 ? "gone" : r.ok ? "ok" : `fail:${r.status}`); } catch {}
    if (r.status === 404 || r.status === 410) unsubscribe(sub.endpoint);
    else if (!r.ok) {
      // the push service's own reason (Apple answers {"reason":"BadJwtToken"} and the like) is the whole diagnosis
      const why = await r.text().catch(() => "");
      console.warn(`[push] ${new URL(sub.endpoint).host} answered ${r.status} ${why.slice(0, 160)}`);
    } else console.log(`[push] sent to ${new URL(sub.endpoint).host} (${r.status})`);
  } catch (e) {
    try { require("./signals").hit("push", "fail:network"); } catch {}
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
  _internals: { keyOf, jwtFor, store, okEndpoint, hostMatches, pruneBadSubs, PUSH_HOSTS },
};
