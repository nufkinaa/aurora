// Optional, advisory, off by default: a model's two-sentence reading of an
// error the server has never seen before.
//
// Used only when BOTH are true: an OpenRouter key is already configured (the
// one "recommend by mood" uses) AND config.json says "healer": { "ai": true }.
// Then, for a NEW unknown error fingerprint (healer-checks/logs.js), the
// model is asked ONCE what the message probably means and which of the listed
// Actions — if any — is relevant. The hard rules, all enforced here:
//
//   • what is sent is the error's NORMALIZED message only, passed through
//     redact(): no paths, addresses, hostnames, e-mails, tokens or anything
//     key-like. Not the log, not the config, not a title, not a name.
//   • at most DAILY_BUDGET calls a day, counted in data/healer.json.
//   • the answer is TEXT. It is stored beside the fingerprint and shown on
//     the admin page (escaped). It is never executed, never parsed for a
//     command, and cannot start an action: the most it can do is name one of
//     the listed action ids, which becomes a link a person may press.
//   • a failure or a timeout is silent — nothing is logged as an error,
//     nothing is retried, the finding simply has no explanation.
"use strict";

const { PATH_WIN, PATH_POSIX } = require("./util");

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DAILY_BUDGET = 5;
const TIMEOUT_MS = 12000;
const MAX_SENT = 300;
const MAX_ANSWER = 420;

// Strip everything that could identify the house or be a secret. Applied
// even though normalizeMessage has already collapsed most of it: this is the
// last thing between the server and somebody else's API.
const redact = (text) =>
  String(text || "")
    .replace(/[\r\n]+/g, " ")
    // credentials in a URL, then whole URLs
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>")
    // e-mail addresses
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    // Windows and UNC paths, then POSIX paths
    .replace(PATH_WIN, "<path>")
    .replace(PATH_POSIX, "$1<path>")
    .replace(/(^|[\s("'=:,])~?\/[^\s"'<>/]+/g, "$1<path>")
    // IPv4 (with a port), IPv6
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>")
    .replace(/(?<![\w:])(?:[0-9a-f]{0,4}:){2,8}[0-9a-f]{0,4}(?![\w:])/gi, "<ip>")
    // key=value / "token: value" / Bearer …
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 <secret>")
    .replace(/\b([\w-]*(?:key|token|secret|password|passwd|pwd|auth|session|cookie|signature|sig)[\w-]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1=<secret>")
    // JWTs, long hex, long base64-ish runs, Telegram-style bot tokens
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, "<secret>")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "<secret>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, "<secret>")
    // hostnames (anything.with.a.tld), after URLs and e-mails are gone
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|tv|me|dev|app|sh|fun|space|local|lan|home|internal|co|il|uk|de|fr|info|xyz|cloud)\b/gi, "<host>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SENT);

const enabled = (config) => !!(config && config.OPENROUTER_KEY && config.HEALER && config.HEALER.ai === true);

// PURE. The budget for `day`: { ok, next } where next is what to store.
const budget = (state, day, max = DAILY_BUDGET) => {
  const cur = state && state.day === day ? state.n || 0 : 0;
  return cur >= max ? { ok: false, next: { day, n: cur } } : { ok: true, next: { day, n: cur + 1 } };
};

const messagesFor = (message, actions) => [
  {
    role: "system",
    content:
      "You help the owner of a self-hosted home media server (Node.js, ffmpeg, a torrent download engine). " +
      "You are shown ONE error message from its log, with every name, path and address already removed. " +
      "Answer in exactly two short, plain sentences a non-engineer can follow: what it most likely means, and what to check. " +
      "Then, on a new line, write ACTION: followed by the id of the single most relevant action from the list, or ACTION: none. " +
      "Do not invent ids. Do not write commands. Do not ask for more information.",
  },
  { role: "user", content: `Actions:\n${actions.map((a) => `${a.id} — ${a.title}`).join("\n")}\n\nError message:\n${message}` },
];

// PURE. The model's reply -> { text, action } — text capped and flattened,
// action only ever one of the ids that were listed.
const parseAnswer = (reply, actionIds) => {
  const raw = String(reply || "").replace(/```[\s\S]*?```/g, " ");
  const m = /ACTION:\s*([a-z][a-z0-9-]*)/i.exec(raw);
  const named = m ? m[1].toLowerCase() : null;
  const text = raw.replace(/ACTION:.*$/gim, " ").replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER);
  if (!text) return null;
  return { text, action: named && actionIds.includes(named) ? named : null };
};

// Ask once. Resolves { text, action } or null (off, over budget, failed —
// all the same to the caller). `o`: { config, store, fetch, now, actions }.
const explain = async (message, o = {}) => {
  try {
    const config = o.config || require("../../config");
    if (!enabled(config)) return null;
    const store = o.store || require("./store").get();
    const now = o.now || Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const b = budget(store.data.ai, day);
    if (!b.ok) return null;
    store.data.ai = b.next; // counted before the call: a hung provider still costs one
    store.save();
    const actions = o.actions || require("../adminactions").list().actions.map((a) => ({ id: a.id, title: a.title }));
    const sent = redact(message);
    if (!sent) return null;
    const doFetch = o.fetch || fetch;
    const res = await doFetch(ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${config.OPENROUTER_KEY}`, "Content-Type": "application/json", "X-Title": "Aurora healer" },
      body: JSON.stringify({ model: config.AI_MODEL, messages: messagesFor(sent, actions), temperature: 0.2, max_tokens: 220 }),
    });
    if (!res || !res.ok) return null;
    const body = await res.json();
    return parseAnswer(body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content, actions.map((a) => a.id));
  } catch {
    return null; // silent, by rule
  }
};

module.exports = { enabled, explain, redact, budget, parseAnswer, messagesFor, DAILY_BUDGET, ENDPOINT };
