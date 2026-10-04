// Preferences: your profile (name/avatar/password), playback + subtitle
// defaults, and the liked genres used to tailor Home recommendations.
// Reopenable anytime from the nav gear.
import { el, toast, rerenderInPlace, keptScrollFor, restoreScrollY, promptSheet } from "../ui.js";
import { loadLibrary, loadProfiles, state, applyAppearance } from "../state.js";
import { api } from "../api.js";
import { navigate } from "../router.js";
import { profileModal } from "./profiles.js";
import { playerPrefs, applyCueStyle } from "./player.js";
import { showClaimModal } from "../claim.js";
import { showLoginScreen } from "./login.js";
import * as offlineStore from "../offline.js";
import { dataMode, setDataMode, netInfo } from "../net.js";

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
  "Watch without internet": '<rect x="6" y="2.500" width="12" height="19" rx="2.500"/><path d="M12 8v6M9.500 12l2.500 2.500 2.500-2.500"/>',
  "Subtitles": '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 14h4M14 14h3M7 10.500h2M12 10.500h5"/>',
  "Privacy": '<path d="M12 3l8 3v6c0 4.500-3.200 8-8 9-4.800-1-8-4.500-8-9V6z"/>',
  "Genres you like": '<path d="M12 20s-7-4.300-7-9.500A4 4 0 0112 8a4 4 0 017 2.500C19 15.700 12 20 12 20z"/>',
  // settings
  "Trailers on the home page": '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v14M16 5v14M3 10h5M3 14h5M16 10h5M16 14h5"/>',
  "Play the next episode": '<path d="M5 5v14l10-7z"/><path d="M19 5v14"/>',
  "Get the next episode ready": '<path d="M12 4v11"/><path d="M7.500 11l4.500 4.500 4.500-4.500"/><path d="M5 20h14"/>',
  "Tidy up after watching": '<path d="M4 7h16M9 7V4.500h6V7M6.500 7l1 13h9l1-13"/>',
  "Internet use": '<path d="M5 20v-4M10 20v-8M15 20V8M20 20V4"/>',
  "Size of saved copies": '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  "Saved on this device": '<rect x="6" y="2.500" width="12" height="19" rx="2.500"/><path d="M10.500 18h3"/>',
  "Subtitles on by themselves": '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 14h4M14 14h3"/>',
  "Subtitle language": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.500 3 14.500 0 18M12 3c-3 3.500-3 14.500 0 18"/>',
  "Subtitle size": '<path d="M3 18l4.500-11L12 18M4.500 14.500h6"/><path d="M14 18l3-7 3 7M15 16h4"/>',
  "Dark box behind subtitles": '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h10"/>',
  "Help improve Aurora": '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
};
const iconFor = (name) => (ICONS[name] ? el("span", { class: "pref-icon", html: svg(ICONS[name]) }) : null);

