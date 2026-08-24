// Google sign-in helpers shared by the login screen, the request-access form,
// and Preferences' "Connect Google". Two flavors, one picker:
//   web    — the normal popup every site uses (authorization-code redirect).
//            Needs a hostname Google can redirect to: localhost or a real
//            domain, never a raw LAN IP.
//   device — the "type this code on your phone" flow. Works anywhere; it's
//            what the TV uses, and the fallback for IP-address origins.
import { api } from "./api.js";

export const googleFlavor = (info) => {
  if (!info) return null;
  const ipHost = /^(\d{1,3}\.){3}\d{1,3}$/.test(location.hostname);
  if (info.googleWeb && !ipHost) return "web";
  if (info.googleDevice) return "device";
  return null;
};

// Run the web popup flow. Resolves with /web-finish's payload:
//   {ok, user, profile, profileToken}  — a known Google identity, signed in
//   {ok, linked, user}                 — intent "link" completed
//   {ok, signup: {email, name}, pollId} — verified but unknown → request access
export const googleWebFlow = (intent = "login") =>
  new Promise((resolve, reject) => {
    const w = window.open(
      `/api/auth/google/web-start?intent=${encodeURIComponent(intent)}`,
      "aurora-google",
      "width=480,height=680,menubar=no,toolbar=no",
    );
    if (!w) return reject(new Error("The browser blocked the popup — allow popups for Aurora and try again."));
    let settled = false;
    let got = false;
    const cleanup = () => {
      clearInterval(iv);
      window.removeEventListener("message", onMsg);
    };
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(v);
    };
    const onMsg = async (e) => {
      if (e.origin !== location.origin || !e.data || !e.data.auroraGoogle) return;
      got = true;
      try {
        finish(resolve, await api.googleWebFinish(e.data.auroraGoogle.state));
      } catch (err) {
        finish(reject, err);
      }
    };
    // the popup closing without ever messaging us = the person bailed
    const iv = setInterval(() => {
      if (w.closed && !got) finish(reject, new Error("Google sign-in was closed."));
    }, 700);
    window.addEventListener("message", onMsg);
  });
