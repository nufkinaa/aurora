// Preferences: your profile (name/avatar/password), playback + subtitle
// defaults, and the liked genres used to tailor Home recommendations.
// Reopenable anytime from the nav gear.
import { el, toast, rerenderInPlace, keptScrollFor, restoreScrollY, promptSheet, haptic } from "../ui.js";
import { loadLibrary, loadProfiles, state, applyAppearance, setPersonPref } from "../state.js";
import { api, setAuthToken } from "../api.js";
import { navigate } from "../router.js";
import { profileModal, kidsLabel } from "./profiles.js";
import { playerPrefs, applyCueStyle, cuePreview, paintCuePreview } from "./player.js";
// [player-options] sound + the look of subtitles, the person's (2026-10-19)
import { readStyle, nextChoice, styleLabel, SUB_STYLE_KEYS, SUB_STYLE_SETTINGS } from "../subStyle.js";
import { AUDIO_FX_KEYS, AUDIO_FX_NAMES, AUDIO_FX_NOTES, fxBlocked } from "../audiofx.js";
import { showClaimModal } from "../claim.js";
import { showLoginScreen } from "./login.js";
import * as offlineStore from "../offline.js";
import { dataMode, setDataMode, netInfo } from "../net.js";
import * as push from "../push.js";
import * as remote from "../remote.js"; // [phone-remote]

// One settings row: label + explanation on the left, a button cycling the value
// on the right. Every row here drives behaviour that already exists in the
// player — these settings used to be reachable only from the gear menu while
// something was playing, which is a poor place to find "subtitles on by
// default".
// One plain grey line icon per section and per setting: a picture to
// recognise a row by before reading it (elia: "my little sister also needs
// to understand this"). 24px grid, stroke only, drawn in the dim text colour.
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICONS = {
  // sections
  "Your profile": '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.500 4-6.500 8-6.500s7 2 8 6.500"/>',
  "What's new": '<path d="M12 3l2.200 5.800L20 11l-5.800 2.200L12 19l-2.200-5.800L4 11l5.800-2.200z"/>',
  "Sign-in": '<circle cx="8" cy="14" r="4"/><path d="M11 11l9-9M17 5l3 3M14 8l2 2"/>',
  "Appearance": '<path d="M12 3a9 9 0 100 18c1.500 0 2-1 2-2 0-1.500 1-2 2.500-2H18a3 3 0 003-3c0-6-4-11-9-11z"/><circle cx="7.500" cy="11" r="1"/><circle cx="11" cy="7" r="1"/><circle cx="16" cy="8.500" r="1"/>',
  "Your home page": '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  "Watching": '<path d="M7 4.500v15l12-7.500z"/>',
  "Downloads": '<path d="M12 4v11"/><path d="M7.500 11l4.500 4.500 4.500-4.500"/><path d="M5 20h14"/>',
  "Internet": '<path d="M5 20v-4M10 20v-8M15 20V8M20 20V4"/>',
  // On the TV (TV round 2026-10-19): a screen on its stand; a film strip's frames; a speaker's waves
  "On the TV": '<rect x="3" y="4.500" width="18" height="12" rx="1.500"/><path d="M8 20.500h8M12 16.500v4"/>',
  "Match frame rate": '<rect x="4" y="4" width="16" height="16" rx="1.500"/><path d="M8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4"/>',
  "Surround sound": '<path d="M4 9.500h3l4-3.500v12l-4-3.500H4z"/><path d="M15 9a4 4 0 010 6M17.500 6.500a7.500 7.500 0 010 11"/>',
  "Watch without internet": '<rect x="6" y="2.500" width="12" height="19" rx="2.500"/><path d="M12 8v6M9.500 12l2.500 2.500 2.500-2.500"/>',
  "Subtitles": '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 14h4M14 14h3M7 10.500h2M12 10.500h5"/>',
  "Privacy": '<path d="M12 3l8 3v6c0 4.500-3.200 8-8 9-4.800-1-8-4.500-8-9V6z"/>',
  // household recommendations: a paper plane
  "Recommendations": '<path d="M3.500 20 21 12 3.500 4l2.500 8-2.500 8z"/><path d="M6 12h15"/>',
  "Recommendations from the household": '<path d="M3.500 20 21 12 3.500 4l2.500 8-2.500 8z"/><path d="M6 12h15"/>',
  "Genres you like": '<path d="M12 20s-7-4.300-7-9.500A4 4 0 0112 8a4 4 0 017 2.500C19 15.700 12 20 12 20z"/>',
  // settings
  "Trailers on the home page": '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v14M16 5v14M3 10h5M3 14h5M16 10h5M16 14h5"/>',
  "Play the next episode": '<path d="M5 5v14l10-7z"/><path d="M19 5v14"/>',
  "Tell me when it's ready": '<path d="M6 16V11a6 6 0 0112 0v5l1.500 2h-15z"/><path d="M10 20.500a2 2 0 004 0"/>',
  "Get the next episode ready": '<path d="M12 4v11"/><path d="M7.500 11l4.500 4.500 4.500-4.500"/><path d="M5 20h14"/>',
  "Tidy up after watching": '<path d="M4 7h16M9 7V4.500h6V7M6.500 7l1 13h9l1-13"/>',
  "Internet use": '<path d="M5 20v-4M10 20v-8M15 20V8M20 20V4"/>',
  "Size of saved copies": '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  "Saved on this device": '<rect x="6" y="2.500" width="12" height="19" rx="2.500"/><path d="M10.500 18h3"/>',
  "Subtitles on by themselves": '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 14h4M14 14h3"/>',
  "Subtitle language": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.500 3 14.500 0 18M12 3c-3 3.500-3 14.500 0 18"/>',
  "Subtitle size": '<path d="M3 18l4.500-11L12 18M4.500 14.500h6"/><path d="M14 18l3-7 3 7M15 16h4"/>',
  "Dark box behind subtitles": '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h10"/>',
  // [player-options]
  "Sound": '<path d="M4 9.500h3.500L12 5.500v13L7.500 14.500H4z"/><path d="M15.500 9a4 4 0 010 6M18 6.500a7.500 7.500 0 010 11"/>',
  "Night mode": '<path d="M19 14.500A7.500 7.500 0 019.500 5a7.500 7.500 0 109.500 9.500z"/>',
  "Dialogue boost": '<path d="M4 6.500A2.500 2.500 0 016.500 4h11A2.500 2.500 0 0120 6.500v7a2.500 2.500 0 01-2.500 2.500H10l-4 4v-4h0a2.500 2.500 0 01-2-2.500z"/><path d="M8.500 10h7M12 7v6"/>',
  "Text colour": '<path d="M5 19l5.500-14h3L19 19"/><path d="M7.500 13h9"/>',
  "Background": '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h10"/>',
  "Box opacity": '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 20L20 4M9 20l11-11M14 20l6-6"/>',
  "Text weight": '<path d="M7 4h6a4 4 0 010 8H7zM7 12h7a4 4 0 010 8H7z"/>',
  "Position": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 12h10M10 9l2-2 2 2"/>',
  // the profile card's rows
  "Edit profile & password": '<path d="M4 20h4l10.500-10.500a2.100 2.100 0 00-3-3L5 17z"/><path d="M13.500 6.500l3 3"/>',
  "Edit profile": '<path d="M4 20h4l10.500-10.500a2.100 2.100 0 00-3-3L5 17z"/><path d="M13.500 6.500l3 3"/>',
  "Upload a photo": '<path d="M4 8.500A1.500 1.500 0 015.500 7H8l1.500-2h5L16 7h2.500A1.500 1.500 0 0120 8.500V18a1.500 1.500 0 01-1.500 1.500h-13A1.500 1.500 0 014 18z"/><circle cx="12" cy="13" r="3.200"/>',
  "Change photo": '<path d="M4 8.500A1.500 1.500 0 015.500 7H8l1.500-2h5L16 7h2.500A1.500 1.500 0 0120 8.500V18a1.500 1.500 0 01-1.500 1.500h-13A1.500 1.500 0 014 18z"/><circle cx="12" cy="13" r="3.200"/>',
  "Remove photo": '<path d="M4 7h16M9 7V4.500h6V7M6.500 7l1 13h9l1-13"/>',
  "Your Aurora Wrapped": '<path d="M12 3l1.800 4.700L18.500 9.500l-4.700 1.800L12 16l-1.800-4.700L5.500 9.500l4.700-1.800z"/><path d="M19 15l.800 2.200L22 18l-2.200.800L19 21l-.800-2.200L16 18l2.200-.800z"/>',
  "Swipe your taste": '<rect x="7" y="3.500" width="11" height="16" rx="2" transform="rotate(8 12.500 11.500)"/><rect x="5" y="4.500" width="11" height="16" rx="2"/><path d="M10.500 15.500s-2.800-1.700-2.800-3.700a1.500 1.500 0 012.800-.900 1.500 1.500 0 012.800.900c0 2-2.800 3.700-2.800 3.700z"/>',
  "Help improve Aurora": '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
};
const iconFor = (name) => (ICONS[name] ? el("span", { class: "pref-icon", html: svg(ICONS[name]) }) : null);

