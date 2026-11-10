// The buttons that put a title on this device (offline-look, 2026-11-10).
//
//   saveButton(item, { variant, ep })   one title: Save to this device →
//       (waiting / saving 43%) → Saved on this device. It wears the one mark
//       (js/offlineUi.js) and is painted from the save itself (offline.js's
//       jobs and index), so it is right wherever the save was started — this
//       page, "Save the season", the On this device screen, another tab.
//         variant "hero"  the title page: mark + the words
//                 "rail"  the action column of a sources card
//                 "ep"    the small round button of an episode row
//                 "menu"  a row of the player's settings menu: the mark, the
//                         words, and what a press does (Stop / Remove…)
//       A press never destroys anything by itself: on a saved title it says
//       so and offers Remove; on a running save it offers Stop.
//   seasonButton(nextEpisodes, showTitle, showId, { pill })   several
//       episodes at one size asked once: "Save the next 3" on a show's page,
//       "Save the season (N)" on the season bar.
//   saveSeveral(items, { signal, sheetTitle, onLine })   the loop under it:
//       several titles one after another at ONE size, asked once — also what
//       "Pack for a trip" runs (js/offlinePack.js).
//
// The saving is js/offline.js (not this file).
import { el, toast, fmtBytes, fmtDuration } from "./ui.js";
import * as offline from "./offline.js";
import { mark, setMark, pop, words, pctOf, ACTIVE, SAVE, SAVED, pickSize, whenIndexed, copyHere, nameOf, hush } from "./offlineUi.js";

const open = () => { location.hash = "#/saved"; };
// the short word under a tile / on a rail
const short = (st, pct, waiting) =>
  st === "saved" ? "Saved"
    : st === "saving" ? `Saving ${pctOf(pct)}%`
      : st === "preparing" ? (waiting ? "Waiting" : "Getting ready")
        : st === "queued" || st === "retrying" ? "Waiting"
          : st === "paused" ? "Paused"
            : st === "failed" ? "Didn't save"
              : "Save to device";
const said = (re) => [...document.querySelectorAll("#toasts .toast")].some((t) => re.test(t.textContent));
// what went wrong, in one line, with the one press that helps
const sayFailure = (e, name) => {
  if (e && e.name === "AbortError") return void (said(/Save cancelled/) || toast("Save cancelled", mark("none")));
  if (e && e.name === "BusyElsewhere") return void toast(`“${name}” is being saved in another tab of this browser`, mark("saving", 0.3), { label: "Open", onClick: open });
  if (e && e.pause === "offline") return void toast(`No connection — “${name}” carries on by itself when the line is back`, mark("retrying", 0.3), { label: "Open", onClick: open });
  const msg = (e && e.message) || String(e);
  toast(`Couldn't save: ${msg}`, mark("failed"), /not enough room/.test(msg) ? { label: "Make room", onClick: open } : null);
};

