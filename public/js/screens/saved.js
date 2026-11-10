// On this device: everything that plays right here, with or without a server.
// (The look: offline-look, 2026-11-10 — docs/offline-look.md.)
//
//   Saving now         saves to this device under way, and titles waiting for
//                      the server's copy (js/devicejobs.js) — always on top
//   Saved for offline  what is ready, as a small home of its own:
//                        · the room: what Aurora keeps here against what is
//                          free ("≈" — the browser's number is a guess), and
//                          "Remove watched"
//                        · the titles: a show's episodes together and in
//                          order, the one to watch next first; what you are
//                          in the middle of before what you finished
//                        · under them: the "Keep the next episode ready"
//                          switch and what it did last
//                        · nothing yet: two lines that teach, and what would
//                          be worth saving — one press each
//   "Pack for a trip" sits beside the screen's name (js/offlinePack.js).
//   Your files         videos and subtitles from this computer or phone
//                      (js/localview.js) — nothing is uploaded
//
// Remove never asks twice: the row goes at once and a line offers Undo; the
// copy itself is dropped when that line is gone (or the screen is left).
// Only THIS device's copies; a kids profile sees only its own.
import { el, icons, fmtBytes, toast } from "../ui.js";
import { navigate, untilLeave } from "../router.js";
import { state, progressFor } from "../state.js";
import { api } from "../api.js";
import * as offline from "../offline.js";
import { yourFilesSection } from "../localview.js";
import { deviceJobsSection } from "../devicejobs.js";
import { mark, deviceIcon, trashIcon, restIcon, bagIcon, savedByItself, lastByItself } from "../offlineUi.js";
import { saveButton, seasonButton } from "../offlineButtons.js";

// (an episode whose only name is its file's — "Show S01E02" — is not named twice)
const epName = (it) => (it.title && it.title !== it.showTitle && !/^.+ S\d+E\d+$/i.test(it.title) ? it.title : "");
const label = (it) => (it.showTitle ? `${it.showTitle} · S${it.season} E${it.episode}${epName(it) ? ` · ${epName(it)}` : ""}` : it.title);
const short = (it) => (it.showTitle ? `${it.showTitle} S${it.season} E${it.episode}` : it.title);
const isEp = (it) => !!(it.showTitle && it.season != null && it.episode != null);
// "45 min", "1 h 52 min", "40 sec"
const mins = (secs) => {
  if (!(secs > 0)) return "";
  if (secs < 60) return `${Math.round(secs)} sec`;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return h > 0 ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
};
const vh = (text) => el("span", { class: "dev-vh" }, text);
const UNDO_MS = 6000; // as long as the line with Undo is up (ui.js toast)
// the note about the browser clearing copies: beside the room until the person
// says "Got it" (once per device), under the titles after that
const NOTE_KEY = "aurora-offline-note-seen";
const noteSeen = () => { try { return localStorage.getItem(NOTE_KEY) === "1"; } catch { return false; } };

