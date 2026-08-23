// Aurora Wrapped — your viewing, aggregated and lovingly roasted. Year-round
// (elia's spec: "playful and insulting"), and honest about its window: the
// header says "since <date>" because the session store is a ring buffer.
import { el } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { navigate } from "../router.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const hrs = (sec) => Math.round(sec / 3600);
const fmtH = (sec) => {
  const h = sec / 3600;
  return h >= 10 ? Math.round(h) + " hours" : h >= 1 ? h.toFixed(1) + " hours" : Math.round(sec / 60) + " minutes";
};

// The roast engine: rules over the stats, worst behavior first. Playful and
// insulting BY REQUEST — this is elia's household, they can take it.
const roastsFor = (w, name) => {
  const out = [];
  const topShare = w.topTitles.length && w.totalSec > 0 ? w.topTitles[0].sec / w.totalSec : 0;

  if (w.started >= 5 && w.finished > 0 && w.started > w.finished * 2) {
    out.push(`You've started ${w.started} things and finished ${w.finished}. Commitment issues, but make it streaming.`);
  } else if (w.started >= 8 && w.finished === 0) {
    out.push(`${w.started} titles started. Zero finished. Bold strategy.`);
  }
  if (w.latestFinish && w.latestFinish.hour >= 1 && w.latestFinish.hour <= 5) {
    out.push(`You once finished “${w.latestFinish.title}” at ${w.latestFinish.hour}am. The sunrise saw everything.`);
  }
  if (w.lateNightSessions >= 5) {
    out.push(`${w.lateNightSessions} sessions started after midnight. You and 3am are basically in a relationship.`);
  }
  if (w.biggestDay && w.biggestDay.sec >= 4 * 3600) {
    out.push(`On ${new Date(w.biggestDay.day).toLocaleDateString([], { month: "long", day: "numeric" })} you watched ${fmtH(w.biggestDay.sec)}. The sun called — you let it go to voicemail.`);
  }
  if (w.bestStreak >= 7) {
    out.push(`${w.bestStreak} days in a row. The couch has permanently taken your shape.`);
  }
  if (topShare > 0.4 && w.topTitles[0]) {
    out.push(`“${w.topTitles[0].name}” is ${Math.round(topShare * 100)}% of everything you've watched. It's not a phase, mom.`);
  }
  if (w.byDevice[0] && w.byDevice[0].name === "Mobile" && w.byDevice.length > 1) {
    out.push(`Mostly watched on your phone. There's a beautiful big TV right there, ${name}. It misses you.`);
  }
  if (w.distinctTitles <= 3 && w.plays >= 10) {
    out.push(`${w.plays} sessions across ${w.distinctTitles} titles. Variety is overrated anyway.`);
  }
  if (!out.length) {
    out.push(`Honestly? Nothing to roast. Balanced viewing, reasonable hours. Who ARE you, ${name}?`);
  }
  return out.slice(0, 4);
};

const bigCard = (value, label, sub) =>
  el("div", { class: "wrapped-card" },
    el("div", { class: "wrapped-num" }, value),
    el("div", { class: "wrapped-label" }, label),
    sub && el("div", { class: "wrapped-sub" }, sub),
  );

export const renderWrapped = async (root) => {
  const screen = el("div", { class: "screen wrapped page-pad" });
  root.append(screen);
  if (!state.profile) {
    screen.append(el("div", { class: "empty" }, el("div", { class: "glyph" }, "👤"), "Pick a profile first."));
    return;
  }
  let w;
  try { w = await api.wrapped(state.profile.id); }
  catch { screen.append(el("div", { class: "empty" }, "Couldn't load your stats.")); return; }

  const name = state.profile.name;
  if (w.empty) {
    screen.append(
      el("h1", { class: "wrapped-title" }, "Aurora Wrapped"),
      el("div", { class: "empty" }, el("div", { class: "glyph" }, "🌌"),
        `Nothing to wrap yet, ${name} — watch something and come back.`),
    );
    return;
  }

  const since = new Date(w.since).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
  screen.append(
    el("h1", { class: "wrapped-title" }, "Aurora Wrapped"),
    el("p", { class: "wrapped-since" }, `${name} · since ${since}`),
    el("div", { class: "wrapped-grid" },
      bigCard(fmtH(w.totalSec), "watched", `${w.plays} sessions · ${w.activeDays} days with at least one`),
      bigCard(String(w.distinctTitles), "different titles", w.topTitles[0] ? `“${w.topTitles[0].name}” on top with ${fmtH(w.topTitles[0].sec)}` : null),
      bigCard(DAYS[w.topWeekday], "is your night", null),
      bigCard(String(w.bestStreak), w.bestStreak === 1 ? "day streak" : "day streak", w.biggestDay ? `biggest day: ${fmtH(w.biggestDay.sec)}` : null),
      w.topGenres.length ? bigCard(w.topGenres[0].name, "your genre", w.topGenres.slice(1, 3).map((g) => g.name).join(" · ") || null) : null,
      w.longestSession ? bigCard(fmtH(w.longestSession.watchedSec), "longest sitting", `“${w.longestSession.title}”`) : null,
    ),
    el("h2", { class: "row-title", style: { padding: 0, marginTop: "26px" } }, "The intervention section"),
    el("div", { class: "wrapped-roasts" },
      ...roastsFor(w, name).map((r) => el("div", { class: "wrapped-roast" }, r)),
    ),
    el("div", { class: "detail-actions", style: { padding: "26px 0" } },
      el("button", { class: "btn btn-primary focusable", html: "<span>Back to browsing</span>", onclick: () => navigate("#/") }),
    ),
  );
};