// A setting: icon, name, one short line, and its control. Two-state settings
// (On / Off) are a switch; anything with more choices is a button that steps
// through them.
// (`steps`: a choice of named values that is never drawn as a switch, even
// when one of its values is "Off" — "Match frame rate: Auto / Off")
const prefRow = (label, note, valueText, onCycle, { steps = false } = {}) => {
  const isSwitch = () => !steps && (valueText() === "On" || valueText() === "Off");
  const value = el("span", {}, valueText());
  const control = el("button", { "data-ui": "settings.toggle",
    class: "btn small focusable pref-item-value",
    onclick: async () => { if (isSwitch()) haptic(8); await onCycle(); paint(); },
  }, value);
  const paint = () => {
    const v = valueText();
    value.textContent = v;
    const sw = isSwitch();
    control.classList.toggle("pref-switch", sw);
    control.classList.toggle("on", sw && v === "On");
    if (sw) {
      control.setAttribute("role", "switch");
      control.setAttribute("aria-checked", v === "On" ? "true" : "false");
      control.setAttribute("aria-label", label);
    }
  };
  paint();
  return el("div", { class: "pref-item" },
    iconFor(label),
    el("div", { class: "pref-item-text" },
      el("div", { class: "pref-item-label" }, label),
      note && el("div", { class: "pref-item-note" }, note)
    ),
    control
  );
};

// A picture-and-sound setting for the TV app (On the TV): on the profile at
// once, put back if the server would not take it.
const tvPref = async (key, value) => {
  const was = (state.profile.prefs || {})[key];
  state.profile.prefs = { ...(state.profile.prefs || {}), [key]: value };
  try {
    await api.updateProfile(state.profile.id, { prefs: { [key]: value } });
  } catch (e) {
    state.profile.prefs = { ...(state.profile.prefs || {}), [key]: was };
    toast((e && e.message) || "Couldn't save that", "⚠️");
  }
};

const cycle = (key, values, fallback) => {
  const cur = playerPrefs.get(key, fallback);
  const i = values.indexOf(cur);
  playerPrefs.set(key, values[(i + 1) % values.length]);
};

// ---------- [player-options] the look of subtitles and the sound ----------
// Both follow the PERSON (state.js setPersonPref): written here, they are on
// the TV and in every browser the next time it reads the profile.
const optionNow = (k, fallback) => playerPrefs.get(k, fallback);
const setOption = (k, v) => {
  playerPrefs.set(k, v);
  setPersonPref(k, v);
  applyCueStyle();
  window.dispatchEvent(new CustomEvent("aurora:player-options"));
};
const styleNowHere = () => {
  const o = {};
  for (const k of SUB_STYLE_KEYS) o[k] = optionNow(k, undefined);
  return readStyle(o);
};
const STYLE_ROW = SUB_STYLE_SETTINGS; // the TV's Settings say the same
// The sample on top (the cue drawn as the player will), then one row per
// choice. Every press repaints the sample at once.
const subtitleLookRows = () => {
  const sample = cuePreview("sub-preview big");
  const items = [];
  const paint = () => {
    const st = styleNowHere();
    paintCuePreview(sample.cue, st, { S: 16, M: 21, L: 27, XL: 34 }[st.subSize]);
    for (const it of items) it.hidden = it.dataset.style === "subOpacity" && st.subBg !== "box";
  };
  const rows = SUB_STYLE_KEYS.map((k) => {
    const row = prefRow(STYLE_ROW[k][0], STYLE_ROW[k][1],
      () => styleLabel(k, styleNowHere()),
      () => { setOption(k, nextChoice(k, styleNowHere()[k])); paint(); });
    row.dataset.style = k;
    items.push(row);
    return row;
  });
  paint();
  // another device changed them while this page is up (state.js): the sample
  // and every row's value; the listener goes once this page has gone
  let mounted = false;
  const onChange = () => {
    if (sample.box.isConnected) mounted = true;
    else if (mounted) return window.removeEventListener("aurora:player-options", onChange);
    paint();
    const st = styleNowHere();
    for (const it of items) {
      const v = it.querySelector(".pref-item-value > span");
      if (v) v.textContent = styleLabel(it.dataset.style, st);
    }
  };
  window.addEventListener("aurora:player-options", onChange);
  // (not a .pref-item: it has no label, and a list of settings is a list of those)
  const wrap = el("div", { class: "sub-preview-row" }, sample.box);
  return [wrap, ...rows];
};
const soundRows = () => {
  const why = fxBlocked({ ua: navigator.userAgent, hasCtx: !!(window.AudioContext || window.webkitAudioContext) });
  return AUDIO_FX_KEYS.map((k) => {
    const row = prefRow(AUDIO_FX_NAMES[k], why || AUDIO_FX_NOTES[k],
      () => (why ? "Not here" : optionNow(k, false) === true ? "On" : "Off"),
      () => {
        if (why) return toast(why, "🔈");
        setOption(k, !(optionNow(k, false) === true));
      });
    row.dataset.fx = k;
    if (why) row.classList.add("disabled");
    return row;
  });
};

