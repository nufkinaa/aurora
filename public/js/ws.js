// WebSocket client: presence, activity reporting, live notifications.
import { state, loadLibrary, refreshProgress } from "./state.js";
import { toast } from "./ui.js";

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
      if (state.profile) send({ type: "hello", profile: state.profile.name });
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
      toast(`${state.adminName} pulled the plug on this session`, "🚫");
      setTimeout(() => location.reload(), 1500);
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
  b.textContent = "Can't reach the Aurora server — retrying…";
  b.style.cssText =
    "position:fixed;bottom:0;left:0;right:0;z-index:9999;padding:6px 12px;" +
    "text-align:center;font-size:0.85rem;font-weight:600;" +
    "background:#5c1f24;color:#ffd7d7;"; // bottom edge: never covers the nav
  document.body.append(b);
};
const hideOfflineBanner = () => document.getElementById(BANNER_ID)?.remove();

export const connect = () => {
  try {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}`);
    state.ws = ws;
    ws.onopen = () => {
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
      failedAttempts++;
      if (failedAttempts >= 2) showOfflineBanner();
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };
    ws.onerror = () => {};
  } catch {}
};