export const saveButton = (item, { variant = "hero", ep = null, onLeave = null, ui = null, onPress = null } = {}) => {
  if (!offline.available() || !item || !item.id) return null;
  const name = nameOf(item);
  const m = mark("none", 0, variant === "ep" ? "ep-dev" : variant === "rail" ? "rail-dev" : variant === "menu" ? "menu-dev-mark" : "btn-dev-mark");
  let word = null, label = null, num = null;
  const btn = el("button", {
    "data-ui": ui || (variant === "ep" ? "detail.episode.offline" : "detail.offline"),
    class: variant === "ep" ? "ep-action ep-offline focusable btn-offline"
      : variant === "rail" ? "src-act src-icon focusable btn-offline"
        : variant === "menu" ? "menu-item focusable btn-offline menu-dev"
          : "btn focusable btn-offline btn-dev",
  });
  if (variant === "ep") {
    num = el("b", {});
    m.append(num);
    btn.append(m);
  } else if (variant === "rail") {
    label = el("span", { class: "src-lbl" });
    btn.append(el("span", { class: "src-ic" }, m), label);
  } else if (variant === "menu") {
    word = el("span", { class: "menu-dev-word" });
    label = el("span", { class: "tag" });
    btn.append(m, word, label);
  } else {
    word = el("span", { class: "btn-dev-word" });
    label = el("span", { class: "btn-label" });
    btn.append(el("span", { class: "dev-ic" }, m), word, label);
  }

  let asking = false; // the size sheet is up, or the save has not said anything yet
  const look = () => {
    const j = offline.jobFor(item.id);
    if (j && j.state) return { st: j.state, pct: j.pct || 0, waiting: !!j.waiting, j };
    const c = copyHere(item.id);
    return c ? { st: "saved", pct: 1, copy: c } : { st: null, pct: 0 };
  };
  let was = null;
  const paint = () => {
    const L = look();
    const st = L.st;
    setMark(m, st, L.pct);
    btn.dataset.state = st || "none";
    btn.classList.toggle("busy", ACTIVE(st));
    btn.classList.toggle("saved", st === "saved");
    if (variant === "ep") btn.classList.toggle("on", st === "saved");
    const long = words(st, L.pct, L.waiting);
    const hint = st === "saved" ? `${SAVED} — it plays with no connection. Press for Remove`
      : ACTIVE(st) ? `${long}${L.j && L.j.note ? ` — ${L.j.note}` : ""}. Press for Stop`
        : st === "paused" ? "Paused — press to carry on"
          : st === "failed" ? `Didn't save${L.j && L.j.error ? `: ${L.j.error}` : ""} — press to try again`
            : `${SAVE} — it plays here with no connection`;
    if (btn.title !== hint) btn.title = hint;
    const say = ep ? (st ? `${ep.label}: ${long}` : `Save ${ep.label} to this device`) : st ? `${name}: ${long}` : SAVE;
    if (btn.getAttribute("aria-label") !== say) btn.setAttribute("aria-label", say);
    if (num) {
      const n = st === "saving" ? String(pctOf(L.pct)) : "";
      if (num.dataset.n !== n) {
        num.dataset.n = n;
        num.textContent = n;
        if (n) num.append(el("small", {}, "%"));
      }
    }
    if (word && word.textContent !== long) word.textContent = long;
    if (label) {
      const s = variant === "rail" ? (st === "saved" ? "Saved" : st === "saving" ? `${pctOf(L.pct)}%` : st ? short(st, L.pct, L.waiting) : "Save")
        // a menu row: beside the words, what a press does
        : variant === "menu" ? (st === "saved" ? "Remove" : ACTIVE(st) ? "Stop" : st === "paused" ? "Carry on" : st === "failed" ? "Try again" : "plays with no connection")
          : short(st, L.pct, L.waiting);
      if (label.textContent !== s) label.textContent = s;
    }
    // it landed while this page was looking: the mark says so once
    if (st === "saved" && was && ACTIVE(was)) pop(m);
    was = st;
  };

  const remove = async () => {
    await offline.removeSaved(item.id).catch(() => {});
    toast("Removed from this device", mark("none"));
    paint();
  };
  const run = async (again) => {
    asking = true;
    try {
      const choose = (options) => pickSize(options, { title: name });
      const saved = await (again ? offline.retryJob(item.id, choose) : offline.saveItem(item, () => {}, choose));
      if (saved && saved.controlled === false) toast("Saved — reload Aurora once before going offline so it can play here", mark("saved"));
    } catch (e) {
      // paused by the person (On this device → Pause): it is waiting, not gone
      const j = offline.jobFor(item.id);
      if (!(e && e.name === "AbortError" && j && j.state === "paused")) sayFailure(e, name);
    }
    asking = false;
    paint();
  };
  btn.onclick = () => {
    const L = look();
    if (onPress) onPress(L.st);
    if (L.st === "saved") {
      const size = L.copy && L.copy.sizeBytes ? ` · ${fmtBytes(L.copy.sizeBytes)}` : "";
      return void toast(`“${name}” is on this device${size} — it plays with no connection`, mark("saved"), { label: "Remove", onClick: remove });
    }
    if (ACTIVE(L.st)) {
      const left = L.j && L.j.eta > 0 && L.st === "saving" ? ` · about ${fmtDuration(Math.max(60, L.j.eta))} left` : "";
      return void toast(`${words(L.st, L.pct, L.waiting)} — “${name}”${left}`, mark(L.st, L.pct), {
        label: "Stop",
        onClick: () => {
          offline.cancelJob(item.id);
          setTimeout(() => { if (!offline.jobFor(item.id) && !said(/Save cancelled/)) toast("Save cancelled", mark("none")); }, 400);
        },
      });
    }
    if (asking) return;
    run(L.st === "paused" || L.st === "failed");
  };

  const off = [offline.onJobs(paint), offline.onIndex(paint)];
  const stop = () => off.forEach((fn) => fn());
  if (onLeave) onLeave(stop);
  paint();
  whenIndexed().then(paint);
  return btn;
};

