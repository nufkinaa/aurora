// Admin push notifications (download requests / completions / failures).
// Fire-and-forget: never blocks or fails the calling flow.
//
// Configure in config.json:
//   "notifications": {
//     "ntfy":     { "topic": "aurora-xxxx" },                    // ntfy.sh (no signup:
//                     install the ntfy app / open ntfy.sh, subscribe to the topic)
//     "telegram": { "botToken": "123:ABC…", "chatId": "123456" } // Telegram bot
//   }
// Both are optional; every configured channel gets every message.
const config = require("../config");

// Which channels are set up — [] means a message sent here reaches nobody.
const channels = () => {
  const n = config.NOTIFICATIONS || {};
  const out = [];
  if (n.ntfy && n.ntfy.topic) out.push("ntfy");
  if (n.telegram && n.telegram.botToken && n.telegram.chatId) out.push("telegram");
  return out;
};

// What became of the last sends, per channel — so "alerts are not reaching
// anyone" is itself something the healer can see (its "Alert delivery" check).
// Memory only; the healer keeps the last known answer across restarts.
const outcome = {}; // channel -> { lastOkAt, lastFailAt, lastError, failsInARow, sent }
const noteOutcome = (channel, ok, error) => {
  const o = outcome[channel] || (outcome[channel] = { lastOkAt: 0, lastFailAt: 0, lastError: null, failsInARow: 0, sent: 0 });
  o.sent++;
  if (ok) { o.lastOkAt = Date.now(); o.failsInARow = 0; }
  else { o.lastFailAt = Date.now(); o.lastError = String(error || "failed").slice(0, 160); o.failsInARow++; }
};
const outcomes = () => JSON.parse(JSON.stringify(outcome));

// opts (optional): { priority: "urgent" | "high" | "default" | "low", tags: "warning" }
// — ntfy only; health alerts use it so a critical one breaks through.
const send = (title, message, opts = {}) => {
  const n = config.NOTIFICATIONS || {};
  // Keep HTTP headers ASCII-safe (titles can be Hebrew) — details go in the body.
  if (n.ntfy && n.ntfy.topic) {
    fetch(`https://ntfy.sh/${encodeURIComponent(n.ntfy.topic)}`, {
      method: "POST",
      headers: { Title: title, Tags: opts.tags || "clapper", ...(opts.priority ? { Priority: opts.priority } : {}) },
      body: message,
      signal: AbortSignal.timeout(10000),
    })
      .then((r) => {
        // ntfy answers 4xx/5xx without throwing (a topic that is reserved, a rate limit)
        if (r && r.ok === false) { noteOutcome("ntfy", false, `HTTP ${r.status}`); console.warn("[notify] ntfy failed:", `HTTP ${r.status}`); }
        else noteOutcome("ntfy", true);
      })
      .catch((e) => { noteOutcome("ntfy", false, e && e.message); console.warn("[notify] ntfy failed:", e && e.message); });
  }
  if (n.telegram && n.telegram.botToken && n.telegram.chatId) {
    fetch(`https://api.telegram.org/bot${n.telegram.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: n.telegram.chatId, text: `${title}\n${message}` }),
      signal: AbortSignal.timeout(10000),
    })
      .then(async (r) => {
        if (!r.ok) {
          const why = (await r.text()).slice(0, 200);
          noteOutcome("telegram", false, `HTTP ${r.status}`); // never the body: it can echo the bot token's chat
          console.warn("[notify] telegram failed:", why);
        } else noteOutcome("telegram", true);
      })
      .catch((e) => { noteOutcome("telegram", false, e && e.message); console.warn("[notify] telegram failed:", e && e.message); });
  }
};

module.exports = { send, channels, outcomes, _internals: { noteOutcome, outcome } };
