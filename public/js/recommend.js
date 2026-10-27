// Recommending a title to people of the household, and what the person who
// got one can do with it — the website's half (the TV's is
// tv-native/src/householdRecs.ts + its screens; the server's rules are
// src/media/household.js, the decisions docs/qa/household-recs/DESIGN.md).
//
//   recommendButton(item)   "Recommend" (title pages, the peek sheet, the end of a film)
//   openRecommend(item)     the sheet: pick people (faces), an optional note, Send
//   recBanner(item)         "Recommended by Dana" + the notes + Not for me (title pages)
//   addFromRec(item)        one press to My List from a recommendation
//   dismissRec(item)        Not for me (with Undo)
//   watchArrivals()         the toast when something new arrives (main.js, once)
import { el, icons, toast, LIST_ADDED, listFailedLine, haptic } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { navigate } from "./router.js";
import { pushScope, popScope } from "./focus.js";
import { onMessage } from "./ws.js";
import { track } from "./usage.js";

// ---------- words (the TV prints the same: tv-native/src/householdRecs.ts) ----------
export const NOTE_MAX = 140;
export const names = (list) => {
  const n = (list || []).filter(Boolean);
  if (n.length === 0) return "";
  if (n.length === 1) return n[0];
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  return `${n[0]} and ${n.length - 1} others`;
};
export const fromLine = (list) => ((list || []).length ? `From ${names(list)}` : "");
export const byLine = (list) => `Recommended by ${names(list)}`;
export const sendLabel = (n) => (n > 0 ? `Send to ${n}` : "Send");
export const STATUS_WORDS = { sent: "Sent", seen: "Seen", added: "In their list", watching: "Watching", watched: "Watched" };
export const ROW_TITLE = "Recommended by your household";
export const SHOW_ALL = "Show all recommended";
export const HIDDEN_LINE = "Hidden from your recommendations";
export const arrivalLine = (unseen) =>
  unseen.length === 1
    ? `${unseen[0].hh.from[0].name} recommended ${unseen[0].title}`
    : `${unseen.length} new recommendations from your household`;
const noteLen = (s) => Array.from(String(s || "")).length;

// ---------- which title ----------
const isEpisode = (item) => !!item && !!item.showId && item.type !== "show";
// The key the server keeps a title under: its IMDb id, else its library id
// (an episode stands for its show).
export const recKeyOf = (item) => {
  if (!item) return null;
  if (/^tt\d{4,12}$/.test(String(item.imdbId || "")) && !isEpisode(item)) return item.imdbId;
  if (isEpisode(item)) return item.showId ? `lib:${item.showId}` : null;
  const id = String(item.id || "");
  if (!id || id.startsWith("torrent|") || id.startsWith("stream|") || item.source === "stream") return null;
  return `lib:${id}`;
};
// What is sent: a library title by id (the server looks it up), a catalogue
// title described (the same shape My List keeps for it).
export const recRefOf = (item) => {
  if (!item) return null;
  if (isEpisode(item)) return item.showId ? { id: item.showId } : null;
  const id = String(item.id || "");
  if (id && item.source !== "stream" && !id.startsWith("torrent|") && !id.startsWith("stream|")) return { id };
  if (!/^tt\d{4,12}$/.test(String(item.imdbId || ""))) return null;
  return {
    imdbId: item.imdbId,
    type: item.type === "show" || item.type === "series" ? "show" : "movie",
    title: item.title || "",
    poster: item.cover || item.poster || null,
    year: item.year || null,
    genres: item.genres || [],
    rating: item.rating || null,
  };
};
const typeOf = (item) => (item && (item.type === "show" || item.type === "series" || isEpisode(item)) ? "show" : "movie");
const titleOf = (item) => (isEpisode(item) ? item.showTitle || item.title : item.title) || "this";
export const canRecommend = (item) => !!state.profile && !!recRefOf(item) && !!recKeyOf(item);

// ---------- the button ----------
export const recommendButton = (item, { ui = "detail.recommend", className = "btn focusable", label = "Recommend", onOpen = null } = {}) => { // data-ui
  if (!canRecommend(item)) return null;
  const b = el("button", {
    "data-ui": ui,
    type: "button",
    class: `${className} btn-recommend`,
    "aria-haspopup": "dialog",
    html: icons.recommend + `<span>${label}</span>`,
    onclick: (e) => {
      e.stopPropagation();
      if (onOpen) onOpen();
      openRecommend(item);
    },
  });
  return b;
};

// ---------- the sheet ----------
let openWrap = null;
const avatarOf = (p) =>
  el("span", { class: "rec-face", style: p.color ? { background: p.color } : null, "aria-hidden": "true" },
    p.avatarImage ? el("img", { src: p.avatarImage, alt: "" }) : (p.avatar || "🙂"));

