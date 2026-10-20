// Saves to THIS device, as rows: what is queued, being prepared, landing (with
// the speed), failed (Retry) or cut off by a reload (Resume) — on the "On this
// device" screen (screens/saved.js) and in My downloads (screens/downloads.js).
// The jobs themselves live in offline.js; this only draws them, live.
import { el, toast, fmtBytes } from "./ui.js";
import { untilLeave, navigate } from "./router.js";
import * as offline from "./offline.js";
import { pickOfflineQuality } from "./offlinePicker.js";

const pctOf = (j) => Math.max(0, Math.min(100, Math.round((j.pct || 0) * 100)));
const statusOf = (j) => {
  const p = pctOf(j);
  switch (j.state) {
    case "queued": return { tone: "wait", head: "Waiting for its turn", bar: false };
    // (the server says why it has not started — or why it is paused —
    // instead of a "Preparing 0%" that never moves)
    case "preparing": return j.waiting
      ? { tone: "wait", head: p > 0 ? `Waiting for the server · ${p}%` : "Waiting for the server", line: String(j.note || "").replace(/^waiting for the server(?: — )?/, ""), bar: true, idle: true }
      : { tone: "busy", head: `Preparing on the server · ${p}%`, line: j.note && j.note !== "converting on the server" ? j.note : "", bar: true };
    case "saving": return { tone: "busy", head: `Saving to this device · ${p}%`, line: j.speed > 0 ? `${fmtBytes(j.speed)}/s` : "", bar: true };
    case "failed": return { tone: "bad", head: "Didn't save", line: j.error || "", bar: false };
    case "interrupted": return { tone: "wait", head: "Interrupted", line: `the page was closed or reloaded${p ? ` at ${p}%` : ""} — Resume starts it again`, bar: false };
    default: return { tone: "wait", head: j.state || "", bar: false };
  }
};

const again = (j) => {
  toast(`Saving “${j.title}” again`, "📱");
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
  if (j.state === "interrupted") actions.push(btn("Resume", () => again(j), true));
  if (j.state === "failed" || j.state === "interrupted") actions.push(btn("Dismiss", () => offline.dismissJob(j.id)));
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
export const deviceJobsSection = ({ title = "Saving to this device", withLink = false } = {}) => {
  const list = el("div", { class: "dl-list" });
  const count = el("span", { class: "count" });
  const wrap = el("section", { class: "dl-section device-jobs hidden", "aria-live": "polite" },
    el("h2", { class: "row-title" }, title, count,
      withLink && el("button", { class: "btn small focusable device-jobs-open", onclick: () => navigate("#/saved") }, "Open")),
    list);
  const nodes = new Map(); // id -> { state, node }
  const paint = (jobs) => {
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
    for (const [id, hit] of nodes) if (!seen.has(id)) { hit.node.remove(); nodes.delete(id); }
    count.textContent = String(jobs.length);
    wrap.classList.toggle("hidden", !jobs.length);
  };
  paint(offline.listJobs());
  untilLeave(offline.onJobs(paint));
  return wrap;
};
