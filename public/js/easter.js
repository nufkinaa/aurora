// The narrator. Every hidden message and every rule that fires one lives here,
// and nowhere else.
//
// SAFETY CONTRACT — this file is jokes, not features. Nothing in here may ever
// break a real interaction, so:
//   • every exported function swallows its own errors and returns quietly
//   • every call site wraps the call in try/catch as well (belt and braces)
//   • nothing here writes to the server; the only persistence is localStorage
//   • it never touches playback — the player is deliberately joke-free, because
//     when a stream misbehaves you want information, not comedy
//
// Frequency is the whole game with this stuff: a gag that fires twice is funny,
// one that fires every time is a bug with a personality. Most triggers are
// capped at once per profile per day (see `firedToday`).
import { toast } from "./ui.js";
import { state } from "./state.js";
import { api } from "./api.js";

const KEY = "aurora-narrator";

// ---------------------------------------------------------------- storage
// One small localStorage blob per browser. Corrupt or unavailable storage
// (private mode, quota) must degrade to "no jokes", never to an exception.
const read = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    return {};
  }
};
const write = (data) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {}
};

const today = () => new Date().toISOString().slice(0, 10);
const pid = () => (state.profile && state.profile.id) || "anon";

// True the FIRST time a given trigger asks, per profile, per day.
const firedToday = (trigger) => {
  const data = read();
  const k = `${pid()}:${trigger}`;
  if (data[k] === today()) return false;
  data[k] = today();
  write(data);
  return true;
};

// A plain counter that survives reloads (rating churn, dice spam).
const bump = (counter) => {
  const data = read();
  const k = `n:${pid()}:${counter}`;
  data[k] = (data[k] || 0) + 1;
  write(data);
  return data[k];
};
const resetCount = (counter) => {
  const data = read();
  delete data[`n:${pid()}:${counter}`];
  write(data);
};

const say = (msg, emoji) => toast(msg, emoji || "🍿");

// ---------------------------------------------------------------- triggers

// Changing your mind about a rating, over and over, on the same title.
const RATING_CHURN = [
  [6, "You've rated this six times. It's a film, not a hostage negotiation."],
  [10, "Ten ratings on one title. The stars are not going to tell you how you feel."],
  [15, "Fifteen. At this point just marry it."],
];
export function onRate(itemKey) {
  try {
    if (!itemKey) return;
    const n = bump(`rate:${itemKey}`);
    const hit = RATING_CHURN.find(([at]) => at === n);
    if (hit) say(hit[1], "⭐");
  } catch {}
}

// Hours watched today, checked when the app loads and when you come back to it.
const BINGE = [
  [8 * 3600, "Eight hours today. That's a full shift. Shall we sort out a payslip?"],
  [6 * 3600, "Six hours. The sofa has your exact shape now."],
  [4 * 3600, "Four hours today. The sun came up, did its thing, and left. You were here."],
];
export function onWatchTime(watchSec) {
  try {
    const hit = BINGE.find(([at]) => watchSec >= at);
    if (!hit) return;
    // Keyed by threshold, so 4h fires once and 6h can still land later.
    if (firedToday(`binge:${hit[0]}`)) say(hit[1], "🛋️");
  } catch {}
}

// The clingy one: you vanished, and it noticed.
const AWAY = [
  [90, "Ninety days. NINETY. I'd almost moved on. Almost."],
  [30, "A month. Your Continue Watching row has been sitting there like an unread message."],
  [14, "Two weeks. The watchlist waited. I waited. Nobody else did, but I did."],
  [7, (d) => `${d} days. Not that anyone was counting. (It was ${d}.)`],
];
export function onReturn(awayDays) {
  try {
    const d = Number(awayDays) || 0;
    const hit = AWAY.find(([at]) => d >= at);
    if (!hit) return;
    const msg = typeof hit[1] === "function" ? hit[1](d) : hit[1];
    // No daily cap: coming back after a week is already rare enough.
    say(msg, "👀");
  } catch {}
}

// Nothing good is chosen at 3am.
export function onLateNight() {
  try {
    const h = new Date().getHours();
    if (h < 2 || h >= 5) return;
    if (!firedToday("late")) return;
    say(
      h < 3
        ? "It's past two. Whatever you pick now is entirely on you."
        : "It's gone three. Statistically, your taste gets worse from here.",
      "🌙"
    );
  } catch {}
}

// A watchlist that only ever grows.
export function onListGraveyard(savedCount, startedCount) {
  try {
    if (savedCount < 15 || startedCount > 0) return;
    if (!firedToday("graveyard")) return;
    say(
      `${savedCount} titles saved and not one of them opened. That's not a watchlist, it's a shrine.`,
      "⚰️"
    );
  } catch {}
}

// Someone who loves everything, or nothing.
export function onRatingSpread() {
  try {
    const vals = Object.values(state.ratings || {});
    if (vals.length < 6) return;
    if (vals.every((v) => v === 5)) {
      if (firedToday("all5")) {
        say("Everything is five stars. Your standards are a rumour.", "⭐");
      }
    } else if (vals.every((v) => v <= 2)) {
      if (firedToday("all1")) {
        say("Nothing here is good enough for you. And yet, here you are. Again.", "💀");
      }
    }
  } catch {}
}

// Third strike on a password.
export function onWrongPassword() {
  try {
    const n = bump("badpw");
    if (n === 3) say("Third attempt. Are we completely sure this is your profile?", "🔒");
    if (n === 6) say("Six. I'm not saying it's not your profile. I'm just watching, is all.", "🔒");
  } catch {}
}
export function onGoodPassword() {
  try {
    resetCount("badpw");
  } catch {}
}

// Rolling the dice instead of deciding.
export function onSurprise() {
  try {
    const n = bump("dice");
    if (n === 5) say("Five rolls. The dice are fine. You're the problem.", "🎲");
    if (n === 10) say("Ten. Just pick one. Any one. I'll wait.", "🎲");
  } catch {}
}
export function onSurpriseAccepted() {
  try {
    resetCount("dice");
  } catch {}
}

// Marking something watched that you plainly did not watch.
export function onMarkWatched(progressSec, durationSec) {
  try {
    if (!durationSec || durationSec < 600) return; // shorts don't count
    const seen = Number(progressSec) || 0;
    if (seen > 120) return;
    say(
      seen < 5
        ? "You didn't watch a single second of that. Marked watched anyway. Incredible."
        : `${Math.round(seen)} seconds. Marking that watched is a lie you'll have to carry.`,
      "🤥"
    );
  } catch {}
}

// Asks the server how long today has been. Fire-and-forget: if the request
// fails, or the endpoint isn't there, nothing happens and nobody notices.
export function checkTodaysWatchTime() {
  try {
    const p = state.profile;
    if (!p) return;
    api
      .todayWatchTime(p.id)
      .then((r) => onWatchTime((r && r.watchSec) || 0))
      .catch(() => {});
  } catch {}
}

// Everything that should be considered the moment a profile is entered.
// `awayDays` comes from the unlock response; the rest is already in state.
export function onEnterProfile({ awayDays } = {}) {
  try {
    onReturn(awayDays);
    onLateNight();
    onRatingSpread();
  } catch {}
}