// ---------- appearance: 3 curated themes + accent swatches ----------
const THEME_DEFS = [
  { id: "aurora", name: "Aurora", note: "the deep-space default", bg: "#0b0c14", raised: "#131523" },
  { id: "oled", name: "OLED black", note: "true black — perfect on OLED panels", bg: "#000000", raised: "#0b0b12" },
  { id: "warm", name: "Dim warm", note: "candle-lit, easy late at night", bg: "#131009", raised: "#1c1710" },
];
const ACCENTS = ["#8b7bff", "#4ea3ff", "#3ddc97", "#f0b132", "#e05f2c", "#f472b6", "#ff7a7a", "#7fd1e8"];
// Two looks: the classic design, and the glass one (elia's name for it).
const LOOK_DEFS = [
  { id: "legacy", name: "Legacy", note: "the classic Aurora look" },
  { id: "glass", name: "Apple Horror", note: "glass over a living sky, big radii, the new rows" },
];

const appearanceSection = () => {
  const host = el("div", { class: "page-pad", style: { display: "flex", flexDirection: "column", gap: "12px" } });
  const saveAppearance = async (fields) => {
    try {
      const updated = await api.updateProfile(state.profile.id, fields);
      if (updated && updated.id) {
        state.profile = { ...state.profile, ...updated };
        applyAppearance(state.profile);
        paint();
      }
    } catch {
      toast("Couldn't save the look", "⚠️");
    }
  };
  const lookRow = el("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap" } });
  const themeRow = el("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap" } });
  const accentRow = el("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" } });
  const paint = () => {
    const curTheme = state.profile.theme || "aurora";
    const curAccent = state.profile.accent || null;
    const curLook = state.profile.look === "glass" ? "glass" : "legacy";
    lookRow.innerHTML = "";
    for (const l of LOOK_DEFS) {
      lookRow.append(el("button", { "data-ui": "settings.look",
        class: "focusable look-pick" + (l.id === curLook ? " on" : "") + (l.id === "glass" ? " glass-preview" : ""),
        onclick: () => saveAppearance({ look: l.id }),
      },
        el("span", { class: "look-pick-swatch" },
          el("i", { class: "look-pick-nav" }),
          el("i", { class: "look-pick-hero" }),
          el("i", { class: "look-pick-row" }),
        ),
        el("span", { style: { fontWeight: "800", fontSize: "0.9rem", color: "#f3f4f8" } }, l.name),
        el("span", { style: { fontSize: "0.75rem", color: "#9aa1b5" } }, l.note),
      ));
    }
    themeRow.innerHTML = "";
    for (const t of THEME_DEFS) {
      themeRow.append(el("button", { "data-ui": "settings.theme",
        class: "focusable",
        style: {
          display: "flex", flexDirection: "column", gap: "6px", padding: "12px 14px", minWidth: "150px",
          borderRadius: "12px", background: t.bg, textAlign: "left",
          border: t.id === curTheme ? "2px solid var(--accent)" : "1px solid var(--line)",
        },
        onclick: () => saveAppearance({ theme: t.id }),
      },
        el("span", { style: { display: "flex", gap: "5px" } },
          el("i", { style: { width: "26px", height: "16px", borderRadius: "4px", background: t.raised, border: "1px solid rgba(255,255,255,0.12)" } }),
          el("i", { style: { width: "16px", height: "16px", borderRadius: "50%", background: curAccent || "#8b7bff" } }),
        ),
        el("span", { style: { fontWeight: "800", fontSize: "0.9rem", color: "#f3f4f8" } }, t.name),
        el("span", { style: { fontSize: "0.75rem", color: "#9aa1b5" } }, t.note),
      ));
    }
    accentRow.innerHTML = "";
    for (const a of ACCENTS) {
      const active = (curAccent || "#8b7bff") === a;
      accentRow.append(el("button", { "data-ui": "settings.accent",
        class: "focusable",
        title: a,
        "aria-label": "Accent " + a,
        style: {
          width: "34px", height: "34px", borderRadius: "50%", background: a,
          border: active ? "3px solid #fff" : "2px solid transparent",
          boxShadow: active ? "0 0 0 2px " + a : "none",
        },
        // the default violet is stored as "no accent" so future default
        // changes reach profiles that never picked one
        onclick: () => saveAppearance({ accent: a === "#8b7bff" ? null : a }),
      }));
    }
  };
  paint();
  host.append(
    el("div", { class: "pref-note", style: { padding: 0, margin: "0 0 -4px" } }, "Look"),
    lookRow,
    el("div", { class: "pref-note", style: { padding: 0, margin: "6px 0 -4px" } }, "Theme and accent"),
    themeRow,
    accentRow,
  );
  return host;
};

// ---------- home rows: reorder + hide, per profile ----------
const ROW_NAMES = {
  continue: "Continue Watching", "new-episodes": "New Episodes", recommended: "Recommended for You",
  mylist: "My List", "next-watch": "Your Next Watch", "trending-stream": "Trending to Stream",
  "top-rated": "Top Rated by You", "new-movies": "New Movies", upcoming: "Upcoming",
  "recent-movies": "Recently Added", movies: "All Movies", shows: "All Shows",
  household: "Recommended by your household",
};
const rowName = (id, title) => title || ROW_NAMES[id] || (id.startsWith("liked-") ? "More " + id.slice(6) : id);

const CHEV_UP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>';
const CHEV_DOWN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

