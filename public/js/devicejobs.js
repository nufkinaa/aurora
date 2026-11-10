// Saves to THIS device, as rows: what is queued, being prepared, landing (with
// the speed and the time left), waiting for the line (it carries on by
// itself), paused (Resume — and it carries on by itself the next time Aurora
// is open), failed (Retry) — and what this device waits for that the server
// does not have yet (offlineWish.js: "Waiting for the server's copy", Cancel)
// — on the "On this device" screen (screens/saved.js) and in My downloads
// (screens/downloads.js). The jobs live in offline.js; this only draws them, live.
import { el, toast, fmtBytes } from "./ui.js";
import { untilLeave, navigate } from "./router.js";
import * as offline from "./offline.js";
import { pickOfflineQuality } from "./offlinePicker.js";
import * as wishes from "./offlineWish.js";

const pctOf = (j) => Math.max(0, Math.min(100, Math.round((j.pct || 0) * 100)));
const left = (secs) => {
  if (!(secs > 0)) return "";
  if (secs < 60) return "under a minute left";
  if (secs < 3600) return `about ${Math.round(secs / 60)} min left`;
  return `about ${(secs / 3600).toFixed(1)} h left`;
};
const statusOf = (j) => {
  const p = pctOf(j);
  switch (j.state) {
    case "queued": return { tone: "wait", head: "Waiting for its turn", line: j.note && j.note !== "waiting for the server" ? j.note : "", bar: false };
    // (the server says why it has not started — or why it is paused —
    // instead of a "Preparing 0%" that never moves)
    case "preparing": return j.waiting
      ? { tone: "wait", head: p > 0 ? `Waiting for the server · ${p}%` : "Waiting for the server", line: String(j.note || "").replace(/^waiting for the server(?: — )?/, ""), bar: true, idle: true }
      : { tone: "busy", head: `Preparing on the server · ${p}%`, line: j.note && j.note !== "converting on the server" ? j.note : "", bar: true };
    case "saving": return { tone: "busy", head: `Saving to this device · ${p}%`, line: [j.speed > 0 ? `${fmtBytes(j.speed)}/s` : "", left(j.eta)].filter(Boolean).join(" · "), bar: true };
    case "retrying": return { tone: "wait", head: `Waiting for the connection · ${p}%`, line: j.note || "it carries on by itself", bar: true, idle: true };
    case "paused": return { tone: "wait", head: p > 0 ? `Paused at ${p}%` : "Paused", line: "What is saved stays here — it carries on by itself the next time Aurora is open with a connection, or press Resume", bar: p > 0, idle: true };
    case "failed": return { tone: "bad", head: "Didn't save", line: j.error || "", bar: false };
    default: return { tone: "wait", head: j.state || "", bar: false };
  }
};

const again = (j) => {
  toast(j.state === "paused" ? `Carrying on with “${j.title}”` : `Saving “${j.title}” again`, "📱");
  offline.retryJob(j.id, (options) => pickOfflineQuality(options, { title: j.title }))
    .then((saved) => { if (saved) toast(`“${j.title}” is saved on this device`, "📱", { label: "Open", onClick: () => navigate("#/saved") }); })
    .catch((e) => { if (!(e && e.name === "AbortError")) toast(`Couldn't save: ${e.message}`, "⚠️"); });
};

// "Show · S1 E2 · Name" for an episode (as Saved says it), the title for a film
const nameOf = (j) => {
  const it = j.item || {};
  if (!it.showTitle || it.season == null || it.episode == null) return j.title || "";
  const own = it.title && it.title !== it.showTitle && !/^.+ S\d+E\d+$/i.test(it.title) ? ` · ${it.title}` : "";
  return `${it.showTitle} · S${it.season} E${it.episode}${own}`;
};

const row = (j) => {
  const s = statusOf(j);
  const head = el("b", {}, s.head);
  // (why, or how fast: its own line under the state — on a phone it wraps
  // instead of trailing off after a "·")
  const line = el("div", { class: "dl-why", hidden: !s.line }, s.line || "");
  const fill = el("div", { class: "dl-bar-fill", style: { width: `${pctOf(j)}%` } });
  const bar = el("div", { class: `dl-bar${s.idle ? " dl-bar-idle" : ""}`, role: "progressbar", "aria-label": s.head, "aria-valuenow": pctOf(j), "aria-valuemin": 0, "aria-valuemax": 100 }, fill);
  const btn = (text, onclick, primary = false) => el("button", { class: `btn small focusable${primary ? " btn-primary" : ""}`, onclick }, text);
  const actions = [];
  if (offline.ACTIVE_JOB.has(j.state)) actions.push(btn("Cancel", () => offline.cancelJob(j.id)));
  if (j.state === "failed") actions.push(btn("Retry", () => again(j), true));
  if (j.state === "paused") actions.push(btn("Resume", () => again(j), true));
  if (j.state === "failed") actions.push(btn("Dismiss", () => offline.dismissJob(j.id)));
  // (a paused save holds parts on this device: Cancel throws them away)
  if (j.state === "paused") actions.push(btn("Cancel", () => offline.cancelJob(j.id)));
  const node = el("div", { class: `dl-row device-job tone-${s.tone}`, "data-id": j.id, "data-state": j.state },
    el("div", { class: "dl-poster" }, j.cover ? el("img", { src: j.cover, alt: "" }) : el("div", { class: "card-fallback" }, j.title)),
    el("div", { class: "dl-info" },
      el("div", { class: "dl-title" }, el("span", { class: "dl-name" }, nameOf(j))),
      el("div", { class: "dl-status" }, s.tone === "busy" ? el("span", { class: "mini-spinner" }) : el("i", { class: "dl-dot", "aria-hidden": "true" }), head),
      line,
      s.bar && bar),
    actions.length > 0 && el("div", { class: "dl-actions" }, actions));
  // the numbers move in place; anything else is a new row
  node._update = (n) => {
    const t = statusOf(n);
    head.textContent = t.head;
    line.textContent = t.line || "";
    line.hidden = !t.line;
    fill.style.width = `${pctOf(n)}%`;
    bar.setAttribute("aria-valuenow", pctOf(n));
    bar.setAttribute("aria-label", t.head);
  };
  return node;
};