// A setting: icon, name, one short line, and its control. Two-state settings
// (On / Off) are a switch; anything with more choices is a button that steps
// through them.
const prefRow = (label, note, valueText, onCycle) => {
  const isSwitch = () => valueText() === "On" || valueText() === "Off";
  const value = el("span", {}, valueText());
  const control = el("button", {
    class: "btn small focusable pref-item-value",
    onclick: async () => { await onCycle(); paint(); },
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

const cycle = (key, values, fallback) => {
  const cur = playerPrefs.get(key, fallback);
  const i = values.indexOf(cur);
  playerPrefs.set(key, values[(i + 1) % values.length]);
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
      lookRow.append(el("button", {
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
      themeRow.append(el("button", {
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
      accentRow.append(el("button", {
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
};
const rowName = (id, title) => title || ROW_NAMES[id] || (id.startsWith("liked-") ? "More " + id.slice(6) : id);

const CHEV_UP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>';
const CHEV_DOWN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

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
          el("button", {
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

  const chips = el("div", { class: "filter-bar", style: { flexWrap: "wrap" } });
  const paint = () => {
    chips.innerHTML = "";
    genres.forEach((g) =>
      chips.append(el("button", {
        class: `chip focusable ${liked.has(g) ? "on" : ""}`,
        onclick: () => {
          liked.has(g) ? liked.delete(g) : liked.add(g);
          paint();
          save();
        },
      }, g))
    );
  };

  // Sections are self-contained cards laid out on a grid — two columns on a
  // big screen (elia: "we have space on the right, use it"), one on phones.
  const section = (title, note, ...content) =>
    el("div", { class: "pref-section" },
      el("h2", { class: "row-title pref-head", style: { padding: 0 } }, iconFor(title.replace(/^What's new.*/, "What's new")), el("span", {}, title)),
      note && el("p", { class: "pref-note", style: { padding: 0 } }, note),
      ...content);

  const profileSection = section("Your profile", null,
    el("div", { class: "pref-profile page-pad" },
      el("div", { class: "big-avatar small", style: { background: state.profile.color } },
        state.profile.avatarImage
          ? el("img", { class: "avatar-photo", src: state.profile.avatarImage, alt: "" })
          : state.profile.avatar),
      el("div", { style: { flex: "1" } },
        el("div", { class: "pref-profile-name" }, state.profile.name),
        el("div", { class: "pref-note", style: { padding: 0, margin: "2px 0 0" } },
          state.profile.hasPassword ? "🔒 Password protected" : "No password set")
      ),
      el("button", {
        class: "btn focusable",
        html: "<span>Edit profile & password</span>",
        onclick: () => profileModal(state.profile, async () => { await loadProfiles(); rerenderInPlace(); }),
      })
    ),
    // Custom avatar photo: uploaded, validated + re-encoded server-side.
    el("div", { class: "page-pad", style: { display: "flex", gap: "10px", marginTop: "8px", flexWrap: "wrap" } },
      el("button", {
        class: "btn small focusable",
        html: "<span>📷 Upload a photo</span>",
        onclick: () => {
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
        },
      }),
      state.profile.avatarImage && el("button", {
        class: "btn small focusable",
        html: "<span>Remove photo</span>",
        onclick: async () => {
          try {
            const r = await api.removeAvatar(state.profile.id);
            state.profile = { ...state.profile, ...r.profile };
            toast("Back to the emoji");
            rerenderInPlace();
          } catch { toast("Couldn't remove it", "⚠️"); }
        },
      }),
    ),
    el("div", { class: "page-pad", style: { marginTop: "6px", display: "flex", gap: "10px", flexWrap: "wrap" } },
      el("button", {
        class: "btn small focusable",
        html: "<span>🌌 Your Aurora Wrapped — stats & roasts</span>",
        onclick: () => navigate("#/wrapped"),
      }),
      el("button", {
        class: "btn small focusable",
        html: "<span>🎯 Pick titles you love</span>",
        onclick: () => navigate("#/taste"),
      })),
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
      el("div", { style: { marginTop: "14px" } },
        el("button", {
          class: "btn danger focusable",
          onclick: async () => {
            try { await api.logout(); } catch {}
            try {
              localStorage.removeItem("aurora-profile");
              sessionStorage.removeItem(`aurora-token-${state.profile.id}`);
            } catch {}
            location.reload();
          },
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
    const list = (r) =>
      el("ul", { class: "changelog" }, (r.items || []).map((t) => el("li", {}, t)));
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
        el("small", {}, "Home rows, downloads, internet, saving for later, privacy, sign-in, what's new")),
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
            () => playerPrefs.set("autoplayNext", !playerPrefs.get("autoplayNext", true))
          )
        )),
      section("Subtitles", null,
        el("div", { class: "pref-list page-pad" },
          prefRow(
            "Subtitles on by themselves",
            "When a title has subtitles, they switch on.",
            () => (playerPrefs.get("subsDefault", true) ? "On" : "Off"),
            () => playerPrefs.set("subsDefault", !playerPrefs.get("subsDefault", true))
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
          prefRow(
            "Subtitle size",
            null,
            () => ({ S: "Small", M: "Medium", L: "Large" }[playerPrefs.get("cueSize", "M")] || "Medium"),
            () => { cycle("cueSize", ["S", "M", "L"], "M"); applyCueStyle(); }
          ),
          prefRow(
            "Dark box behind subtitles",
            "Easier to read on bright scenes.",
            () => (playerPrefs.get("cueBackground", true) ? "On" : "Off"),
            () => { playerPrefs.set("cueBackground", !playerPrefs.get("cueBackground", true)); applyCueStyle(); }
          )
        )),
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
      section("Downloads", "What Aurora fetches for you while you watch.",
        el("div", { class: "pref-list page-pad" },
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
      await accountCard(),
      await whatsNew(),
    ),
    el("div", { class: "detail-actions", style: { padding: "8px var(--page-x) 26px" } },
      el("button", { class: "btn btn-primary focusable", html: "<span>Done</span>", onclick: () => navigate("#/") })
    ),
  );
  if (keepY) restoreScrollY(keepY);
};
