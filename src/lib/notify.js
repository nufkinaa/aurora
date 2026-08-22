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

const send = (title, message) => {
  const n = config.NOTIFICATIONS || {};
  // Keep HTTP headers ASCII-safe (titles can be Hebrew) — details go in the body.
  if (n.ntfy && n.ntfy.topic) {
    fetch(`https://ntfy.sh/${encodeURIComponent(n.ntfy.topic)}`, {
      method: "POST",
      headers: { Title: title, Tags: "clapper" },
      body: message,
      signal: AbortSignal.timeout(10000),
    }).catch((e) => console.warn("[notify] ntfy failed:", e && e.message));
  }
  if (n.telegram && n.telegram.botToken && n.telegram.chatId) {
    fetch(`https://api.telegram.org/bot${n.telegram.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: n.telegram.chatId, text: `${title}\n${message}` }),
      signal: AbortSignal.timeout(10000),
    })
      .then(async (r) => {
        if (!r.ok) console.warn("[notify] telegram failed:", (await r.text()).slice(0, 200));
      })
      .catch((e) => console.warn("[notify] telegram failed:", e && e.message));
  }
};

module.exports = { send };
