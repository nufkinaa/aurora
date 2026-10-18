// "Your files" on the "On this device" screen (screens/saved.js): the files
// from this computer or phone as a small library — one card per title in the
// same grid as Movies and Shows, episodes grouped by show and season, the
// subtitles each one found as language chips, a resume bar, and whether the
// file plays here, all before Play. One drop (anywhere on the page) or one
// pick of any mix of videos, subtitles and folders adds them; a subtitle no
// video claimed waits below with an "Attach to…" menu. js/localplay.js keeps
// the list; nothing here ever leaves the device.
import { el, icons, toast, fmtBytes, fmtClock } from "./ui.js";
import { navigate, untilLeave } from "./router.js";
import * as lp from "./localplay.js";
import { LANG_NAMES } from "./localnames.js";
import { pushScope, popScope } from "./focus.js";

const VIDEO_ACCEPT = "video/*,.mkv,.mk3d,.webm,.mp4,.m4v,.mov,.avi,.ts,.m2ts,.ogv,.wmv";
const SUB_ACCEPT = ".srt,.vtt,.ass,.ssa";
const PICKER_TYPES = [{
  description: "Videos and subtitles",
  accept: {
    "video/*": [".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".ts", ".m2ts", ".ogv", ".wmv"],
    "text/plain": [".srt", ".vtt", ".ass", ".ssa"],
  },
}];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ICON_DROP = '<svg viewBox="0 0 48 48" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 30v6a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4v-6"/><path d="M24 30V8"/><path d="m15 17 9-9 9 9"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2.1"/><circle cx="12" cy="12" r="2.1"/><circle cx="19" cy="12" r="2.1"/></svg>';
const ICON_FILM = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>';

// ---------- the card ----------
const langChip = (s) =>
  `${s.lang ? s.lang.toUpperCase() : "SUB"}${s.forced ? " forced" : s.sdh ? " SDH" : ""}`;
const STATUS = {
  checking: { tag: "CHECKING", tone: "busy", words: "checking the file" },
  refused: { tag: "WON'T PLAY", tone: "bad", words: "won't play in this browser" },
  novideo: { tag: "NO PICTURE", tone: "bad", words: "the picture won't play in this browser" },
  noaudio: { tag: "NO SOUND", tone: "warn", words: "no sound in this browser" },
};
const AVAIL = {
  locked: { tag: "RECONNECT", tone: "wait", words: "press to reconnect the file" },
  missing: { tag: "PICK AGAIN", tone: "wait", words: "pick the file again to keep watching" },
};
const titleWords = (e) =>
  e.parsed.kind === "episode" ? `${e.code}${e.parsed.epTitle ? ` · ${e.parsed.epTitle}` : ""}` : e.parsed.title;
const fullName = (e) => (e.parsed.kind === "episode" ? `${e.parsed.show} ${titleWords(e)}` : e.parsed.title);
const metaWords = (e) =>
  [e.parsed.kind !== "episode" && e.parsed.year, e.duration ? fmtClock(e.duration) : null, fmtBytes(e.size)].filter(Boolean).join(" · ");
const pctOf = (e) => (e.position && e.position.duration > 0 && !e.position.finished ? Math.min(100, (e.position.position / e.position.duration) * 100) : null);
// (a card is drawn again only when something it shows has changed)
const signature = (e) =>
  JSON.stringify([e.status, e.reason, e.avail, e.thumbUrl, e.duration, e.subs.map((s) => s.key), pctOf(e) && Math.round(pctOf(e)), e.parsed]);

const cardFor = (e, actions) => {
  const ep = e.parsed.kind === "episode";
  const state = e.avail !== "ready" ? AVAIL[e.avail] : STATUS[e.status] || null;
  const pct = pctOf(e);
  const label = titleWords(e);
  const subsWords = e.subs.length ? e.subs.map((s) => s.label).join(", ") + " subtitles" : "no subtitles";
  const play = el("button", {
    class: `card poster has-label focusable lf-play${e.thumbUrl ? "" : " lf-noart"}`,
    "aria-label": [
      ep ? `${e.parsed.show} ${label}` : label,
      state && state.words,
      metaWords(e),
      subsWords,
      pct !== null && `resume at ${fmtClock(e.position.position)}`,
    ].filter(Boolean).join(", "),
    title: e.reason || (e.avail === "ready" ? "Play" : state ? state.words[0].toUpperCase() + state.words.slice(1) : ""),
    onclick: () => actions.play(e),
  },
    e.thumbUrl
      ? el("img", { class: "card-poster lf-img", src: e.thumbUrl, alt: "", decoding: "async", draggable: "false" })
      : el("div", { class: "card-fallback lf-ph", "aria-hidden": "true" }, el("span", { class: "lf-ph-icon", html: ICON_FILM }), el("span", { class: "lf-ph-title", dir: "auto" }, ep ? e.parsed.show : e.parsed.title)),
    el("div", { class: "card-shade" }),
    state && el("span", { class: `card-tag lf-tag ${state.tone}`, "aria-hidden": "true", "data-t": state.tag }, state.tone === "busy" ? el("i", { class: "mini-spinner" }) : null),
    el("span", { class: "lf-playglyph", "aria-hidden": "true", html: icons.play }),
    pct !== null && el("div", { class: "card-progress" }, el("div", { style: { width: `${pct}%` } })),
    el("div", { class: "card-label", "aria-hidden": "true" },
      ep && el("span", { class: "card-sub", dir: "auto" }, e.parsed.show),
      el("bdi", { class: "lf-name", dir: "auto" }, label)),
  );
  const more = el("button", {
    class: "lf-more focusable",
    "aria-label": `More for ${ep ? `${e.parsed.show} ${label}` : label}`,
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    html: ICON_MORE,
    onclick: (ev) => { ev.stopPropagation(); actions.menu(e, more); },
  });
  const chips = e.subs.length
    ? [...e.subs.slice(0, 3).map((s) => el("span", { class: `lf-lang${s.forced || s.sdh ? " flag" : ""}`, title: `${s.label} · ${s.name}` }, langChip(s))),
      e.subs.length > 3 ? el("span", { class: "lf-lang more" }, `+${e.subs.length - 3}`) : null]
    : [el("span", { class: "lf-nosubs" }, "No subtitles")];
  return el("div", { class: `lf-card tone-${state ? state.tone : "ok"}`, "data-key": e.key, "data-id": e.id, "data-state": e.avail !== "ready" ? e.avail : e.status || "new", "data-kind": e.parsed.kind },
    play,
    more,
    el("div", { class: "lf-info", "aria-hidden": "true" },
      el("div", { class: "lf-meta" }, metaWords(e)),
      el("div", { class: "lf-subs" }, chips)));
};

// ---------- a small menu (the card's ⋯) ----------
let openMenu = null;
const closeMenu = (refocus = true) => {
  if (!openMenu) return;
  const { node, anchor, off } = openMenu;
  openMenu = null;
  off();
  popScope(node);
  node.remove();
  anchor.setAttribute("aria-expanded", "false");
  if (refocus && anchor.isConnected) anchor.focus({ preventScroll: true });
};
const showMenu = (anchor, { head = null, items }) => {
  closeMenu(false);
  const buttons = items.filter(Boolean).map((it) =>
    el("button", { class: `menu-item focusable${it.danger ? " lf-danger" : ""}`, role: "menuitem", onclick: () => { closeMenu(); it.run(); } }, el("bdi", { dir: "auto" }, it.text)));
  const node = el("div", { class: "menu lf-menu", role: "menu", "aria-label": anchor.getAttribute("aria-label") || "" },
    head && el("p", { class: "lf-menu-head", dir: "auto" }, head), buttons);
  document.body.append(node);
  const r = anchor.getBoundingClientRect();
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  const below = r.bottom + 6 + h <= window.innerHeight - 8;
  Object.assign(node.style, { position: "fixed", left: `${left}px`, top: `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - h)}px` });
  anchor.setAttribute("aria-expanded", "true");
  // (the menu's own keys go no further: the app's arrow-key navigation would
  // move the focus a second time)
  const onKey = (ev) => {
    if (!node.contains(document.activeElement) && ev.key !== "Escape") return;
    const i = buttons.indexOf(document.activeElement);
    const own = () => { ev.preventDefault(); ev.stopPropagation(); };
    if (ev.key === "Escape") { own(); closeMenu(); }
    else if (ev.key === "ArrowDown") { own(); buttons[(i + 1) % buttons.length].focus(); }
    else if (ev.key === "ArrowUp") { own(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") own();
    else if (ev.key === "Tab") closeMenu(false);
  };
  const onDown = (ev) => { if (!node.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) closeMenu(false); };
  const onScroll = () => closeMenu(false);
  // (on the window, in the capture phase: before the app's own key handling,
  // which would move the focus a second time and read Escape as Back)
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("resize", onScroll);
  window.addEventListener("scroll", onScroll, { passive: true });
  openMenu = { node, anchor, off: () => {
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("resize", onScroll);
    window.removeEventListener("scroll", onScroll);
  } };
  pushScope(node); // (the arrows and a hovering pointer stay in the menu; focuses its first item)
};

// ---------- the section ----------
export const yourFilesSection = () => {
  // the inputs: files (any mix), a folder, one file again, subtitles for one title
  const input = el("input", { type: "file", class: "lf-input", accept: `${VIDEO_ACCEPT},${SUB_ACCEPT}`, multiple: true, hidden: true, "aria-hidden": "true", tabindex: "-1" });
  const folderInput = el("input", { type: "file", class: "lf-input-folder", multiple: true, hidden: true, "aria-hidden": "true", tabindex: "-1" });
  folderInput.setAttribute("webkitdirectory", "");
  const againInput = el("input", { type: "file", class: "lf-input-again", accept: VIDEO_ACCEPT, hidden: true, "aria-hidden": "true", tabindex: "-1" });
  const subsInput = el("input", { type: "file", class: "lf-input-subs", accept: SUB_ACCEPT, multiple: true, hidden: true, "aria-hidden": "true", tabindex: "-1" });
  let againFor = null; // the title a "pick it again" is for
  let subsFor = null; // the title "Add subtitles" is for

  const count = el("span", { class: "count lf-count" });
  const reconnectBtn = el("button", { class: "btn small focusable lf-reconnect hidden", onclick: () => doReconnect() });
  const addBtn = el("button", { class: "btn small focusable lf-add", html: `${icons.plus}<span>Add files</span>`, onclick: () => pickFiles() });
  const canFolder = typeof window.showDirectoryPicker === "function" || "webkitdirectory" in folderInput;
  const folderBtn = canFolder ? el("button", { class: "btn small focusable lf-add-folder", html: "<span>Add a folder</span>", onclick: () => pickFolder() }) : null;
  const busyLine = el("span", { class: "lf-busy hidden", role: "status", "aria-live": "polite" });

  const drop = el("button", { class: "lf-drop focusable", type: "button", onclick: () => pickFiles() },
    el("span", { class: "lf-drop-icon", html: ICON_DROP }),
    el("span", { class: "lf-drop-words" },
      el("span", { class: "lf-drop-title" },
        el("span", { class: "lf-on-pointer" }, "Drop videos and subtitles here"),
        el("span", { class: "lf-on-touch" }, "Choose videos and subtitles")),
      el("span", { class: "lf-drop-text" }, "Many at once, or a whole folder — each subtitle finds its video by name."),
      el("span", { class: "lf-drop-more" },
        el("span", { class: "lf-on-pointer" }, "Drop more files here, or click to choose"),
        el("span", { class: "lf-on-touch" }, "Add more files"))),
    el("span", { class: "btn btn-primary lf-drop-btn", "aria-hidden": "true" }, "Choose files"),
    el("span", { class: "lf-drop-safe" }, "🔒 Nothing is uploaded — your files play straight from this device"));
  const groups = el("div", { class: "lf-groups" });
  const looseHost = el("div", { class: "lf-loose page-pad hidden" });
  const veil = el("div", { class: "lf-veil", "aria-hidden": "true" }, el("div", { class: "lf-veil-box" }, el("span", { html: ICON_DROP }), el("b", {}, "Drop to add to Your files"), el("span", {}, "Videos, subtitles or whole folders — nothing is uploaded")));

  const section = el("section", { class: "lf", "aria-labelledby": "lf-title" },
    el("div", { class: "lf-head page-pad" },
      el("h2", { class: "row-title lf-title", id: "lf-title" }, "Your files", count),
      el("div", { class: "lf-tools" }, busyLine, reconnectBtn, addBtn, folderBtn)),
    el("div", { class: "page-pad lf-drop-host" }, drop),
    groups,
    looseHost,
    veil,
    input, folderInput, againInput, subsInput);

  // ---------- adding ----------
  let busyN = 0;
  const busy = (on) => {
    busyN += on ? 1 : -1;
    busyLine.textContent = busyN > 0 ? "Adding…" : "";
    busyLine.classList.toggle("hidden", busyN <= 0);
    section.classList.toggle("adding", busyN > 0);
  };
  const say = (r, capped) => {
    const bits = [];
    if (r.added) bits.push(`Added ${plural(r.added, "title")}`);
    if (r.again) bits.push(`${plural(r.again, "file")} open again`);
    if (r.subsPaired) bits.push(`${plural(r.subsPaired, "subtitle")} paired`);
    if (r.subsLoose) bits.push(`${plural(r.subsLoose, "subtitle")} waiting for a video`);
    if (!bits.length && r.already) bits.push("Already in Your files");
    if (r.full) bits.push(`${plural(r.full, "file")} left out — the list is full`);
    if (capped) bits.push("a very big folder: only the first part was looked at");
    if (bits.length) toast(bits.join(" · "), "📂");
    if (r.unreadable.length) toast(`Couldn't read ${r.unreadable.length === 1 ? `“${r.unreadable[0]}”` : plural(r.unreadable.length, "subtitle file")} as subtitles`, "💬");
    if (r.ignored.length) toast(`${r.ignored.length === 1 ? `“${r.ignored[0]}” isn't` : `${r.ignored.length} files aren't`} a video or a subtitle file (.srt, .vtt, .ass)`, "📂");
  };
  const take = async (got, opts) => {
    const { batch, capped } = await got;
    if (!batch.length) {
      toast(capped ? "Nothing found in time — try a smaller folder" : "No videos or subtitles there", "📂");
      return null;
    }
    busy(true);
    try {
      const r = await lp.addFiles(batch, opts);
      say(r, capped);
      return r;
    } finally {
      busy(false);
    }
  };
  const pickFiles = async () => {
    if (typeof window.showOpenFilePicker === "function") {
      let handles;
      try {
        handles = await window.showOpenFilePicker({ multiple: true, id: "aurora-local", types: PICKER_TYPES });
      } catch (e) {
        if (e && e.name === "AbortError") return;
        input.click(); // (refused here — an embedded page, say: the plain picker)
        return;
      }
      take(lp.fromHandles(handles));
      return;
    }
    input.click();
  };
  const pickFolder = async () => {
    if (typeof window.showDirectoryPicker === "function") {
      let dirHandle;
      try {
        dirHandle = await window.showDirectoryPicker({ id: "aurora-local", mode: "read" });
      } catch (e) {
        if (e && e.name === "AbortError") return;
        folderInput.click();
        return;
      }
      take(lp.fromHandles([dirHandle]));
      return;
    }
    folderInput.click();
  };
  input.addEventListener("change", () => { const got = lp.fromInput(input.files); input.value = ""; take(got); });
  folderInput.addEventListener("change", () => { const got = lp.fromInput(folderInput.files); folderInput.value = ""; take(got); });
  againInput.addEventListener("change", async () => {
    const want = againFor;
    againFor = null;
    const got = lp.fromInput(againInput.files);
    againInput.value = "";
    const r = await take(got);
    if (!r || !want) return;
    if (r.keys.includes(want.key)) navigate(`#/play/${want.id}?local=1`);
    else if (r.added) toast(`That's a different file — it's in Your files now. “${want.name}” still needs picking.`, "📂");
  });
  subsInput.addEventListener("change", () => {
    const to = subsFor;
    subsFor = null;
    const got = lp.fromInput(subsInput.files);
    subsInput.value = "";
    if (to) take(got, { to: to.key });
  });
  const doReconnect = async () => {
    const n = await lp.reconnect();
    if (!n) toast("The browser didn't reopen them — pick the files again to keep watching", "📂");
  };

  // ---------- the cards' actions ----------
  const actions = {
    play: async (e) => {
      if (e.avail === "ready") return navigate(`#/play/${e.id}?local=1`);
      if (e.avail === "locked" && (await lp.reconnect([e.key]))) return navigate(`#/play/${e.id}?local=1`);
      // pick it again: matched by its name and size
      againFor = e;
      againInput.click();
    },
    menu: (e, anchor) => {
      if (openMenu && openMenu.anchor === anchor) return closeMenu();
      const title = e.parsed.kind === "episode" ? `${e.parsed.show} · ${titleWords(e)}` : e.parsed.title;
      showMenu(anchor, {
        head: e.reason || (e.avail === "missing" ? `Pick “${e.name}” again to keep watching.` : e.name),
        items: [
          e.avail === "ready" && { text: e.position && !e.position.finished ? `Resume from ${fmtClock(e.position.position)}` : "Play", run: () => navigate(`#/play/${e.id}?local=1`) },
          e.avail === "ready" && e.position && !e.position.finished && { text: "Play from the start", run: () => navigate(`#/play/${e.id}?local=1&restart=1`) },
          e.avail !== "ready" && { text: e.avail === "locked" ? "Reconnect the file" : "Pick the file again", run: () => actions.play(e) },
          { text: "Add subtitles…", run: () => { subsFor = e; subsInput.click(); } },
          ...e.subs.map((s) => ({ text: `Unpair ${s.label} (${s.name})`, run: () => lp.detachSub(e.key, s.key) })),
          { text: "Remove from Your files", danger: true, run: () => {
            const snap = lp.removeTitle(e.key);
            toast(`Removed “${title}” from Your files`, "🗑", { label: "Undo", onClick: () => lp.restoreTitle(snap) });
          } },
        ],
      });
    },
  };

  // ---------- drawing ----------
  const nodes = new Map(); // key -> { sig, node }
  const nodeFor = (e) => {
    const sig = signature(e);
    const hit = nodes.get(e.key);
    if (hit && hit.sig === sig) return hit.node;
    const node = cardFor(e, actions);
    // focus stays where it was when a card is drawn again
    if (hit && hit.node.contains(document.activeElement)) {
      const cls = document.activeElement.classList.contains("lf-more") ? ".lf-more" : ".lf-play";
      queueMicrotask(() => { const t = node.querySelector(cls); if (t && node.isConnected) t.focus({ preventScroll: true }); });
    }
    if (hit) hit.node.replaceWith(node);
    nodes.set(e.key, { sig, node });
    return node;
  };
  const group = (key, title, sub, list) =>
    el("div", { class: "lf-group", "data-group": key },
      title && el("h3", { class: "lf-group-title page-pad" }, el("bdi", { dir: "auto" }, title), sub && el("span", { class: "lf-group-sub" }, sub)),
      el("div", { class: "grid lf-grid" }, list.map(nodeFor)));
  let layout = ""; // the groups and which cards they hold, as last drawn
  let looseSig = "";
  const paint = () => {
    const v = lp.libraryView();
    count.textContent = v.count ? String(v.count) : "";
    section.classList.toggle("lf-empty", !v.count);
    const plan = [];
    if (v.films.length) plan.push(["films", v.shows.length ? "Films" : "", v.shows.length ? plural(v.films.length, "film") : "", v.films]);
    for (const s of v.shows) {
      for (const season of s.seasons) {
        const label = season.season != null ? `Season ${season.season}` : "";
        plan.push([`${s.key}|${season.season}`, s.name, [label, plural(season.episodes.length, "episode")].filter(Boolean).join(" · "), season.episodes]);
      }
    }
    const nextLayout = JSON.stringify(plan.map(([k, t, sub, list]) => [k, t, sub, list.map((e) => e.key)]));
    if (nextLayout === layout) {
      // the same groups and cards: only a card that changed is drawn again,
      // in place (the rest — and the focus on them — stay put)
      for (const [, , , list] of plan) list.forEach(nodeFor);
    } else {
      layout = nextLayout;
      const seen = new Set(plan.flatMap(([, , , list]) => list.map((e) => e.key)));
      for (const k of [...nodes.keys()]) if (!seen.has(k)) nodes.delete(k);
      const had = document.activeElement && groups.contains(document.activeElement) ? document.activeElement : null;
      groups.replaceChildren(...plan.map(([k, t, sub, list]) => group(k, t, sub, list)));
      if (had && had.isConnected) had.focus({ preventScroll: true });
    }
    // Reconnect: the kept files the browser wants asked about first
    reconnectBtn.textContent = v.locked ? `Reconnect ${plural(v.locked, "file")}` : "";
    reconnectBtn.classList.toggle("hidden", !v.locked);
    // the subtitles no video claimed
    looseHost.classList.toggle("hidden", !v.loose.length);
    // (drawn again only when it changed: an open "Attach to…" list stays open
    // while the cards above fill in)
    const nextLoose = JSON.stringify([v.loose, v.targets, v.count]);
    if (nextLoose === looseSig) { /* as it is */ }
    else if (v.loose.length) {
      looseSig = nextLoose;
      const focusedKey = document.activeElement && looseHost.contains(document.activeElement) ? document.activeElement.closest("[data-key]")?.dataset.key : null;
      looseHost.replaceChildren(
        el("h3", { class: "lf-group-title" }, "Subtitles without a video", el("span", { class: "lf-group-sub" }, String(v.loose.length))),
        el("p", { class: "lf-note" }, v.count ? "Their names don't say which video they're for — attach each one to its video." : "Add the video they belong to, or drop it here with them."),
        el("ul", { class: "lf-loose-list" }, v.loose.map((s) => {
          const select = el("select", { class: "lf-attach focusable", "aria-label": `Attach ${s.name} to`, disabled: !v.targets.length,
            onchange: () => { if (select.value) { lp.attachLoose(s.key, select.value); toast(`Attached “${s.name}”`, "💬"); } } },
          el("option", { value: "" }, v.targets.length ? "Attach to…" : "No video yet"),
          v.targets.map((t) => el("option", { value: t.key }, t.label)));
          return el("li", { class: "lf-loose-row", "data-key": s.key },
            el("span", { class: "lf-lang", title: s.label }, s.lang ? s.lang.toUpperCase() : "SUB"),
            el("span", { class: "lf-loose-name" }, el("bdi", { dir: "auto" }, s.name), el("small", {}, s.lang ? LANG_NAMES[s.lang] || s.label : "language unknown")),
            select,
            el("button", { class: "lf-x focusable", "aria-label": `Forget ${s.name}`, onclick: () => lp.removeLoose(s.key) }, "×"));
        })));
      if (focusedKey) { const t = looseHost.querySelector(`[data-key="${CSS.escape(focusedKey)}"] select`); if (t) t.focus({ preventScroll: true }); }
    } else {
      looseSig = nextLoose;
      looseHost.replaceChildren();
    }
  };
  untilLeave(lp.onLibrary(paint));
  untilLeave(() => closeMenu(false));
  paint();
  lp.loadLibrary().then(paint);

  // ---------- drag and drop, anywhere on the page ----------
  let depth = 0;
  const carriesFiles = (ev) => !!ev.dataTransfer && [...(ev.dataTransfer.types || [])].includes("Files");
  const onEnter = (ev) => {
    if (!carriesFiles(ev)) return;
    ev.preventDefault();
    depth++;
    section.classList.add("dragging");
    document.documentElement.classList.add("lf-dragging");
  };
  const onOver = (ev) => {
    if (!carriesFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
  };
  const end = () => {
    depth = 0;
    section.classList.remove("dragging");
    document.documentElement.classList.remove("lf-dragging");
  };
  const onLeave = (ev) => {
    if (!carriesFiles(ev)) return;
    // (leaving the window has no element to go to)
    if (--depth <= 0 || !ev.relatedTarget) end();
  };
  const onDrop = (ev) => {
    if (!ev.dataTransfer) return;
    ev.preventDefault();
    end();
    const grabbed = lp.grabDrop(ev.dataTransfer); // now, while the drop lasts
    if (grabbed.length) take(lp.resolveDrop(grabbed));
  };
  document.addEventListener("dragenter", onEnter);
  document.addEventListener("dragover", onOver);
  document.addEventListener("dragleave", onLeave);
  document.addEventListener("drop", onDrop);
  untilLeave(() => {
    document.removeEventListener("dragenter", onEnter);
    document.removeEventListener("dragover", onOver);
    document.removeEventListener("dragleave", onLeave);
    document.removeEventListener("drop", onDrop);
    end();
  });

  // The player's code, fetched now: a connection that drops between here and
  // Play (the point of offline mode) must not leave the player unloadable.
  // (With the service worker it comes from its cache anyway.)
  setTimeout(() => { import("./screens/player.js").catch(() => {}); }, 0);
  return section;
};
