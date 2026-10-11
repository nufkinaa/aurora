// WebSocket client: presence, activity reporting, live notifications.
import { state, loadLibrary, refreshProgress } from "./state.js";
import { toast } from "./ui.js";
import { backToSignIn, onProfileSignedOut } from "./session.js";
import { wsDown, wsUp } from "./telemetry.js"; // [analytics]

const listeners = new Map(); // type -> Set<fn>
export const _listeners = listeners; // (read-only, for tools/mobile-perf/holders.js and tests: handlers per message type)

export const onMessage = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
};

export const send = (data) => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
  }
};

export const reportActivity = (action, details = null, extra = null) =>
  send({ type: "activity", action, details, ...(extra || {}) });

// ---------- "the library changed": ask again, but not all at once ----------
// The message carries no data; every device answers it by fetching the
// library, its own state and (on Home) Home. When a hundred devices did that
// in the same instant the server stood still for seconds. So each tab waits a
// random 0.5–5 s first — except the one looking at Home (it should change
// under the person's eyes) and the one whose own download just landed: those
// wait a random 0–0.3 s, which nobody sees and which is the difference
// between a hundred devices opening their connections in the same
// millisecond (some are refused at the socket) and over a third of a second. A tab nobody
// is looking at waits until it is looked at. However many messages arrive
// while one refresh is waiting, there is one refresh.
const JITTER_MIN_MS = 500;
const JITTER_MAX_MS = 5000;
const AT_ONCE_MAX_MS = 300;
let refreshTimer = null;
let refreshWhenSeen = false;
let causedUntil = 0;
const onHome = () => /^#?\/?$/.test(location.hash || "");
// How long THIS tab waits. Exported for the tests.
export const refreshDelay = ({ home = onHome(), caused = Date.now() < causedUntil, random = Math.random } = {}) =>
  home || caused ? Math.round(random() * AT_ONCE_MAX_MS) : Math.round(JITTER_MIN_MS + random() * (JITTER_MAX_MS - JITTER_MIN_MS));
const dispatch = (data) => {
  const subs = listeners.get(data.type);
  if (subs) for (const fn of subs) { try { fn(data); } catch {} }
};
const refreshNow = () => {
  refreshTimer = null;
  loadLibrary(true).catch(() => {});
  refreshProgress().catch(() => {});
  dispatch({ type: "library_updated" }); // the screens that follow the library (Home, the grids, search)
};
const scheduleRefresh = () => {
  if (refreshTimer) return; // one is already on its way
  if (document.visibilityState === "hidden") { refreshWhenSeen = true; return; }
  refreshTimer = setTimeout(refreshNow, refreshDelay());
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !refreshWhenSeen) return;
  refreshWhenSeen = false;
  scheduleRefresh();
});

const handle = (data) => {
  // (library_updated reaches its listeners from refreshNow, after the wait)
  if (data.type === "library_updated") return scheduleRefresh();
  // A download this profile asked for has landed: the library change that
  // follows is this tab's own — it is waiting for it, so it does not wait.
  if (data.type === "download_update" && data.job && data.job.mine && data.job.status === "done") causedUntil = Date.now() + 15000;
  dispatch(data);

  switch (data.type) {
    case "welcome":
      state.clientId = data.clientId || null; // this socket's name on the server
      if (state.profile) send({ type: "hello", profile: state.profile.name, profileId: state.profile.id });
      break;
    case "subtitle_ocr":
      if (data.status === "started") toast(`Writing subtitles for ${data.name}…`, "💬");
      else if (data.status === "done") toast(`Subtitles are in for ${data.name}`, "✅");
      else if (data.status === "failed") toast(`Couldn't generate subtitles for ${data.name}`, "⚠️");
      break;
    // The server is about to restart (lib/shutdown.js): it closes this socket
    // next. Not an outage — no banner for the first tries, and the first
    // reconnect waits what the server suggests plus a random bit.
    case "server_restarting":
      restartingUntil = Date.now() + 60000;
      restartRetryMs = Math.min(15000, Math.max(500, Number(data.retryInMs) || 2000));
      break;
    case "admin_message":
      toast(data.message, "📢");
      break;
    case "kicked":
      // `reset`: the admin asked this profile for a new password — it is
      // signed out everywhere, and the next sign-in is met by resetwall.js
      backToSignIn(data.reset
        ? `${state.adminName} asked for a new password — sign in again to choose one`
        : `${state.adminName} pulled the plug on this session`, data.reset ? "🔑" : "🚫");
      break;
    // "Sign out everywhere else", pressed on another device of this profile
    case "profile_signed_out":
      onProfileSignedOut(data.profileId);
      break;
    case "banned": {
      document.body.innerHTML =
        `<div style="display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">` +
        `<div><div style="font-size:3rem">🚫</div><h2>Access denied</h2>` +
        `<p style="color:#9aa1b5;margin-top:8px"></p></div></div>`;
      // textContent, not markup — the reason is admin-typed free text.
      document.body.querySelector("p").textContent =
        data.reason || "You have been banned from this server.";
      break;
    }
  }
};

