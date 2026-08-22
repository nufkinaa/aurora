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

export const connect = () => {
  try {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}`);
    state.ws = ws;
    ws.onmessage = (e) => {
      try {
        handle(JSON.parse(e.data));
      } catch {}
    };
    ws.onclose = () => {
      state.ws = null;
      setTimeout(connect, 5000);
    };
    ws.onerror = () => {};
  } catch {}
};