// Recommendations between the people of the household (js/recommend.js):
// the switch, and who is muted. Kept on the server, for the person — the
// TV's Settings shows the same two (tv-native/src/screens/Settings.tsx).
const householdSection = async (linkRow) => {
  const host = el("div", { class: "pref-list page-pad hh-prefs" });
  let s = null;
  try { s = await api.householdSettings(state.profile.id); } catch {}
  if (!s) {
    host.append(el("div", { class: "empty-note" }, "Couldn't load these right now."));
    return host;
  }
  const save = async (body) => {
    try {
      s = await api.setHouseholdSettings(state.profile.id, body);
    } catch (e) {
      toast(e.message || "Couldn't save that", "⚠️");
    }
    paintMutes();
  };
  const mutes = el("div", { class: "hh-mutes" });
  const muteWrap = el("div", { class: "hh-mute-wrap" },
    el("div", { class: "pref-item-note hh-mute-line" }, "Mute someone and their recommendations stop reaching you. They aren't told."),
    mutes);
  const paintMutes = () => {
    mutes.replaceChildren();
    muteWrap.classList.toggle("hidden", !s.on || !(s.people || []).length);
    for (const p of s.people || []) {
      const b = el("button", {
        "data-ui": "settings.hh.mute",
        type: "button",
        class: `chip focusable${p.muted ? " on" : ""}`,
        "aria-pressed": p.muted ? "true" : "false",
        "aria-label": `${p.muted ? "Muted" : "Mute"} ${p.name}`,
        onclick: () => {
          const muted = (s.people || []).filter((x) => (x.id === p.id ? !x.muted : x.muted)).map((x) => x.id);
          save({ muted });
        },
      }, `${p.name} · ${p.muted ? "Muted" : "Mute"}`);
      mutes.append(b);
    }
  };
  host.append(
    prefRow(
      "Recommendations from the household",
      "People on this server can recommend films and shows to you. They show on Home.",
      () => (s.on ? "On" : "Off"),
      async () => { await save({ on: !s.on }); },
    ),
    muteWrap,
    linkRow("What you sent", "What you recommended, and whether each person saw it, put it on their list or watched it.", () => navigate("#/household/sent")),
  );
  paintMutes();
  return host;
};

const homeRowsSection = async () => {
  const host = el("div", { class: "rows-editor" });
  let entries = []; // [{id, title, hidden}]
  try {
    const home = await api.home(state.profile.id);
    const live = (home.rows || []).map((r) => ({ id: r.id, title: r.title, hidden: false }));
    const prefs = state.profile.rows || { order: [], hidden: [] };
    const liveIds = new Set(live.map((r) => r.id));
    // hidden rows aren't in /api/home any more — resurface them here so they
    // can be un-hidden
    for (const id of prefs.hidden || []) {
      if (!liveIds.has(id)) live.push({ id, title: rowName(id), hidden: true });
      else live.find((r) => r.id === id).hidden = true;
    }
    entries = live;
  } catch {
    host.append(el("div", { class: "empty-note" }, "Couldn't load the rows."));
    return host;
  }

  const save = async () => {
    try {
      const updated = await api.updateProfile(state.profile.id, {
        rows: { order: entries.map((e) => e.id), hidden: entries.filter((e) => e.hidden).map((e) => e.id) },
      });
      if (updated && updated.id) state.profile = { ...state.profile, ...updated };
    } catch { toast("Couldn't save the order", "⚠️"); }
  };

  let flashId = null; // the row that just moved gets a little accent pop
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= entries.length) return;
    [entries[j], entries[i]] = [entries[i], entries[j]];
    flashId = entries[j].id;
    paint();
    save();
  };
  const paint = () => {
    host.innerHTML = "";
    entries.forEach((e, i) => {
      host.append(el("div", {
        class: "pref-item" + (e.id === flashId ? " row-moved" : ""),
        style: e.hidden ? { opacity: "0.45" } : {},
      },
        el("span", { class: "row-grip", "aria-hidden": "true" }, "⠿"),
        el("div", { class: "pref-item-text", style: { flex: "1" } },
          el("div", { class: "pref-item-label" }, rowName(e.id, e.title))),
        el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
          el("button", {
            class: "row-move focusable", html: CHEV_UP, "aria-label": "Move up",
            disabled: i === 0 ? "disabled" : undefined,
            onclick: () => move(i, -1),
          }),
          el("button", {
            class: "row-move focusable", html: CHEV_DOWN, "aria-label": "Move down",
            disabled: i === entries.length - 1 ? "disabled" : undefined,
            onclick: () => move(i, 1),
          }),
          el("button", { "data-ui": "settings.rows.hide",
            class: "mini focusable",
            title: e.hidden ? "Show this row on Home" : "Hide this row from Home",
            onclick: () => { e.hidden = !e.hidden; flashId = e.id; paint(); save(); },
          }, e.hidden ? "🙈 Hidden" : "👁 Shown"),
        ),
      ));
    });
    flashId = null;
    host.append(el("div", { style: { height: "26px" } })); // room under the fade mask
  };
  paint();
  const wrap = el("div", {},
    host,
    el("button", {
      class: "btn small focusable", style: { marginTop: "10px" },
      html: "<span>Reset to default</span>",
      onclick: async () => {
        try {
          const updated = await api.updateProfile(state.profile.id, { rows: { order: [], hidden: [] } });
          if (updated && updated.id) state.profile = { ...state.profile, ...updated };
          toast("Back to the default order");
          rerenderInPlace();
        } catch { toast("Couldn't reset", "⚠️"); }
      },
    }));
  return wrap;
};

