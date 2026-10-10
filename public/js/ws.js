// WebSocket client: presence, activity reporting, live notifications.
import { state, loadLibrary, refreshProgress } from "./state.js";
import { toast } from "./ui.js";
import { backToSignIn, onProfileSignedOut } from "./session.js";
import { wsDown, wsUp } from "./telemetry.js"; // [analytics]

const listeners = new Map(); // type -> Set<fn>

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

const handle = (data) => {
  const subs = listeners.get(data.type);
  if (subs) for (const fn of subs) fn(data);

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
    case "library_updated":
      loadLibrary(true).catch(() => {});
      refreshProgress().catch(() => {});
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

// Reconnect with exponential backoff (1s → 30s cap, reset on success), and
// tell the viewer when the server has been unreachable for a while instead
// of leaving screens silently stale. NOTE the kicked-handler's reload above:
// a flapping server must never become a reload loop — reloads happen only on
// an explicit kick, never from here.
let reconnectDelay = 1000;
let failedAttempts = 0;

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
      // Coming back after a real outage: the library may have moved on while
      // we were blind — refresh state AND repaint (home re-renders its rows
      // off this same event).
      if (wasDown) {
        loadLibrary(true).catch(() => {});
        refreshProgress().catch(() => {});
        try {
          handle({ type: "library_updated" });
        } catch {}
      }
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
      if (failedAttempts >= 2) showOfflineBanner();
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };
    ws.onerror = () => {};
  } catch {}
};