export const renderSaved = async (root) => {
  const screen = el("div", { class: "screen saved-screen dev-home" });
  root.append(screen);
  // The app came up with no server to talk to (main.js boot): say so, with
  // the way to try again — what is below still works.
  const down = state.noServer
    ? el("div", { class: "page-pad" },
      el("div", { class: "local-noserver", role: "status" },
        el("span", { class: "rest-ic", html: restIcon, "aria-hidden": "true" }),
        el("span", { class: "local-noserver-text" }, "Can't reach the Aurora server — your files and the saved titles still play."),
        el("button", { class: "btn small focusable", onclick: () => location.reload() }, "Try again")))
    : null;
  // ONE place for what is on this device, online or not (elia, 2026-10-18:
  // "a user can't see, while he's connected, his offline library … and also
  // download status and progress").
  const savedCount = el("span", { class: "count" });
  const room = el("div", { class: "dev-room hidden" });
  const body = el("div", { class: "saved-body" });
  const savedSection = el("section", { class: "dl-section saved-section page-pad", "aria-labelledby": "saved-title" },
    el("h2", { class: "row-title saved-head", id: "saved-title" }, "Saved for offline", savedCount),
    room,
    body);
  const files = yourFilesSection();
  // "Pack for a trip": needs the server (it is what gets packed)
  const pack = offline.available() && state.profile && !state.noServer && navigator.onLine !== false
    ? el("button", { "data-ui": "saved.pack", class: "btn small focusable dev-tool dev-pack", onclick: () => import("../offlinePack.js").then((m) => m.openTrip()) },
      el("span", { class: "dev-tool-ic", html: bagIcon }), el("span", {}, "Pack for a trip"))
    : null;
  screen.append(...[
    el("div", { class: "browse-head saved-top" }, ...[
      el("h1", {}, "On this device"),
      el("span", { class: "count" }, "Plays right here — even with no connection"),
      pack,
    ].filter(Boolean)),
    down,
    // what is on its way first, then what is ready; the person's own files
    // after (their empty picker is a strip, not a wall above the titles)
    offline.available() ? el("div", { class: "page-pad saving-host" }, deviceJobsSection({ title: "Saving now" })) : null,
    savedSection,
    files,
  ].filter(Boolean));
  // files of the person's own and nothing saved: those are what this screen
  // is for right now — they go above the (empty) saved list
  const place = () => {
    const first = files.isConnected && !files.classList.contains("lf-empty") && !screen.classList.contains("has-saved");
    if (first && files.nextElementSibling === savedSection) return;
    if (first) savedSection.before(files);
    else if (savedSection.nextElementSibling !== files) savedSection.after(files);
  };
  try {
    const mo = new MutationObserver(place);
    mo.observe(files, { attributes: true, attributeFilter: ["class"] });
    untilLeave(() => mo.disconnect());
  } catch {}

  if (!offline.available()) {
    body.append(el("div", { class: "saved-empty dev-empty dev-empty-locked" },
      el("div", { class: "dev-empty-art" }, mark("none", 0, "dev-empty-mark")),
      el("h3", { class: "dev-empty-title" }, "Saving needs the secure address"),
      el("p", { class: "dev-empty-text" }, "Open Aurora at its https address (or on the computer it runs on) and a Save to this device button appears on every film and episode. Your own files below play either way.")));
    return;
  }

  // ---------- Remove, with Undo ----------
  const pending = new Map(); // id -> the batch it leaves with
  const settle = async (batch) => {
    clearTimeout(batch.timer);
    const ids = batch.ids.filter((id) => pending.get(id) === batch);
    for (const id of ids) {
      await offline.removeSaved(id).catch(() => {});
      pending.delete(id);
    }
    if (ids.length && screen.isConnected) paint();
  };
  const settleAll = () => { for (const b of new Set(pending.values())) settle(b); };
  untilLeave(settleAll);
  window.addEventListener("pagehide", settleAll);
  untilLeave(() => window.removeEventListener("pagehide", settleAll));
  const removeSoon = (list, say) => {
    if (!list.length) return;
    const batch = { ids: list.map((it) => it.id), timer: 0 };
    batch.timer = setTimeout(() => settle(batch), UNDO_MS);
    for (const id of batch.ids) pending.set(id, batch);
    paint();
    toast(say, mark("none"), {
      label: "Undo",
      onClick: () => {
        clearTimeout(batch.timer);
        for (const id of batch.ids) if (pending.get(id) === batch) pending.delete(id);
        paint();
      },
    });
  };

  // ---------- the room ----------
  const paintRoom = (items, sum, watched, kept) => {
    room.textContent = "";
    room.classList.toggle("hidden", !items.length);
    if (!items.length) return;
    const bytes = items.reduce((n, it) => n + (it.sizeBytes || 0), 0);
    const free = sum && sum.quota ? Math.max(0, sum.free) : null;
    const part = free != null && bytes + free > 0 ? Math.max(2, Math.min(100, Math.round((bytes / (bytes + free)) * 100))) : null;
    const nums = el("p", { class: "dev-room-nums" },
      el("b", {}, bytes ? fmtBytes(bytes) : `${items.length} ${items.length === 1 ? "title" : "titles"}`), " saved here",
      free != null ? el("span", { class: "dev-room-free" }, ` · room for ≈ ${fmtBytes(free)} more`) : null);
    const bar = part != null
      ? el("div", { class: "dev-room-bar", role: "img", "aria-label": `Aurora keeps ${fmtBytes(bytes)} on this device; about ${fmtBytes(free)} is free` }, el("i", { style: `width:${part}%` }))
      : null;
    // watched to the end: one press frees them (Undo on the line that says so)
    const w = watched.filter((it) => !pending.has(it.id));
    const wBytes = w.reduce((n, it) => n + (it.sizeBytes || 0), 0);
    const clear = w.length
      ? el("button", {
        "data-ui": "saved.clear.watched", class: "btn small focusable dev-tool",
        "aria-label": `Remove the ${w.length === 1 ? "one title" : `${w.length} titles`} you watched to the end from this device${wBytes ? ` — frees ${fmtBytes(wBytes)}` : ""}`,
        onclick: () => removeSoon(w, `Removed ${w.length === 1 ? `“${short(w[0])}”` : `${w.length} watched titles`} from this device${wBytes ? ` — ${fmtBytes(wBytes)} freed` : ""}`),
      }, el("span", { class: "dev-tool-ic", html: trashIcon }), el("span", {}, `Remove watched · ${w.length}${wBytes ? ` · ${fmtBytes(wBytes)}` : ""}`))
      : null;
    const note = !noteSeen() ? keepNote(sum, kept, true) : null;
    room.append(...[
      el("div", { class: "dev-room-top" }, el("div", { class: "dev-room-meter" }, nums, bar), clear ? el("div", { class: "dev-room-tools" }, clear) : null),
      note,
    ].filter(Boolean));
  };
  // The browser may clear a site's storage when the device runs short of
  // room — the films with it. Said once, plainly, with what keeps them.
  const keepNote = (sum, kept, fresh) => {
    const safari = (sum && sum.safariMayClear) || (/iPhone|iPad|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1 && kept === "may-clear");
    if (!safari && kept !== "may-clear") return null;
    const p = el("p", { class: "saved-keep" + (fresh ? " fresh" : "") },
      el("span", {}, safari
        ? "Safari may clear these after a week without a visit. Add Aurora to the Home Screen (Share → Add to Home Screen) and they stay until you remove them."
        : "This browser may clear these if the device runs very short of space. Install Aurora (the browser's Install, or “Add to Home screen”) and they stay until you remove them."));
    if (fresh) p.append(el("button", { class: "btn small focusable dev-note-ok", onclick: () => { try { localStorage.setItem(NOTE_KEY, "1"); } catch {} paint(); } }, "Got it"));
    return p;
  };
  // under the titles: "Keep the next episode ready" — the switch, and what it did last
  const paintFoot = (items, sum, kept) => {
    const parts = [];
    if (items.some(isEp) || offline.smartNext.get()) {
      const last = lastByItself();
      const sw = el("button", { "data-ui": "saved.smartnext", class: "btn small focusable pref-item-value pref-switch", role: "switch", "aria-labelledby": "dev-next-name", "aria-describedby": "dev-next-text" }, el("span", {}));
      const set = () => {
        const on = offline.smartNext.get();
        sw.classList.toggle("on", on);
        sw.setAttribute("aria-checked", on ? "true" : "false");
        sw.firstChild.textContent = on ? "On" : "Off";
      };
      sw.onclick = () => {
        const on = !offline.smartNext.get();
        offline.smartNext.set(on);
        set();
        toast(on ? "On — finish a saved episode and the next one is saved here by itself" : "Off — episodes are saved only when you ask", mark(on ? "saved" : "none"), null, { quiet: true });
      };
      set();
      parts.push(el("div", { class: "dev-next" },
        el("div", { class: "dev-next-words" },
          el("b", { id: "dev-next-name" }, "Keep the next episode ready"),
          el("span", { id: "dev-next-text" }, "Finish a saved episode and the next one is saved here by itself."),
          last ? el("span", { class: "dev-next-last" }, mark("saved", 1, "dev-next-mark"), `Saved by itself: ${last.name}`) : null),
        sw));
    }
    const note = noteSeen() ? keepNote(sum, kept, false) : null;
    if (note) parts.push(note);
    return parts.length ? el("div", { class: "dev-foot" }, parts) : null;
  };

  // ---------- the titles ----------
  let gen = 0;
  const trees = new Map(); // showId -> the show with its episodes (for "Save the next N")
  const leaves = []; // the live buttons of the last paint (their listeners)
  const drop = () => { for (const fn of leaves.splice(0)) { try { fn(); } catch {} } };
  untilLeave(drop);
  const onLeave = (fn) => leaves.push(fn);

  const paint = async () => {
    const mine = ++gen;
    // a kids profile sees only what it saved itself (offline.js listSavedFor)
    const who = state.profile ? { id: state.profile.id, kids: !!state.profile.kids } : offline.lastWho();
    const [all, sum, kept, seen, queued] = await Promise.all([
      offline.listSavedFor(who),
      offline.storageSummary().catch(() => null),
      offline.persistState().catch(() => "unknown"),
      offline.watchedCopies(who).catch(() => ({ copies: [] })),
      offline.queuedProgress().catch(() => []),
    ]);
    if (mine !== gen) return; // a newer paint is on its way
    const items = all.filter((it) => !pending.has(it.id));
    const done = new Set((seen.copies || []).map((c) => c.id));
    // where the person stopped: what was watched with no line counts too
    const waiting = new Map(queued.map((r) => [r.itemId, r]));
    const at = (it) => {
      if (done.has(it.id)) return 0;
      const q = waiting.get(it.id);
      const p = progressFor(it.id);
      const pos = q && (!p || (q.at || 0) >= (p.updatedAt || 0)) ? q.position : p && !p.finished ? p.position : 0;
      return pos > 10 ? pos : 0;
    };
    drop();
    body.textContent = "";
    savedCount.textContent = items.length ? String(items.length) : "";
    // (titles saved: the empty "Your files" drop zone is a strip, not a wall above them)
    screen.classList.toggle("has-saved", items.length > 0);
    place();
    paintRoom(items, sum, (seen.copies || []).filter((c) => items.some((it) => it.id === c.id)), kept);
    if (!items.length) return paintEmpty(sum, mine);

    const playBtn = (it, { round = false, ui = "saved.play", word = null } = {}) => { // (ui: its data-ui)
      const pos = at(it);
      const text = word || (pos ? "Resume" : done.has(it.id) ? "Play again" : "Play");
      return el("button", {
        "data-ui": ui,
        class: round ? "dev-round dev-round-play focusable" : "btn btn-primary focusable",
        "aria-label": round || word ? `${pos ? "Resume" : "Play"} ${short(it)}` : null,
        html: round ? icons.play : icons.play + `<span>${text}</span>`,
        onclick: () => navigate(`#/play/${it.id}?offline=1`),
      });
    };
    const removeBtn = (it, { round = false } = {}) => el("button", {
      "data-ui": "saved.remove",
      class: round ? "dev-round dev-round-remove focusable" : "btn focusable dev-remove",
      "aria-label": `Remove ${short(it)} from this device`,
      title: "Remove from this device",
      html: round ? trashIcon : `<span class="dev-tool-ic">${trashIcon}</span><span>Remove</span>`,
      onclick: () => removeSoon([it], `Removed “${short(it)}” from this device`),
    });
    // what one copy is: how much is left to watch, its size, its sound
    const facts = (it, { full = false } = {}) => {
      const pos = at(it);
      return [
        done.has(it.id) ? null : pos && it.duration > pos ? `${mins(it.duration - pos)} left` : it.duration ? mins(it.duration) : null,
        it.sizeBytes ? fmtBytes(it.sizeBytes) : null,
        full && it.quality ? (it.quality === "original" ? "Original quality" : `${it.quality}p`) : null,
        full && it.audioLabel ? it.audioLabel : null,
        full && it.subtitles && it.subtitles.length ? `${it.subtitles.length} subtitle${it.subtitles.length > 1 ? "s" : ""}` : null,
      ].filter(Boolean).join(" · ");
    };
    const tags = (it, nextUp) => [
      nextUp ? el("span", { class: "dev-tag next" }, "Next up") : null,
      done.has(it.id) ? el("span", { class: "dev-tag watched", html: `${icons.check}<span>Watched</span>` }) : null,
      savedByItself(it.id) ? el("span", { class: "dev-tag", title: "Saved by itself — “Keep the next episode ready”" }, "Kept ready") : null,
    ];
    const meter = (it) => {
      const pos = at(it);
      return pos && it.duration > 0 ? el("div", { class: "dev-seen", "aria-hidden": "true" }, el("i", { style: `width:${Math.max(3, Math.min(100, Math.round((pos / it.duration) * 100)))}%` })) : null;
    };
    // its picture — and its name in the frame when the picture cannot be had
    // (no connection, and this one was never seen here)
    const poster = (src, name, lazy = false) => {
      if (!src) return el("div", { class: "card-fallback" }, name);
      const img = el("img", { src, alt: "", loading: lazy ? "lazy" : null });
      img.onerror = () => img.replaceWith(el("div", { class: "card-fallback" }, name));
      return img;
    };
    // a film, or the one episode of a show that is here
    const fullRow = (it) =>
      el("div", { class: "dl-row tone-ok dev-row" + (done.has(it.id) ? " watched" : ""), "data-id": it.id },
        el("div", { class: "dl-poster" }, poster(it.cover, it.title)),
        el("div", { class: "dl-info" },
          el("div", { class: "dl-title", dir: "auto" }, el("span", { class: "dev-name" }, label(it)), tags(it, false)),
          el("div", { class: "dl-status" }, facts(it, { full: true })),
          meter(it)),
        el("div", { class: "dl-actions" }, playBtn(it), removeBtn(it)));

    // shows with two or more episodes here: together, in order
    const groups = new Map();
    for (const it of items) {
      const key = isEp(it) ? it.showId || `t:${it.showTitle}` : `one:${it.id}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, show: isEp(it), eps: [], at: 0 }));
      g.eps.push(it);
      g.at = Math.max(g.at, it.savedAt || 0);
    }
    const tiers = [...groups.values()].map((g) => {
      g.eps.sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
      const seenN = g.eps.filter((e) => done.has(e.id)).length;
      const going = g.eps.some((e) => at(e) > 0) || (seenN > 0 && seenN < g.eps.length);
      // what to watch next: the one stopped in, else the first not watched after the last watched
      let next = g.eps.find((e) => at(e) > 0) || null;
      if (!next) {
        let lastSeen = -1;
        g.eps.forEach((e, i) => { if (done.has(e.id)) lastSeen = i; });
        next = g.eps.slice(lastSeen + 1).find((e) => !done.has(e.id)) || g.eps.find((e) => !done.has(e.id)) || null;
      }
      return { ...g, seenN, next, tier: going ? 0 : seenN === g.eps.length ? 2 : 1 };
    }).sort((a, b) => a.tier - b.tier || b.at - a.at);

    const list = el("div", { class: "dl-list dev-list" });
    for (const g of tiers) {
      if (!g.show || g.eps.length < 2) { list.append(fullRow(g.eps[0])); continue; }
      const first = g.eps[0];
      const bytes = g.eps.reduce((n, e) => n + (e.sizeBytes || 0), 0);
      const target = g.next || first;
      const head = el("div", { class: "dev-group-head" },
        el("div", { class: "dl-poster" }, poster(first.cover, first.showTitle)),
        el("div", { class: "dl-info" },
          el("h3", { class: "dl-title dev-group-title", dir: "auto" }, first.showTitle),
          el("div", { class: "dl-status" }, [
            `${g.eps.length} episodes`,
            bytes ? fmtBytes(bytes) : null,
            g.seenN ? (g.seenN === g.eps.length ? "all watched" : `${g.seenN} watched`) : null,
          ].filter(Boolean).join(" · "))),
        el("div", { class: "dl-actions" },
          playBtn(target, { ui: "saved.play.next", word: `${at(target) ? "Resume" : g.next ? "Play" : "Play again"} S${target.season} E${target.episode}` }), // (its data-ui)
          el("button", {
            "data-ui": "saved.remove.show", class: "dev-round dev-round-remove focusable",
            "aria-label": `Remove all ${g.eps.length} episodes of ${first.showTitle} from this device`, title: "Remove them all from this device", html: trashIcon,
            onclick: () => removeSoon(g.eps, `Removed ${g.eps.length} episodes of “${first.showTitle}” from this device${bytes ? ` — ${fmtBytes(bytes)} freed` : ""}`),
          })));
      const rows = g.eps.map((it) => {
        const isNext = g.next === it;
        return el("div", { class: "dl-row tone-ok dev-ep" + (done.has(it.id) ? " watched" : "") + (isNext ? " next" : ""), "data-id": it.id },
          el("div", { class: "dl-info" },
            el("div", { class: "dl-title", dir: "auto" },
              el("span", { class: "dev-name" }, vh(`${it.showTitle} · `), `S${it.season} E${it.episode}`, epName(it) ? ` · ${epName(it)}` : ""), tags(it, isNext)),
            el("div", { class: "dl-status" }, facts(it)),
            meter(it)),
          el("div", { class: "dl-actions" }, playBtn(it, { round: true }), removeBtn(it, { round: true })));
      });
      const foot = el("div", { class: "dev-group-foot hidden" });
      const group = el("section", { class: "dev-group", "aria-label": `${first.showTitle}, ${g.eps.length} episodes on this device`, "data-show": first.showId || "" }, head, el("div", { class: "dev-eps" }, rows), foot);
      group._more = { showId: first.showId, showTitle: first.showTitle, last: g.eps[g.eps.length - 1], foot };
      list.append(group);
    }
    body.append(...[list, paintFoot(items, sum, kept)].filter(Boolean));
    more(mine);
  };

  // "Save the next N" under a show: the episodes after the last one here.
  // (A show's episodes come with the show itself — asked for only when a show
  // is on this screen and the server is in reach; once per visit.)
  const treeOf = (id) => {
    if (!trees.has(id)) trees.set(id, api.item(id).then((t) => (t && t.seasons ? t : null)).catch(() => null));
    return trees.get(id);
  };
  const more = async (mine) => {
    const groupsNow = [...body.querySelectorAll(".dev-group")].filter((g) => g._more && g._more.showId);
    if (!groupsNow.length || state.noServer || navigator.onLine === false || !state.profile) return;
    const grown = await Promise.all(groupsNow.map((g) => treeOf(g._more.showId)));
    if (mine !== gen) return;
    for (const [i, g] of groupsNow.entries()) {
      const { showId, showTitle, last, foot } = g._more;
      const show = grown[i];
      if (!show) continue;
      const flat = [];
      for (const s of show.seasons || []) for (const e of s.episodes || []) flat.push({ local: e, season: e.season ?? s.number, episode: e.episode, title: e.title });
      flat.sort((a, b) => a.season - b.season || a.episode - b.episode);
      const after = flat.filter((e) => e.season > last.season || (e.season === last.season && e.episode > last.episode));
      if (!after.length) continue;
      const btn = seasonButton(() => after.filter((e) => { const p = progressFor(e.local.id); return !(p && p.finished); }), showTitle, showId, { onLeave, ui: "saved.next.save" }); // (its data-ui)
      if (!btn) continue;
      btn.classList.add("small");
      foot.append(btn);
      foot.classList.remove("hidden");
    }
  };

  // ---------- nothing here yet ----------
  const paintEmpty = (sum, mine) => {
    // something is on its way: the rows above say it all — one quiet line here
    if (offline.listJobs().length) {
      body.append(el("div", { class: "saved-empty dev-empty dev-empty-quiet" },
        el("p", { class: "dev-empty-text" }, el("b", {}, "Nothing saved for offline yet"), " — what is on its way lands here.")));
      return;
    }
    const offers = el("div", { class: "dev-offers hidden" });
    const free = sum && sum.quota ? Math.max(0, sum.free) : null;
    body.append(el("div", { class: "saved-empty dev-empty" }, ...[
      el("div", { class: "dev-empty-art", "aria-hidden": "true" }, mark("none", 0, "dev-empty-mark")),
      el("h3", { class: "dev-empty-title" }, "Nothing saved for offline yet"),
      el("p", { class: "dev-empty-text" },
        "Press ", el("span", { class: "dev-empty-key" }, el("span", { class: "dev-tool-ic", html: deviceIcon }), "Save to this device"), " on a film or an episode and it lands here."),
      el("p", { class: "dev-empty-text" }, "Then it plays anywhere — a flight, a train, the middle of nowhere."),
      free != null ? el("p", { class: "dev-empty-room" }, `Room on this device: ≈ ${fmtBytes(free)}`) : null,
      offers,
    ].filter(Boolean)));
    if (state.noServer || navigator.onLine === false || !state.profile) return;
    // what would be worth having: one press each
    import("../offlinePack.js").then(async (pack) => {
      const rows = await pack.suggestions({ perShow: 2, limit: 12 });
      if (mine !== gen || !offers.isConnected) return;
      const some = rows.slice(0, window.innerWidth < 700 ? 4 : 6);
      if (!some.length) return;
      offers.append(
        el("h4", { class: "dev-offers-title" }, "Worth having with you"),
        el("div", { class: "dev-offers-list" }, some.map((r) =>
          el("div", { class: "dev-offer" },
            el("div", { class: "dl-poster" }, poster(r.cover, r.name, true)),
            el("div", { class: "dev-offer-words" },
              el("div", { class: "dev-offer-name", dir: "auto" }, r.name, r.sub ? el("small", {}, r.sub) : null),
              el("div", { class: "dev-offer-why" }, [r.why, mins(r.secs), r.bytes ? fmtBytes(r.bytes) : null].filter(Boolean).join(" · "))),
            saveButton(r.item, { variant: "ep", ep: { label: `${r.name}${r.sub ? ` ${r.sub}` : ""}` }, onLeave, ui: "saved.offer.save" }))))); // (its data-ui)
      offers.classList.remove("hidden");
    }).catch(() => {});
  };

  await paint();
  // a save that finishes (its job goes) lands in the list at once
  let running = offline.listJobs().length;
  untilLeave(offline.onJobs((jobs) => {
    // (and the empty screen steps aside when the first save starts, comes back when none is left)
    if (jobs.length < running || (!jobs.length !== !running && !screen.classList.contains("has-saved"))) paint();
    running = jobs.length;
  }));
  // "Keep the next episode ready" switched somewhere else, or it just saved one
  untilLeave(offline.smartNext.on((e) => { if (e && (e.type === "changed" || e.type === "saved")) paint(); }));
};
