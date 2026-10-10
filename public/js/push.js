// Web Push on this device: "your download is ready" with Aurora closed.
// The server sends an empty, signed tickle; the service worker (sw.js) asks
// /api/push/pending what to say. See src/lib/push.js.
//
// iPhone and iPad only offer this to a site added to the Home Screen (iOS
// 16.4+): in a Safari tab PushManager does not exist, and `needsInstall()`
// says so, so the settings row can explain instead of failing.
import { api } from "./api.js";
import { state } from "./state.js";

const FLAG = "aurora-push";

export const supported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
export const needsInstall = () => !supported() && isIos() && !standalone();

const keyBytes = (b64u) => {
  const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob((b64u + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const registration = async () => (await navigator.serviceWorker.getRegistration()) || navigator.serviceWorker.ready;

export const isOn = async () => {
  if (!supported() || Notification.permission !== "granted") return false;
  try {
    const reg = await registration();
    return !!(reg && (await reg.pushManager.getSubscription()));
  } catch {
    return false;
  }
};

// The cheap, synchronous answer for code that must not await (main.js decides
// whether to raise its own in-tab notification).
export const flagOn = () => {
  try { return localStorage.getItem(FLAG) === "1"; } catch { return false; }
};

export const enable = async () => {
  if (!supported()) throw new Error(needsInstall() ? "Add Aurora to your Home Screen first (Share → Add to Home Screen), then switch this on from there" : "This browser can't receive notifications");
  if (!state.profile) throw new Error("Pick a profile first");
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission().catch(() => "denied");
  if (perm !== "granted") throw new Error("Notifications are blocked for Aurora in this browser's settings");
  const reg = await registration();
  const { publicKey } = await api.pushKey();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.pushSet(state.profile.id, { endpoint: sub.endpoint, test: true });
  try { localStorage.setItem(FLAG, "1"); } catch {}
  return true;
};

export const disable = async () => {
  try { localStorage.setItem(FLAG, "0"); } catch {}
  if (!supported()) return;
  try {
    const reg = await registration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (!sub) return;
    if (state.profile) await api.pushSet(state.profile.id, { endpoint: sub.endpoint, on: false }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  } catch {}
};

// A profile switch on this device: the subscription follows whoever is here.
// Called whenever a profile is entered (main.js, on "aurora-profile"). The
// server files this browser's one endpoint under the profile that sends it
// and forgets the previous owner, so "ready" notifications stop going to
// whoever switched them on once somebody else is using the browser.
export const rebind = async () => {
  if (!flagOn() || !state.profile || !(await isOn())) return;
  const pid = state.profile.id;
  try {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    if (sub && state.profile && state.profile.id === pid) await api.pushSet(pid, { endpoint: sub.endpoint });
  } catch {}
};

// Signing out on this device: the server forgets this browser for the
// profile — nobody signed in, nobody to notify. The browser's own
// subscription and the switch are left alone, so whoever enters next (or the
// same person, signing back in) is bound again by rebind(). Must run BEFORE
// the sign-out itself: afterwards the server would refuse it.
export const release = async () => {
  if (!flagOn() || !state.profile || !(await isOn())) return;
  try {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api.pushSet(state.profile.id, { endpoint: sub.endpoint, on: false });
  } catch {}
};
