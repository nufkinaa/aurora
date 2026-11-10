// Home's remark, the website's side. The words come from the server (src/lib/
// remarks — one voice, one memory of what this person was told, for every
// app); this file keeps the ten-minute hold on this device, sends back the
// ids it was shown (so a restarted server still does not repeat itself), and
// has a few lines of its own for the moment before the server answers, or
// when it cannot (offline). Every local line is also in the server's bank
// (test/remarks.test.js checks), so the voice is the same either way.
import { api } from "./api.js";

const HOLD_MS = 10 * 60 * 1000;
const SEEN_MAX = 40;

// part of the day → a handful of the best everyday lines (5–12, 12–17, 17–23, 23–5)
const LOCAL = {
  morning: [
    "Morning. Most people start the day. You're previewing it.",
    "Before noon and already avoiding something. Impressive.",
    "You checked here before you checked the weather.",
    "Morning. Your taste is no better rested than you are.",
    "The day is a blank page. You've decided to read instead.",
    "Morning. You'll call it background noise. It never is.",
  ],
  afternoon: [
    "Afternoon. The day had potential. Then you opened this.",
    "You said you'd be productive today. I was there.",
    "Afternoon. I'd suggest a walk. You'd suggest a sequel.",
    "Outside is having a lovely day without you.",
    "Just browsing, you'll say. For forty minutes.",
  ],
  evening: [
    "The couch is preheated.",
    "One episode. Sure. “One.”",
    "You'll scroll past six good films tonight. I'll count.",
    "Big screen, small ambitions. Let's begin.",
    "The remote has seen things. Mostly your indecision.",
    "Tonight's feature: twenty minutes of trailers you'll skip.",
  ],
  night: [
    "Bedtime was a suggestion. You've declined.",
    "Tomorrow-you has opinions. Tonight-you doesn't care.",
    "Midnight is close. Your judgment left an hour ago.",
    "It's past eleven. Pick something short. Or lie to me.",
  ],
  any: [
    "I know what you watched. I'm choosing not to bring it up.",
    "No judgment here. Just a detailed, permanent record.",
    "The play button works. I checked. It was never the problem.",
    "Trust the first instinct. Your fourth is always worse.",
    "Your taste is consistent. I'm being polite.",
    "You'll read every synopsis, then pick by the poster.",
  ],
};
export const LOCAL_LINES = Object.values(LOCAL).flat();

const read = (key, dflt) => { try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? dflt : v; } catch { return dflt; } };
const write = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} };
const heldKey = (id) => `aurora.remark.${id}`;
const seenKey = (id) => `aurora.remarkSeen.${id}`;

const partOf = (h) => (h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 23 ? "evening" : "night");

// A local line for now: this part of the day or any time, never the one this
// tab showed last.
export const localRemark = (now = new Date(), rng = Math.random) => {
  const pool = [...LOCAL[partOf(now.getHours())], ...LOCAL.any];
  let last = null;
  try { last = sessionStorage.getItem("aurora.remarkLocal"); } catch {}
  const choices = pool.filter((t) => t !== last);
  const text = choices[Math.floor(rng() * choices.length) % choices.length];
  try { sessionStorage.setItem("aurora.remarkLocal", text); } catch {}
  return text;
};

// The server's line this device was given less than ten minutes ago, if any.
export const heldRemark = (profileId, now = Date.now()) => {
  const h = read(heldKey(profileId), null);
  return h && typeof h.text === "string" && now - h.at >= 0 && now - h.at < HOLD_MS ? h : null;
};

// Ask the server. Resolves { id, text, kind } or null (offline, 204, an old server).
export const fetchRemark = async (profileId) => {
  const seen = read(seenKey(profileId), []);
  const q = new URLSearchParams({ tzo: String(new Date().getTimezoneOffset()) });
  try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (tz) q.set("tz", tz); } catch {}
  if (Array.isArray(seen) && seen.length) q.set("seen", seen.slice(-SEEN_MAX).join(","));
  let r = null;
  try { r = await api.remark(profileId, q.toString()); } catch { return null; }
  if (!r || typeof r.text !== "string" || !r.text) return null;
  return r;
};

// The line was put on screen: hold it here, and remember its id.
export const noteShown = (profileId, r, now = Date.now()) => {
  if (!r || !r.id) return;
  const held = read(heldKey(profileId), null);
  if (!held || held.id !== r.id) write(heldKey(profileId), { id: r.id, text: r.text, kind: r.kind, at: now });
  const seen = read(seenKey(profileId), []);
  const list = (Array.isArray(seen) ? seen : []).filter((x) => x !== r.id);
  list.push(r.id);
  write(seenKey(profileId), list.slice(-SEEN_MAX));
};