export const renderPreferences = async (root) => {
  const screen = el("div", { class: "screen" });
  root.append(screen);
  // a setting that repaints the page (rows order, avatar) keeps your place
  const keepY = keptScrollFor(location.hash);

  if (!state.profile) {
    screen.append(el("div", { class: "empty" }, el("div", { class: "glyph" }, "👤"), "Pick a profile first."));
    return;
  }

  const lib = await loadLibrary();
  const genres = [...new Set([...lib.movies, ...lib.shows].flatMap((i) => i.genres || []))].sort();
  const liked = new Set(state.likedGenres || []);

  const save = async () => {
    state.likedGenres = [...liked];
    try { await api.setPreferences(state.profile.id, state.likedGenres); } catch {}
  };

  // One chip per genre, however the sources spell it: the library carries
  // "Sci-Fi", "Science Fiction" and "Science-Fiction" side by side (different
  // metadata providers), and they showed as three choices. A chip stands for
  // every spelling — pressing it likes or unlikes them all, so Home's matching
  // (by the exact string) needs to know nothing about this.
  const genreKey = (g) => {
    const k = g.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return k === "sciencefiction" ? "scifi" : k;
  };
  const genreGroups = new Map();
  for (const g of genres) genreGroups.set(genreKey(g), [...(genreGroups.get(genreKey(g)) || []), g]);
  const chips = el("div", { class: "filter-bar", style: { flexWrap: "wrap" } });
  const paint = () => {
    chips.innerHTML = "";
    for (const [key, variants] of genreGroups) {
      const on = variants.some((g) => liked.has(g));
      chips.append(el("button", {
        class: `chip focusable ${on ? "on" : ""}`,
        "aria-pressed": String(on),
        onclick: () => {
          for (const g of variants) on ? liked.delete(g) : liked.add(g);
          paint();
          save();
        },
      }, key === "scifi" ? "Sci-Fi" : variants[0]));
    }
  };

  // Sections are self-contained cards laid out on a grid — two columns on a
  // big screen (elia: "we have space on the right, use it"), one on phones.
  const section = (title, note, ...content) =>
    el("div", { class: "pref-section" },
      el("h2", { class: "row-title pref-head", style: { padding: 0 } }, iconFor(title.replace(/^What's new.*/, "What's new")), el("span", {}, title)),
      note && el("p", { class: "pref-note", style: { padding: 0 } }, note),
      ...content);

  // A row that goes somewhere (or does one thing) — the same shape as a
  // setting's row, with a chevron where a setting has its control.
  const linkRow = (label, note, onClick) =>
    el("button", { "data-ui": "settings.link", class: "pref-item pref-link focusable", onclick: onClick },
      iconFor(label),
      el("div", { class: "pref-item-text" },
        el("div", { class: "pref-item-label" }, label),
        note && el("div", { class: "pref-item-note" }, note)),
      el("span", { class: "pref-link-chev", "aria-hidden": "true" }, "›"));
  const pickPhoto = () => {
    const pick = el("input", { type: "file", accept: "image/jpeg,image/png,image/webp" });
    pick.onchange = async () => {
      const file = pick.files && pick.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) return toast("2MB max — pick a smaller image", "⚠️");
      try {
        const r = await api.uploadAvatar(state.profile.id, file);
        state.profile = { ...state.profile, ...r.profile };
        toast("Looking sharp", "📷");
        rerenderInPlace(); // repaint the screen + nav chip
      } catch (e) {
        toast(e.message || "Upload failed", "⚠️");
      }
    };
    pick.click();
  };
  // Who you are, then what you can do about it — as rows, like every other
  // setting (it was a wall of mismatched pills; elia: "let's organize all
  // this", 2026-10-06).
  // A kids profile's settings leave out what a child shouldn't change: the
  // password and sign-in, what Aurora downloads by itself, and the kids
  // setting (it sits folded in the edit sheet, behind the household PIN).
  const kid = state.profile.kids || null;
  const profileSection = section("Your profile", null,
    el("div", { class: "pref-profile page-pad" },
      el("div", { class: "big-avatar small", style: { background: state.profile.color } },
        state.profile.avatarImage
          ? el("img", { class: "avatar-photo", src: state.profile.avatarImage, alt: "" })
          : state.profile.avatar),
      el("div", { class: "pref-profile-who" },
        el("div", { class: "pref-profile-name" }, state.profile.name),
        el("div", { class: "pref-profile-sub" },
          kid
            ? [el("span", { class: "kids-badge" }, "Kids"), ` ${kidsLabel(kid)}`]
            : state.profile.hasPassword ? "Password protected" : "No password set")),
    ),
    el("div", { class: "pref-list page-pad" },
      linkRow(kid ? "Edit profile" : "Edit profile & password", kid ? "Name, avatar and colour." : "Name, avatar, colour, your password — and kids mode.",
        () => profileModal(state.profile, async () => { await loadProfiles(); rerenderInPlace(); })),
      linkRow(state.profile.avatarImage ? "Change photo" : "Upload a photo", "A picture of you in place of the emoji — JPEG, PNG or WebP, up to 2 MB.", pickPhoto),
      state.profile.avatarImage && linkRow("Remove photo", "Back to the emoji.", async () => {
        try {
          const r = await api.removeAvatar(state.profile.id);
          state.profile = { ...state.profile, ...r.profile };
          toast("Back to the emoji");
          rerenderInPlace();
        } catch { toast("Couldn't remove it", "⚠️"); }
      }),
      linkRow("Your Aurora Wrapped", "Your year in numbers, with a few roasts.", () => navigate("#/wrapped")),
      linkRow("Swipe your taste", "Love it, not for me, or haven't seen — one title at a time. Home learns from every answer.", () => navigate("#/taste")),
    ),
  );

  // ---------- account (sign-in) section — only when the server runs accounts ----------
  const accountSection = async () => {
    const u = state.user;
    const body = el("div", { class: "pref-list page-pad" });

    // devices signed in to this account, with per-session revoke
    const devices = el("div", { class: "account-devices" });
    const paintDevices = async () => {
      devices.innerHTML = "";
      let rows = [];
      try { rows = (await api.accountSessions()).sessions || []; } catch { return; }
      const ago = (t) => {
        const m = Math.floor((Date.now() - t) / 60000);
        if (m < 2) return "just now";
        if (m < 60) return `${m} min ago`;
        if (m < 48 * 60) return `${Math.floor(m / 60)}h ago`;
        return `${Math.floor(m / 1440)} days ago`;
      };
      // device arrives as {browser, os, device} (realtime.parseDevice)
      const deviceLabel = (d) =>
        d && typeof d === "object"
          ? [d.device, d.browser, d.os].filter((x) => x && x !== "Other").join(" · ") || "Unknown device"
          : d || "Unknown device";
      for (const s of rows) {
        devices.append(el("div", { class: "account-device" },
          el("div", { style: { flex: "1" } },
            el("div", {}, `${deviceLabel(s.device)}${s.current ? " — this one" : ""}`),
            el("div", { class: "pref-note", style: { padding: 0, margin: 0 } }, `last seen ${ago(s.lastSeenAt)}`)),
          !s.current && el("button", {
            class: "btn small focusable",
            onclick: async () => {
              try { await api.revokeSession(s.key); paintDevices(); toast("Signed that device out"); }
              catch { toast("Couldn't sign it out", "⚠️"); }
            },
          }, "Revoke"),
        ));
      }
    };
    paintDevices();

    // One-time completions only — once an email exists it's edited in the
    // profile modal (with the password), and once Google is linked it's just
    // a checkmark. No standing "change X" buttons cluttering the card.
    const addEmail = async () => {
      const val = await promptSheet({
        title: "Add an email",
        text: "You can sign in with it instead of your username.",
        placeholder: "you@example.com",
        type: "email",
        icon: "✉️",
      });
      if (!val) return;
      try {
        const r = await api.setProfileEmail(state.profile.id, val.trim());
        state.user = r.user || state.user;
        toast("Email saved", "✉️");
        rerender();
      } catch (e) {
        toast(e.message || "Couldn't save that", "⚠️");
      }
    };

    const connectGoogle = async () => {
      let info = null;
      try { info = await api.serverInfo(); } catch {}
      const { googleFlavor, googleWebFlow } = await import("../google.js");
      const flavor = googleFlavor(info);
      if (flavor === "web") {
        try {
          const r = await googleWebFlow("link");
          if (r.linked) {
            state.user = r.user || state.user;
            toast("Google connected", "✅");
            rerender();
          }
        } catch (e) {
          toast(e.message || "Couldn't connect Google", "🙃");
        }
        return;
      }
      if (flavor !== "device") return toast("Google sign-in isn't configured on this server", "🙃");
      // device-code fallback (reached the server by IP): tiny code modal
      let start;
      try { start = await api.googleStart(); } catch (e) {
        return toast(e.message || "Couldn't reach Google", "🙃");
      }
      let closed = false;
      const backdrop = el("div", { class: "modal-backdrop ui-overlay" },
        el("div", { class: "modal", style: { textAlign: "center" } },
          el("h2", {}, "Connect Google"),
          el("p", { class: "pref-note" }, `On your phone, open ${start.verificationUrl.replace(/^https?:\/\//, "")} and enter:`),
          el("div", { style: { fontSize: "1.7rem", fontWeight: "900", letterSpacing: "0.2em", margin: "10px 0" } }, start.userCode),
          el("button", { class: "btn focusable", onclick: () => { closed = true; backdrop.remove(); } }, "Cancel")));
      document.body.append(backdrop);
      const poll = async () => {
        if (closed || !backdrop.isConnected) return;
        try {
          const r = await api.googlePoll(start.pollId);
          if (r.ok && r.linkable) {
            const l = await api.googleLink(start.pollId);
            state.user = l.user || state.user;
            backdrop.remove();
            toast("Google connected", "✅");
            rerender();
            return;
          }
          if (r.ok) { backdrop.remove(); return toast("That Google account signed in elsewhere — try again", "🙃"); }
        } catch (e) {
          backdrop.remove();
          return toast(e.message || "Google linking failed", "🙃");
        }
        setTimeout(poll, 3000);
      };
      setTimeout(poll, 3000);
    };

    let googleAvailable = false;
    try { googleAvailable = !!(await api.serverInfo()).google; } catch {}

    body.append(
      el("div", { class: "pref-note", style: { padding: 0 } },
        `Signed in as `, el("strong", {}, `@${u.username || u.name}`),
        u.name && u.name !== u.username ? ` (${u.name})` : "",
        u.email ? el("span", {}, ` · ${u.email}`) : "",
        u.hasGoogle ? el("span", {}, " · Google ✅") : ""),
      (!u.email || (googleAvailable && !u.hasGoogle)) &&
        el("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap", margin: "10px 0 4px" } },
          !u.email && el("button", { class: "btn small focusable", onclick: addEmail }, "✉️ Add email"),
          googleAvailable && !u.hasGoogle &&
            el("button", { class: "btn small focusable", onclick: connectGoogle }, "Connect Google")),
      el("div", { class: "pref-note", style: { padding: 0, margin: "8px 0 4px", fontSize: "0.82rem" } },
        "Password and email changes live in “Edit profile & password” above — one password opens everything."),
      devices,
      el("div", { style: { marginTop: "14px", display: "flex", gap: "10px", flexWrap: "wrap" } },
        el("button", {
          class: "btn focusable",
          onclick: async () => {
            try {
              const r = await api.signOutEverywhere(state.profile.id, state.clientId);
              // every unlock token of the profile just ended, this tab's too:
              // the fresh one goes on the very next request (it used to be
              // stored for the next reload only — a profile with a password
              // and no sign-in was refused everything until then)
              if (r.token) { state.token = r.token; setAuthToken(r.token); try { sessionStorage.setItem(`aurora-token-${state.profile.id}`, r.token); } catch {} }
              paintDevices();
              toast(r.ended ? `Signed out ${r.ended} other device${r.ended === 1 ? "" : "s"}` : "Every other device is signed out", "🔒");
            } catch (e) {
              toast(e.message || "Couldn't do that", "⚠️");
            }
          },
        }, "Sign out everywhere else"),
        el("button", {
          class: "btn danger focusable",
          // one sign-out for the whole app (main.js): it also takes this
          // browser's notifications off the profile
          onclick: () => document.dispatchEvent(new CustomEvent("aurora-sign-out")),
        }, "Sign out")),
    );
    return body;
  };

  // The Account card has three states: signed in (manage sessions), an
  // unclaimed migrated account (claim it), or claimed-but-signed-out on this
  // device (sign in). Hidden entirely while authMode is "open".
  const rerender = () => rerenderInPlace();
  const accountCard = async () => {
    if (state.authMode === "open") return null;
    if (state.user) {
      return section("Sign-in", "This profile's sign-in — sessions last 90 days per device.",
        await accountSection());
    }
    let claimable = null;
    try { claimable = (await api.claimable(state.profile.id)).claimable; } catch {}
    const body = el("div", { class: "pref-list page-pad" });
    if (claimable) {
      body.append(
        el("div", { class: "pref-note", style: { padding: 0 } },
          `This profile hasn't switched sign-in on yet. Pick your username once`,
          claimable.hasPassword ? ` (your profile password stays your password)` : ` and a password`,
          ` — and every device signs in as you.`),
        el("div", { style: { marginTop: "12px" } },
          el("button", {
            class: "btn btn-primary small focusable",
            onclick: () => showClaimModal(claimable, rerender),
          }, "🔑 Set up my sign-in")));
    } else {
      body.append(
        el("div", { class: "pref-note", style: { padding: 0 } },
          "You're not signed in on this device."),
        el("div", { style: { marginTop: "12px" } },
          el("button", {
            class: "btn btn-primary small focusable",
            onclick: async () => {
              const r = await showLoginScreen({ skippable: state.authMode !== "closed" });
              if (r && r.user) {
                state.user = r.user; // the card repaints from this
                rerender();
              }
            },
          }, "Sign in")));
    }
    return section("Sign-in", "Your profile IS your account — one password for everything.", body);
  };

  // What's new: the latest release's notes and the version, from
  // CHANGELOG.md via /api/changelog. Opening this page marks the version
  // seen, which clears the dot on the nav's gear (main.js).
  const whatsNew = async () => {
    let data = null;
    try { data = await api.changelog(); } catch {}
    if (!data) return null;
    try { localStorage.setItem("aurora-seen-version", data.version); } catch {}
    window.dispatchEvent(new Event("aurora-version-seen"));
    const releases = data.releases || [];
    const latest = releases[0];
    // The changelog is written with **bold** leads and `code`: shown as such,
    // built from text nodes (never innerHTML) — it used to print the asterisks.
    const rich = (t) => {
      const out = [];
      const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
      let at = 0;
      let m;
      while ((m = re.exec(t))) {
        if (m.index > at) out.push(t.slice(at, m.index));
        out.push(m[1] != null ? el("b", {}, m[1]) : el("code", {}, m[2]));
        at = re.lastIndex;
      }
      if (at < t.length) out.push(t.slice(at));
      return out;
    };
    const list = (r) =>
      el("ul", { class: "changelog" }, (r.items || []).map((t) => el("li", {}, ...rich(String(t)))));
    const older = el("div", { class: "hidden" },
      releases.slice(1).map((r) =>
        el("div", { class: "changelog-release" },
          el("div", { class: "changelog-head" }, `${r.version}${r.date ? ` · ${r.date}` : ""}`),
          list(r))));
    const more = releases.length > 1 && el("button", {
      class: "btn small focusable",
      style: { marginTop: "8px" },
      onclick: () => { older.classList.toggle("hidden"); more.textContent = older.classList.contains("hidden") ? "Show older" : "Hide older"; },
    }, "Show older");
    return section(`What's new`, `Aurora ${data.version}${latest && latest.date ? ` · ${latest.date}` : ""}`,
      el("div", { class: "page-pad" },
        latest ? list(latest) : el("p", { class: "pref-note" }, "No notes yet."),
        more || null,
        older));
  };

  // The fold for the less-used sections. Open or shut is remembered per device.
  const MORE_KEY = "aurora-prefs-more";
  const moreSettings = (...sections) => {
    let open = false;
    try { open = localStorage.getItem(MORE_KEY) === "1"; } catch {}
    const grid = el("div", { class: "pref-grid" }, ...sections.filter(Boolean));
    const chev = el("span", { class: "pref-more-chev" }, "›");
    const btn = el("button", { class: "pref-more-toggle focusable", "aria-expanded": String(open) },
      el("span", { class: "pref-icon", html: svg('<circle cx="5" cy="12" r="1.500"/><circle cx="12" cy="12" r="1.500"/><circle cx="19" cy="12" r="1.500"/>') }),
      el("span", { class: "pref-more-text" },
        el("b", {}, "More settings"),
        el("small", {}, "Home rows, recommendations, downloads, the TV, internet, saving for later, privacy, sign-in, what's new")),
      chev);
    const wrap = el("div", { class: "pref-more" + (open ? " open" : "") }, btn, grid);
    btn.onclick = () => {
      open = !open;
      wrap.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
      try { localStorage.setItem(MORE_KEY, open ? "1" : "0"); } catch {}
    };
    return wrap;
  };

  paint();
  screen.append(
    el("div", { class: "browse-head" },
      el("h1", {}, "Settings"),
      el("span", { class: "count" }, `for ${state.profile.name}`)
    ),
    el("div", { class: "pref-grid" },
      profileSection,
      section("Appearance", "Colours and look — just for your profile.",
        appearanceSection()),
      section("Watching", null,
        el("div", { class: "pref-list page-pad" },
          prefRow(
            "Trailers on the home page",
            "The big picture on Home plays its trailer, without sound.",
            () => (playerPrefs.get("heroTrailers", !(matchMedia("(pointer: coarse)").matches && innerWidth < 900)) ? "On" : "Off"),
            () => playerPrefs.set("heroTrailers", !playerPrefs.get("heroTrailers", !(matchMedia("(pointer: coarse)").matches && innerWidth < 900)))
          ),
          prefRow(
            "Play the next episode",
            "When an episode ends, the next one starts by itself.",
            () => (playerPrefs.get("autoplayNext", true) ? "On" : "Off"),
            () => {
              // follows the profile to every device (state.js setPersonPref)
              const on = !playerPrefs.get("autoplayNext", true);
              playerPrefs.set("autoplayNext", on);
              setPersonPref("autoplayNext", on);
            }
          )
        )),
      section("Subtitles", null,
        el("div", { class: "pref-list page-pad" },
          prefRow(
            "Subtitles on by themselves",
            "When a title has subtitles, they switch on.",
            () => (playerPrefs.get("subsDefault", true) ? "On" : "Off"),
            () => {
              const on = !playerPrefs.get("subsDefault", true);
              playerPrefs.set("subsDefault", on);
              setPersonPref("subsDefault", on);
            }
          ),
          prefRow(
            "Subtitle language",
            "The language to pick. If a title doesn't have it, Aurora goes and gets it.",
            () => ({ any: "First available", he: "Hebrew", en: "English", ru: "Russian" }[playerPrefs.get("subLang", "any")] || "First available"),
            () => {
              cycle("subLang", ["any", "he", "en", "ru"], "any");
              // The choice follows the profile to every device — and when a
              // title lacks the language, the player fetches it by itself.
              const subLang = playerPrefs.get("subLang", "any");
              state.profile.prefs = { ...(state.profile.prefs || {}), subLang };
              api.updateProfile(state.profile.id, { prefs: { subLang } }).catch(() => {});
            }
          ),
          // [player-options] the look, the person's — the same six on the TV
          ...subtitleLookRows()
        )),
      // [player-options] the sound, the person's — the same two on the TV
      section("Sound", "Follows you to the TV and every browser.",
        el("div", { class: "pref-list page-pad" }, ...soundRows())),
      section("Genres you like", "Pick what you like — Home shows more of it.",
        genres.length
          ? chips
          : el("div", { class: "empty-note" }, "No genres yet — they turn up once the library finishes reading itself.")),
    ),
    // Everything else is still here, one press away: the first screen is the
    // handful of settings anyone might want (elia: "my little sister also
    // needs to understand this"), the rest sits under More settings.
    moreSettings(
      section("Your home page", "Change the order of the rows on Home, or hide some. The TV follows too.",
        await homeRowsSection()),
      section("Recommendations", "What the people of your household recommend to you. The TV follows too.",
        await householdSection(linkRow)),
      !kid && section("Downloads", "What Aurora fetches for you while you watch.",
        el("div", { class: "pref-list page-pad" },
          prefRow(
            "Tell me when it's ready",
            "A notification when something you saved has finished, even if Aurora is in the background.",
            () => {
              let on = false;
              try { on = localStorage.getItem("aurora-notify-ready") === "1"; } catch {}
              return on && "Notification" in window && Notification.permission === "granted" ? "On" : "Off";
            },
            async () => {
              let on = false;
              try { on = localStorage.getItem("aurora-notify-ready") === "1"; } catch {}
              if (on && "Notification" in window && Notification.permission === "granted") {
                try { localStorage.setItem("aurora-notify-ready", "0"); } catch {}
                push.disable();
                return;
              }
              // Web Push where the browser has it: the notification arrives
              // with Aurora closed. An iPhone needs Aurora on the Home Screen
              // first, and says so.
              if (push.supported() || push.needsInstall()) {
                try {
                  await push.enable();
                  try { localStorage.setItem("aurora-notify-ready", "1"); } catch {}
                  toast("Notifications are on for this device", "🔔");
                } catch (e) {
                  toast(e.message || "Couldn't switch notifications on", "⚠️");
                }
                return;
              }
              if (!("Notification" in window)) return toast("This browser can't show notifications", "⚠️");
              const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission().catch(() => "denied");
              if (p !== "granted") return toast("Notifications are blocked for Aurora in this browser's settings", "⚠️");
              try { localStorage.setItem("aurora-notify-ready", "1"); } catch {}
            }
          ),
          prefRow(
            "Get the next episode ready",
            "While you watch, Aurora fetches the next episode so it starts at once.",
            () => ((state.profile.prefs || {}).smartDownloads === false ? "Off" : "On"),
            async () => {
              const next = (state.profile.prefs || {}).smartDownloads === false;
              state.profile.prefs = { ...(state.profile.prefs || {}), smartDownloads: next };
              try {
                await api.updateProfile(state.profile.id, { prefs: { smartDownloads: next } });
              } catch (e) {
                state.profile.prefs = { ...(state.profile.prefs || {}), smartDownloads: !next };
                toast(e.message || "Couldn't save that", "⚠️");
              }
            }
          ),
          prefRow(
            "Tidy up after watching",
            "Episodes Aurora fetched for you are removed once you've watched them. Nothing you saved yourself is touched.",
            () => ((state.profile.prefs || {}).smartCleanup === false ? "Off" : "On"),
            async () => {
              const next = (state.profile.prefs || {}).smartCleanup === false;
              state.profile.prefs = { ...(state.profile.prefs || {}), smartCleanup: next };
              try {
                await api.updateProfile(state.profile.id, { prefs: { smartCleanup: next } });
              } catch (e) {
                state.profile.prefs = { ...(state.profile.prefs || {}), smartCleanup: !next };
                toast(e.message || "Couldn't save that", "⚠️");
              }
            }
          )
        )),
      // ---- On the TV (TV round 2026-10-19): picture and sound settings the
      // TV app applies. They follow the person (the profile's prefs, the same
      // keys the TV's Settings → Picture and sound writes); a browser can do
      // neither, and the section says so.
      section("On the TV", "The Aurora TV app does these. A browser can't switch your screen's refresh rate or send Dolby and DTS sound to a receiver as it is — here you choose what your TVs do.",
        el("div", { class: "pref-list page-pad" },
          prefRow(
            "Match frame rate",
            "While a film plays, the screen switches to the film's own frame rate (24, 25, 50, 60…), so slow pans don't judder. The screen goes dark for a second when it switches.",
            () => ((state.profile.prefs || {}).matchFrameRate === "off" ? "Off" : "Auto"),
            () => tvPref("matchFrameRate", (state.profile.prefs || {}).matchFrameRate === "off" ? "auto" : "off"),
            { steps: true }
          ),
          prefRow(
            "Surround sound",
            "Auto: Dolby and DTS sound goes to the TV or soundbar as it is, when they take it — 5.1 and Atmos included. Stereo only: every film plays in plain stereo.",
            () => ((state.profile.prefs || {}).surround === "stereo" ? "Stereo only" : "Auto"),
            () => tvPref("surround", (state.profile.prefs || {}).surround === "stereo" ? "auto" : "stereo"),
            { steps: true }
          )
        )),
      // ---- end On the TV
      section("Internet",
        (() => {
          const n = netInfo();
          const now = n.tier === "slow" ? "slow" : n.tier === "fast" ? "fast" : "fine";
          // a LAN measures in the hundreds of Mbit/s — "over 100" says enough
          const speed = n.kbps == null ? "" : n.kbps >= 100000 ? " (over 100 Mbit/s from the server)"
            : ` (about ${n.kbps >= 1000 ? (n.kbps / 1000).toFixed(1) + " Mbit/s" : n.kbps + " kbit/s"} from the server)`;
          return n.mode === "saver" ? "Data saver is on: smaller pictures and a lighter video, always."
            : n.mode === "full" ? "Full quality is on: Aurora never goes lighter on this device."
            : `Your connection looks ${now}${speed}. When it is slow, Aurora uses smaller pictures and a lighter video by itself.`;
        })(),
        el("div", { class: "pref-list page-pad" },
          prefRow(
            "Internet use",
            "Automatic is best. Data saver uses less internet — good on mobile data.",
            () => ({ auto: "Automatic", saver: "Data saver", full: "Full quality" }[dataMode()]),
            () => {
              const order = ["auto", "saver", "full"];
              setDataMode(order[(order.indexOf(dataMode()) + 1) % order.length]);
              setTimeout(rerenderInPlace, 0); // the note above says which mode is on
            }
          )
        )),
      section("Watch without internet",
        window.isSecureContext && "serviceWorker" in navigator
          ? "Press 📱 on a title in the library to keep a copy on this device. Find your copies under Saved."
          : `Saving for later only works on a secure (https) address. This device opened Aurora on ${location.protocol.replace(":", "")}://${location.host}, so the 📱 buttons are hidden here.`,
        el("div", { class: "pref-list page-pad" },
          prefRow(
            "Size of saved copies",
            "Ask lets you pick each time. Original looks best; smaller sizes take less space.",
            () => ({ ask: "Ask each time", original: "Original", 1080: "1080p", 720: "720p", 480: "480p" }[offlineStore.preferredQuality()] || "Ask each time"),
            () => {
              const order = ["ask", "original", "1080", "720", "480"];
              offlineStore.setPreferredQuality(order[(order.indexOf(offlineStore.preferredQuality()) + 1) % order.length]);
            }
          ),
          prefRow(
            "Saved on this device",
            "Everything you saved to watch with no internet.",
            () => (window.isSecureContext && "serviceWorker" in navigator ? "Open" : "Unavailable"),
            () => { if (window.isSecureContext && "serviceWorker" in navigator) navigate("#/saved"); }
          )
        )),
      // [phone-remote] this device and the phone as a remote (js/remote.js)
      section("Phone as a remote", remote.targetAllowed()
        ? "Your phone can control your TVs — and this device, under this name."
        : "This phone can control your TVs: open Remote while Aurora is on one.",
        el("div", { class: "pref-list page-pad" },
          remote.targetAllowed() && prefRow(
            "This device's name",
            "What your phone calls this device in its list.",
            () => remote.deviceName(),
            async () => {
              const v = await promptSheet({ title: "This device's name", text: "Your phone lists this device under this name.", value: remote.deviceName(), placeholder: remote.defaultDeviceName(), ok: "Save" });
              if (v) remote.setDeviceName(v);
            }
          ),
          remote.targetAllowed() && prefRow(
            "Let my other devices play here",
            "Your phone can start titles on this device and control them.",
            () => (remote.targetEnabled() ? "On" : "Off"),
            () => remote.setTargetEnabled(!remote.targetEnabled())
          ),
          linkRow("Remote", "Control a TV that has Aurora open", () => navigate("#/remote"))
        )),
      // [/phone-remote]
      section("Privacy", "Nothing leaves this server.",
        el("div", { class: "pref-list page-pad" },
          prefRow(
            "Help improve Aurora",
            "Shares which screens and buttons you use. Never what you search or type.",
            () => ((state.profile.prefs || {}).usageStats === false ? "Off" : "On"),
            async () => {
              const next = (state.profile.prefs || {}).usageStats === false; // off → on
              state.profile.prefs = { ...(state.profile.prefs || {}), usageStats: next };
              try {
                await api.updateProfile(state.profile.id, { prefs: { usageStats: next } });
              } catch (e) {
                state.profile.prefs = { ...(state.profile.prefs || {}), usageStats: !next };
                toast(e.message || "Couldn't save that", "⚠️");
              }
            }
          ))),
      kid ? null : await accountCard(),
      await whatsNew(),
    ),
    el("div", { class: "detail-actions", style: { padding: "8px var(--page-x) 26px" } },
      el("button", { "data-ui": "settings.done", class: "btn btn-primary focusable", html: "<span>Done</span>", onclick: () => navigate("#/") })
    ),
  );
  if (keepY) restoreScrollY(keepY);
};
