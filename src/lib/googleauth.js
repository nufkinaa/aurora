// Google, as the sign-in routes use it (auth-round, 2026-10-31): the two OAuth
// clients, the four calls Aurora makes to Google, and the address the browser
// is sent to. routes/auth.js used to make these calls inline; they live here
// so the phone app's flow, the website's popup and the TV's code flow share
// one set — and so a PRIVATE TEST INSTANCE can answer them itself (the mock,
// lib/googlemock.js), because no test can sign in to a real Google account.
//
// Two Google OAuth clients, two explicit .env pairs (elia's model):
//   GOOGLE_WEB_CLIENT_ID / GOOGLE_WEB_CLIENT_SECRET
//     — a "Web application" client: the browser popup AND the phone app's
//       Custom Tab (both come back to /api/auth/google/web-callback, the one
//       redirect URI registered for it — the phone needs no console change).
//   GOOGLE_TV_CLIENT_ID / GOOGLE_TV_CLIENT_SECRET
//     — a "TVs and Limited Input devices" client: the code flow, used by the
//       TV app and by devices that reach the server by raw IP.
// The old single GOOGLE_CLIENT_ID/SECRET pair still works as a fallback for
// either.
"use strict";
const mock = require("./googlemock");

const upstreamFetch = (url, init) => require("./upstream").fetch(url, init);

const ids = () => {
  if (mock.active()) {
    return { tv: mock.TV_CLIENT, tvSecret: null, web: mock.WEB_CLIENT, webSecret: "mock-secret" };
  }
  return {
    tv: process.env.GOOGLE_TV_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || null,
    tvSecret: process.env.GOOGLE_TV_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || null,
    web: process.env.GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || null,
    webSecret: process.env.GOOGLE_WEB_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || null,
  };
};

// Where the browser goes to sign in. `origin` is this server's own origin as
// the browser sees it (the mock's page is served by this server).
const authUrl = ({ redirectUri, state, origin }) => {
  const u = new URL(mock.active() ? `${origin}${mock.AUTH_PATH}` : "https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", ids().web);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "select_account");
  return u.toString();
};

// The device-code start. Throws an Error with `.google` on Google's refusal
// (the #1 setup trap: a client of the wrong TYPE).
const deviceStart = async () => {
  if (mock.active()) return mock.deviceStart();
  const r = await upstreamFetch("https://oauth2.googleapis.com/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: ids().tv, scope: "openid email profile" }),
    timeoutMs: 8000,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const wrongType = d.error === "invalid_client";
    const err = new Error(
      wrongType
        ? "the Google OAuth client is the wrong TYPE — it must be created as “TVs and Limited Input devices” (see the admin panel)"
        : `Google refused: ${d.error_description || d.error || r.status}`,
    );
    err.google = d.error || String(r.status);
    throw err;
  }
  return d;
};

// One poll of a device code: Google's token answer ({error} or {id_token}).
const devicePoll = async (deviceCode) => {
  if (mock.active()) return mock.devicePoll(deviceCode);
  const { tv, tvSecret } = ids();
  const r = await upstreamFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: tv,
      ...(tvSecret ? { client_secret: tvSecret } : {}),
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    timeoutMs: 8000,
  });
  return r.json();
};

// The web flow's code → Google's token answer.
const exchangeCode = async (code, redirectUri) => {
  if (mock.active()) return mock.exchangeCode(code, redirectUri);
  const { web, webSecret } = ids();
  const tr = await upstreamFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: web,
      client_secret: webSecret || "",
      code: String(code || ""),
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    timeoutMs: 8000,
  });
  return tr.json();
};

// Let Google validate its own token over HTTPS (household scale — no local
// JWKS machinery to rot) → { aud, sub, email, name, … }.
const tokenInfo = async (idToken) => {
  if (mock.active()) return mock.tokenInfo(idToken);
  return upstreamFetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
    { timeoutMs: 8000 },
  ).then((x) => x.json());
};

module.exports = { ids, authUrl, deviceStart, devicePoll, exchangeCode, tokenInfo, mockActive: () => mock.active() };