// A live section: hidden while there is nothing being saved here.
//   title: its heading · `withLink`: a way to the "On this device" screen
// What this device waits for that is not on the server yet (offlineWish.js).
const wishName = (w) => (w.type === "show"
  ? `${w.showTitle || w.title || "Episode"} · S${w.season}${w.scope === "season" ? "" : ` E${w.episode}`}`
  : w.title || "A film");
const wishStatus = (w) => {
  if (w.state === "failed") return { tone: "bad", head: "Won't arrive", line: w.error || "" };
  if (w.scope === "season") return { tone: "wait", head: `Every new episode of season ${w.season}`, line: "Waiting for the server's copy — each one is saved here by itself as it arrives" };
  if (w.state === "ready") {
    const c = w.copy || {};
    return c.state && c.state !== "ready"
      ? { tone: "busy", head: "Arrived — the server is preparing it", line: [w.note, "it is saved here by itself"].filter(Boolean).join(" · ") }
      : { tone: "busy", head: "Arrived — saving here next", line: w.note || "" };
  }
  return { tone: "wait", head: "Waiting for the server's copy", line: "It is saved here by itself when it arrives" };
};
const wishRow = (w) => {
  const s = wishStatus(w);
  const actions = [];
  if (w.state === "failed") actions.push(el("button", { class: "btn small focusable", "data-ui": "saved.wish.dismiss", onclick: () => wishes.removeWish(w.id) }, "Dismiss"));
  else {
    actions.push(el("button", { class: "btn small focusable", "data-ui": "saved.wish.cancel", onclick: () => {
      wishes.removeWish(w.id);
      toast(`“${wishName(w)}” won't be saved to this device`, "📱");
    } }, "Cancel"));
  }
  return el("div", { class: `dl-row device-job device-wish tone-${s.tone}`, "data-id": `wish:${w.id}`, "data-state": `wish-${w.scope === "season" ? "season" : w.state}` },
    el("div", { class: "dl-poster" }, w.poster ? el("img", { src: w.poster, alt: "" }) : el("div", { class: "card-fallback" }, wishName(w))),
    el("div", { class: "dl-info" },
      el("div", { class: "dl-title" }, el("span", { class: "dl-name", dir: "auto" }, wishName(w))),
      el("div", { class: "dl-status" }, s.tone === "busy" ? el("span", { class: "mini-spinner" }) : el("i", { class: "dl-dot", "aria-hidden": "true" }), el("b", {}, s.head)),
      el("div", { class: "dl-why", hidden: !s.line }, s.line || "")),
    el("div", { class: "dl-actions" }, actions));
};

// A live section: hidden while there is nothing being saved here.
//   title: its heading · `withLink`: a way to the "On this device" screen
export const deviceJobsSection = ({ title = "Saving to this device", withLink = false } = {}) => {
  const list = el("div", { class: "dl-list" });
  const count = el("span", { class: "count" });
  const wrap = el("section", { class: "dl-section device-jobs hidden", "aria-live": "polite" },
    el("h2", { class: "row-title" }, title, count,
      withLink && el("button", { class: "btn small focusable device-jobs-open", onclick: () => navigate("#/saved") }, "Open")),
    list);
  const nodes = new Map(); // id -> { state, node }
  const paint = () => {
    const jobs = offline.listJobs();
    const busy = new Set(jobs.map((j) => j.id));
    // a wish whose title is being saved here shows as that save
    const ws = wishes.listWishes().filter((w) => !(w.state === "ready" && busy.has(w.libraryId)));
    const seen = new Set();
    for (const j of jobs) {
      seen.add(j.id);
      const hit = nodes.get(j.id);
      // (waiting ↔ preparing changes the row's tone: a new row)
      const kind = `${j.state}${j.waiting ? ":wait" : ""}`;
      if (hit && hit.state === kind) { hit.node._update(j); continue; }
      const node = row(j);
      if (hit) hit.node.replaceWith(node);
      else list.append(node);
      nodes.set(j.id, { state: kind, node });
    }
    for (const w of ws) {
      const key = `wish:${w.id}`;
      seen.add(key);
      const kind = `${w.state}|${w.error || ""}|${(w.copy && w.copy.state) || ""}|${w.note || ""}`;
      const hit = nodes.get(key);
      if (hit && hit.state === kind) continue;
      const node = wishRow(w);
      if (hit) hit.node.replaceWith(node);
      else list.append(node);
      nodes.set(key, { state: kind, node });
    }
    for (const [id, hit] of nodes) if (!seen.has(id)) { hit.node.remove(); nodes.delete(id); }
    const n = jobs.length + ws.length;
    count.textContent = String(n);
    wrap.classList.toggle("hidden", !n);
  };
  paint();
  untilLeave(offline.onJobs(paint));
  untilLeave(wishes.onWishes(paint));
  return wrap;
};