// Hand a message to this tab's own listeners, as if the server had sent it.
// For state caught up on by asking (the download list after an outage): the
// screens that listen to the live messages hear about it the same way.
export const emit = (data) => { try { handle(data); } catch {} };

// Reconnect with exponential backoff AND jitter: the wait doubles (1s → 30s
// cap, reset on success), and each tab waits a random part of it — between
// half and all — so the devices of a household that lost the server together
// (a restart) do not all come back in the same instant, then again in the
// same instant a second later. Tell the viewer when the server has been
// unreachable for a while instead of leaving screens silently stale. NOTE the kicked-handler's reload above:
// a flapping server must never become a reload loop — reloads happen only on
// an explicit kick, never from here.
let reconnectDelay = 1000;
let failedAttempts = 0;
let restartingUntil = 0; // the server said it is restarting: expected, for a minute
let restartRetryMs = 2000;
// The wait before the next try. Exported for the tests.
export const reconnectWait = (base, random = Math.random) => Math.round(base / 2 + random() * (base / 2));

const BANNER_ID = "offline-banner";
const showOfflineBanner = () => {
  if (document.getElementById(BANNER_ID)) return;
  const b = document.createElement("div");
  b.id = BANNER_ID;
  b.textContent = "Can't reach the Aurora server — retrying… ";
  if (window.isSecureContext && "serviceWorker" in navigator) {
    const a = document.createElement("a");
    a.href = "#/saved";
    a.textContent = "Saved titles still play";
    a.style.cssText = "color:#fff;text-decoration:underline;margin-left:6px";
    b.append(a);
  }
  // styled in screens.css (#offline-banner): the bottom edge on desktop and
  // TV, ABOVE the floating tab bar on a glass phone — it used to sit on top
  // of Home/Movies/Shows there
  document.body.append(b);
};
const hideOfflineBanner = () => document.getElementById(BANNER_ID)?.remove();

// Drop the socket and let the reconnect below open a new one. The server
// reads who a socket belongs to once, when it connects — so a tab that signs
// in AFTER connecting (the sign-in screen of a server that requires sign-in
// comes up after the socket) has to connect again to be known: until it did,
// such a tab got no live updates at all and was missing from the admin's
// list of who is connected.
let planned = false; // a close we asked for: connect again at once, it is not an outage
export const reconnect = () => {
  if (!state.ws) return; // already between sockets — the next one connects signed in
  planned = true;
  try { state.ws.close(); } catch { planned = false; }
};

export const connect = () => {
  try {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}`);
    state.ws = ws;
    ws.onopen = () => {
      wsUp(); // [analytics] lost → back, as a timing
      const wasDown = failedAttempts >= 2;
      const wasRestart = restartingUntil > 0;
      restartingUntil = 0;
      hideOfflineBanner();
      // Only a socket that STAYS open earns a backoff reset — the server has
      // accept-then-close paths (bans), and resetting on a doomed open would
      // hammer it at 1s forever.
      setTimeout(() => {
        if (state.ws === ws && ws.readyState === WebSocket.OPEN) {
          reconnectDelay = 1000;
          failedAttempts = 0;
        }
      }, 5000);
      // Coming back after a real outage (or a restart): the library may have
      // moved on while we were blind — refresh state AND repaint, through the
      // same spread-out refresh a library change gets (every device comes
      // back at about the same time).
      if (wasDown || wasRestart) scheduleRefresh();
    };
    ws.onmessage = (e) => {
      try {
        handle(JSON.parse(e.data));
      } catch {}
    };
    ws.onclose = () => {
      state.ws = null;
      if (planned) {
        planned = false;
        return connect();
      }
      failedAttempts++;
      wsDown(); // [analytics]
      // an announced restart is not "can't reach the server" until it has
      // really taken a while
      const expected = Date.now() < restartingUntil;
      if (failedAttempts >= (expected ? 5 : 2)) showOfflineBanner();
      const wait = expected && failedAttempts === 1
        ? restartRetryMs + Math.round(Math.random() * 3000)
        : reconnectWait(reconnectDelay);
      setTimeout(connect, wait);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };
    ws.onerror = () => {};
  } catch {}
};