export const openRecommend = async (item) => {
  if (!canRecommend(item) || openWrap) return;
  const pid = state.profile.id;
  const key = recKeyOf(item);
  const ref = recRefOf(item);
  const title = titleOf(item);
  const chosen = new Set();
  let people = [];

  const close = () => {
    if (!openWrap) return;
    const w = openWrap;
    openWrap = null;
    document.removeEventListener("ui-back", w._onBack);
    popScope(w);
    w.classList.add("leaving");
    setTimeout(() => w.remove(), 200);
    if (returnTo && returnTo.isConnected) returnTo.focus({ preventScroll: true });
  };
  const returnTo = document.activeElement;

  const list = el("div", { class: "rec-people", role: "group", "aria-label": "People" },
    el("div", { class: "rec-loading" }, "…"));
  const status = el("div", { class: "rec-status", role: "status", "aria-live": "polite" });
  const note = el("textarea", {
    class: "rec-note focusable",
    rows: 2,
    maxlength: String(NOTE_MAX * 2), // (code points are counted below; this only stops a paste of a novel)
    placeholder: "Add a note (optional)",
    "aria-label": "Add a note (optional)",
  });
  const counter = el("span", { class: "rec-count" }, `0/${NOTE_MAX}`);
  const sendBtn = el("button", { "data-ui": "recommend.send", type: "button", class: "btn btn-primary focusable", disabled: true }, sendLabel(0));
  const paintSend = () => {
    sendBtn.textContent = sendLabel(chosen.size);
    sendBtn.disabled = chosen.size === 0;
  };
  note.addEventListener("input", () => {
    const chars = Array.from(note.value);
    if (chars.length > NOTE_MAX) {
      note.value = chars.slice(0, NOTE_MAX).join("");
    }
    counter.textContent = `${noteLen(note.value)}/${NOTE_MAX}`;
  });
  // Enter sends (Shift+Enter is a space: the note is one line)
  note.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (!sendBtn.disabled) sendBtn.click(); }
  });

  const paintPeople = () => {
    list.innerHTML = "";
    if (!people.length) {
      list.append(el("div", { class: "rec-empty" }, "There's nobody else on this server yet."));
      return;
    }
    for (const p of people) {
      const pickable = p.state === "ok" || p.state === "sent";
      const on = chosen.has(p.id);
      const b = el("button", {
        "data-ui": "recommend.person",
        type: "button",
        class: `rec-person focusable${on ? " on" : ""}${pickable ? "" : " off"}`,
        "aria-pressed": on ? "true" : "false",
        "aria-disabled": pickable ? "false" : "true",
        "aria-label": `${p.name}${p.line ? `, ${p.line}` : ""}`,
        onclick: () => {
          if (!pickable) return;
          if (chosen.has(p.id)) chosen.delete(p.id); else chosen.add(p.id);
          haptic(6);
          paintPeople();
          paintSend();
          list.querySelector(`[data-pid="${CSS.escape(p.id)}"]`)?.focus({ preventScroll: true });
        },
      },
      avatarOf(p),
      el("span", { class: "rec-check", "aria-hidden": "true", html: icons.check }),
      el("span", { class: "rec-name" }, p.name),
      p.line && el("span", { class: "rec-line" }, p.line));
      b.dataset.pid = p.id;
      list.append(b);
    }
  };

  sendBtn.addEventListener("click", async () => {
    if (!chosen.size) return;
    sendBtn.disabled = true;
    status.textContent = "";
    try {
      const r = await api.recommend(pid, [...chosen], ref, note.value);
      track("feat", { f: "hhrec-send" });
      const refused = (r.refused || []).map((x) => x.line).filter(Boolean);
      if ((r.sent || []).length) {
        close();
        toast([r.line, ...refused].join(" · "), "📨");
        return;
      }
      status.textContent = refused.join(" · ") || r.line || "Nothing was sent";
      // what changed (a limit, someone turning it off): the faces say so now
      await loadPeople();
      for (const id of [...chosen]) {
        const p = people.find((x) => x.id === id);
        if (!p || (p.state !== "ok" && p.state !== "sent")) chosen.delete(id);
      }
      paintPeople();
      paintSend();
    } catch (e) {
      status.textContent = (e && e.message) || "Couldn't send that — try again";
      paintSend();
    }
  });

  const sheet = el("div", { class: "rec-sheet", role: "dialog", "aria-modal": "true", "aria-label": `Recommend “${title}”` },
    el("div", { class: "rec-head" },
      el("div", {},
        el("h2", { class: "rec-title" }, `Recommend “${title}”`),
        el("p", { class: "rec-sub" }, "Pick who should see it")),
      el("button", { "data-ui": "recommend.close", type: "button", class: "btn btn-icon focusable rec-close", "aria-label": "Close", html: "✕", onclick: () => close() })),
    list,
    el("label", { class: "rec-note-wrap" }, note, counter),
    status,
    el("div", { class: "rec-actions" }, sendBtn),
  );
  const wrap = el("div", { class: "rec-wrap ui-overlay", onclick: (e) => e.target === wrap && close() }, sheet);
  wrap._onBack = (e) => { e.preventDefault(); close(); };
  document.addEventListener("ui-back", wrap._onBack);
  (document.fullscreenElement || document.body).append(wrap);
  openWrap = wrap;
  pushScope(wrap);
  track("feat", { f: "hhrec-open" });

  const loadPeople = async () => {
    const r = await api.recommendPeople(pid, key, typeOf(item));
    people = (r && r.people) || [];
  };
  try {
    await loadPeople();
  } catch (e) {
    people = [];
    status.textContent = (e && e.message) || "Couldn't load the household — try again";
  }
  if (openWrap !== wrap) return;
  // the note a person already has from you, offered back to edit
  const mine = people.find((p) => p.state === "sent" && p.note);
  if (mine && !note.value) {
    note.value = mine.note;
    counter.textContent = `${noteLen(note.value)}/${NOTE_MAX}`;
  }
  paintPeople();
  paintSend();
  (list.querySelector(".rec-person:not(.off)") || sendBtn).focus({ preventScroll: true });
};