// Several titles in a row at ONE size, asked once (on the first of them).
//   items      what offline.saveItem takes (an episode carries showTitle,
//              showId, season, episode), in the order they are saved
//   sheetTitle the name in the size sheet's sentence
//   onLine     ({ i, n, pct, waiting }) while it runs
//   patient    a pack of different titles ("Pack for a trip"): one that is
//              paused, cancelled or fails does not end the others — a paused
//              one is waited for (its Resume carries the pack on), the rest
//              are saved after it
// → how many were saved. What stopped it is thrown, with e.done = that number.
// The ones after the first wait their turn as rows on "On this device"; one
// line says the whole batch landed (the caller's), not one line each.
export const saveSeveral = async (items, { signal = null, sheetTitle = "", onLine = () => {}, patient = false } = {}) => {
  let quality = null; // asked once, then reused
  let done = 0;
  // what they come to together: by running time, and the files' own weight
  const secs = items.map((it) => it.duration || 0);
  const times = secs[0] > 0 && secs.every((x) => x > 0) ? secs.reduce((a, b) => a + b, 0) / secs[0] : items.length;
  const originalBytes = items.every((it) => it.sizeBytes > 0) ? items.reduce((a, it) => a + it.sizeBytes, 0) : 0;
  for (const it of items.slice(1)) offline.queueJob(it);
  for (const it of items) hush.add(it.id);
  try {
    for (const [i, it] of items.entries()) {
      // (taken off the list on "On this device" meanwhile: skipped)
      if (i > 0 && !offline.jobFor(it.id)) continue;
      const line = { i: i + 1, n: items.length, pct: 0, waiting: false };
      onLine(line);
      let saved = null;
      try {
        saved = await offline.saveItem(
          it,
          ({ phase, pct, waiting }) => {
            if (phase === "preparing" || phase === "saving") { line.pct = pct || 0; line.waiting = !!waiting && phase === "preparing"; onLine(line); }
          },
          async (options) => {
            if (quality && options.some((o) => o.quality === quality)) return quality;
            // a later one that can't be made at the chosen size: the nearest smaller one it offers
            if (quality) return (options.find((o) => !o.instant) || options[0]).quality;
            quality = await pickSize(options, { title: sheetTitle, count: items.length, times, originalBytes });
            return quality;
          },
          signal,
        );
      } catch (e) {
        if (!patient || (signal && signal.aborted) || /not enough room/.test((e && e.message) || "")) throw e;
        // paused (by the person, or the line went): wait for it — then the rest
        const end = await settled(it.id, signal);
        if (end === "saved") done++;
        else if (end === "stop") throw e;
        continue;
      }
      if (!saved) break; // the size sheet was closed
      done++;
    }
    return done;
  } catch (e) {
    if (e && typeof e === "object") e.done = done;
    throw e;
  } finally {
    // still waiting their turn after a stop, an error or a closed size sheet: not coming
    for (const it of items) { const j = offline.jobFor(it.id); if (j && j.state === "queued") offline.dismissJob(it.id); }
    setTimeout(() => { for (const it of items) hush.delete(it.id); }, 1500);
  }
};
// One save that stopped inside a patient pack: what became of it.
//   "saved"  its Resume (or the line coming back) finished it
//   "gone"   cancelled, or it failed and waits for its own Retry — the next one
//   "stop"   the whole pack was stopped
const settled = (id, signal) => new Promise((resolve) => {
  let off = null;
  const look = () => {
    const j = offline.jobFor(id);
    const end = signal && signal.aborted ? "stop" : !j ? (offline.savedNow(id) ? "saved" : "gone") : j.state === "failed" ? "gone" : null;
    if (!end) return;
    if (off) off();
    resolve(end);
  };
  off = offline.onJobs(look);
  if (signal) signal.addEventListener("abort", look, { once: true });
  look();
});
// How a batch ended, in one line. `of`: " of “Show”" or "".
export const sayBatch = (done, e, { of = "", noun = "episode", held = false } = {}) => {
  const n = (k) => `${k} ${noun}${k === 1 ? "" : "s"}`;
  if (!e) {
    if (done) toast(done === 1 ? `1 ${noun}${of} is on this device` : `${n(done)}${of} are on this device`, mark("saved"), { label: "Open", onClick: open });
    return;
  }
  const msg = (e && e.message) || String(e);
  if (e.name === "AbortError" && held) toast(`Paused${done ? ` — ${done} saved` : ""}. Carry on from On this device`, mark("paused", 0.3), { label: "Open", onClick: open });
  else if (e.name === "AbortError") toast(done ? `Stopped — ${done} saved` : "Save cancelled", mark("none"));
  else if (e.pause === "offline") toast(`No connection — ${done ? `${done} saved, ` : ""}the rest carries on when the line is back`, mark("retrying", 0.3), { label: "Open", onClick: open });
  else toast(`Saved ${done} — then: ${msg}`, mark("failed"), /not enough room/.test(msg) ? { label: "Make room", onClick: open } : null);
};