// ---------- receiving ----------
// One press to My List from a recommendation. -> true when it went
export const addFromRec = async (item) => {
  if (!state.profile) return false;
  const ref = item.source === "stream"
    ? { imdbId: item.imdbId, type: item.type === "show" ? "show" : "movie", title: item.title, poster: item.cover || null, year: item.year || null, genres: item.genres || [], rating: item.rating || null }
    : item.id;
  try {
    await api.toggleWatchlist(state.profile.id, ref, true);
    toast(LIST_ADDED, "➕");
    track("feat", { f: "hhrec-add" });
    window.dispatchEvent(new CustomEvent("aurora-watchlist", { detail: { imdbId: item.imdbId || null, libraryId: item.source === "stream" ? null : item.id, inList: true } }));
    return true;
  } catch {
    toast(listFailedLine(true), "⚠️");
    return false;
  }
};

// Not for me: the title leaves this person's recommendations (from every
// sender; nobody is told). `onUndo` is called if they take it back.
export const dismissRec = async (item, { onDone = null, onUndo = null } = {}) => {
  const key = (item.hh && item.hh.key) || recKeyOf(item);
  if (!state.profile || !key) return false;
  const pid = state.profile.id;
  try {
    await api.householdDismiss(pid, key);
  } catch {
    toast("Couldn't hide that — try again", "⚠️");
    return false;
  }
  track("feat", { f: "hhrec-dismiss" });
  if (onDone) onDone();
  toast(HIDDEN_LINE, "🙈", {
    label: "Undo",
    onClick: async () => {
      try {
        await api.householdDismiss(pid, key, true);
        if (onUndo) onUndo();
      } catch { toast("Couldn't undo that", "⚠️"); }
    },
  });
  return true;
};

// The title page's line: who recommended it, the notes, and Not for me.
// Fills itself in (and counts the title as seen); stays empty when nobody did.
export const recBanner = (item) => {
  if (!state.profile) return null;
  const key = recKeyOf(item);
  if (!key) return null;
  const node = el("div", { class: "rec-banner page-pad hidden" });
  api.householdFor(state.profile.id, key).then((r) => {
    const from = (r && r.from) || [];
    if (!from.length || r.dismissed) return;
    const nameList = [...new Set(from.map((f) => f.name))];
    node.append(
      el("div", { class: "rec-banner-body" },
        el("span", { class: "rec-banner-icon", "aria-hidden": "true", html: icons.recommend }),
        el("div", {},
          el("div", { class: "rec-banner-head" }, byLine(nameList)),
          ...from.filter((f) => f.note).map((f) => el("div", { class: "rec-banner-note" }, `“${f.note}” — ${f.name}`))),
        el("button", {
          "data-ui": "detail.hh.dismiss",
          type: "button",
          class: "btn small focusable rec-banner-no",
          onclick: () => dismissRec({ hh: { key } }, {
            onDone: () => node.classList.add("hidden"),
            onUndo: () => node.classList.remove("hidden"),
          }),
        }, "Not for me")),
    );
    node.classList.remove("hidden");
  }).catch(() => {});
  return node;
};

// Something new arrived for the person on this device: the server's ping
// names no title (it rides a socket), so the list is asked for here, and
// each arrival is told once per tab.
const told = new Set();
export const watchArrivals = () => {
  onMessage("household_recs", async (msg) => {
    const p = state.profile;
    if (!p || (msg && msg.profile && msg.profile !== p.id)) return;
    let r = null;
    try { r = await api.household(p.id); } catch { return; }
    if (!state.profile || state.profile.id !== p.id) return;
    const fresh = ((r && r.items) || []).filter((i) => i.hh && i.hh.unseen && !told.has(`${p.id}|${i.hh.key}|${i.hh.at}`));
    if (!fresh.length) return;
    for (const i of fresh) told.add(`${p.id}|${i.hh.key}|${i.hh.at}`);
    track("feat", { f: "hhrec-toast" });
    toast(arrivalLine(fresh), "📨", {
      label: "Show",
      onClick: () => {
        if (fresh.length === 1) {
          // the title itself (a card knows how to open)
          import("./components.js").then((m) => m.openItem(fresh[0]));
        } else navigate("#/household");
      },
    });
  });
};