// "Save the next 3" / "Save the season (N)": the same save, run for several
// episodes in a row at one size, asked once. `nextEpisodes()` → the rows to
// save, in order (each with .local, the library item).
const NEXT = 3;
export const seasonButton = (nextEpisodes, showTitle, showId = null, { pill = false, onLeave = null, ui = null } = {}) => {
  if (!offline.available()) return null;
  const limit = pill ? Infinity : NEXT;
  const btn = el("button", {
    "data-ui": ui || (pill ? "detail.offline.seasonall" : "detail.offline.season"),
    class: pill ? "season-pill focusable btn-offline season-dev" : "btn focusable btn-offline btn-dev btn-dev-next",
  });
  const m = mark("none", 0, pill ? "pill-dev" : "btn-dev-mark");
  const word = el("span", { class: pill ? "season-dev-word" : "btn-dev-word" });
  const label = pill ? null : el("span", { class: "btn-label" });
  btn.append(pill ? m : el("span", { class: "dev-ic" }, m), word);
  if (label) btn.append(label);

  let busy = false;
  let aborter = null;
  let count = 0; // the season bar's own count (every episode of the season on disk)
  let line = null; // { i, n, pct, waiting } while it runs
  const asItem = (e) => ({ ...e.local, showTitle, showId: showId || e.local.showId || null, season: e.season, episode: e.episode, title: e.title || e.local.title });
  // the rows this press would save (not here yet), at most `limit`
  const todo = () => {
    const rows = [];
    for (const e of nextEpisodes()) {
      if (rows.length >= limit) break;
      if (!copyHere(e.local.id)) rows.push(e);
    }
    return rows;
  };
  const paint = () => {
    let text, tile, st = "none", pct = 0;
    if (busy && line) {
      st = line.waiting ? "preparing" : "saving";
      pct = line.pct;
      text = line.waiting ? `${line.i} of ${line.n} · waiting for the server` : `${line.i} of ${line.n} · ${pctOf(line.pct)}%`;
      tile = `${line.i} of ${line.n} · ${line.waiting ? "waiting" : `${pctOf(line.pct)}%`}`;
    } else if (pill) {
      text = `Save the season (${count})`;
    } else {
      const all = nextEpisodes().slice(0, NEXT).length;
      const n = todo().length;
      if (all && !n) { st = "saved"; text = all === 1 ? "The next episode is saved" : `The next ${all} are saved`; tile = "Next saved"; }
      else if (n <= 1) { text = "Save the next episode"; tile = "Save next"; }
      else { text = `Save the next ${n}`; tile = `Save next ${n}`; }
    }
    setMark(m, st, pct);
    btn.dataset.state = st;
    btn.classList.toggle("busy", busy);
    btn.classList.toggle("saved", st === "saved");
    if (word.textContent !== text) word.textContent = text;
    if (label && label.textContent !== tile) label.textContent = tile;
    const say = pill ? (busy ? `Saving this season to this device: ${text}` : "Save this season to this device") : busy ? `Saving the next episodes to this device: ${text}` : `${text} to this device`;
    if (btn.getAttribute("aria-label") !== say) btn.setAttribute("aria-label", say);
    const hint = busy ? "Press for Stop" : pill ? "Save this season's episodes on this device — to watch with no connection" : "Save the next episodes on this device — to watch with no connection. The size is asked once";
    if (btn.title !== hint) btn.title = hint;
  };
  btn._relabel = (n) => { count = n; paint(); };

  btn.onclick = async () => {
    if (busy) {
      return void toast(`Saving ${line ? `${line.n} episodes` : "episodes"} of “${showTitle}”${line ? ` — ${line.i} of ${line.n}` : ""}`, mark("saving", line ? line.pct : 0.1), {
        label: "Stop",
        onClick: () => { if (aborter) aborter.abort(); },
      });
    }
    await whenIndexed();
    const rows = todo();
    if (!rows.length) return void toast(pill ? "This season's episodes are already on this device" : "The next episodes are already on this device", mark("saved"), { label: "Open", onClick: open });
    busy = true;
    aborter = new AbortController();
    line = { i: 1, n: rows.length, pct: 0, waiting: false };
    paint();
    const held = () => rows.some((r) => { const j = offline.jobFor(r.local.id); return j && j.state === "paused"; });
    const of = ` of “${showTitle}”`;
    try {
      const done = await saveSeveral(rows.map(asItem), {
        signal: aborter.signal,
        sheetTitle: pill ? `${rows.length} episode${rows.length > 1 ? "s" : ""} of “${showTitle}”, this season` : `The next ${rows.length} episode${rows.length > 1 ? "s" : ""} of “${showTitle}”`,
        onLine: (l) => { line = l; paint(); },
      });
      sayBatch(done, null, { of });
    } catch (e) {
      sayBatch((e && e.done) || 0, e, { of, held: held() });
    }
    aborter = null;
    busy = false;
    line = null;
    paint();
  };

  const off = [offline.onIndex(paint)];
  if (onLeave) onLeave(() => off.forEach((fn) => fn()));
  paint();
  whenIndexed().then(paint);
  return btn;
};
