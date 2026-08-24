// Preferences: your profile (name/avatar/password), playback + subtitle
// defaults, and the liked genres used to tailor Home recommendations.
// Reopenable anytime from the nav gear.
import { el, toast } from "../ui.js";
import { loadLibrary, loadProfiles, state, applyAppearance } from "../state.js";
import { api } from "../api.js";
import { navigate } from "../router.js";
import { profileModal } from "./profiles.js";
import { playerPrefs, applyCueStyle } from "./player.js";
import { showClaimModal } from "../claim.js";
import { showLoginScreen } from "./login.js";

// One settings row: label + explanation on the left, a button cycling the value
// on the right. Every row here drives behaviour that already exists in the
// player — these settings used to be reachable only from the gear menu while
// something was playing, which is a poor place to find "subtitles on by
// default".
const prefRow = (label, note, valueText, onCycle) => {
  const value = el("span", {}, valueText());
  return el("div", { class: "pref-item" },
    el("div", { class: "pref-item-text" },
      el("div", { class: "pref-item-label" }, label),
      note && el("div", { class: "pref-item-note" }, note)
    ),
    el("button", {
      class: "btn small focusable pref-item-value",
      onclick: () => { onCycle(); value.textContent = valueText(); },
    }, value)
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
  const themeRow = el("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap" } });
  const accentRow = el("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" } });
  const paint = () => {
    const curTheme = state.profile.theme || "aurora";
    const curAccent = state.profile.accent || null;
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
  host.append(themeRow, accentRow);
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
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        } catch { toast("Couldn't reset", "⚠️"); }
      },
    }));
  return wrap;
};

export const renderPreferences = async (root) => {
  const screen = el("div", { class: "screen" });
  root.append(screen);

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
      el("h2", { class: "row-title", style: { padding: 0 } }, title),
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
        onclick: () => profileModal(state.profile, async () => { await loadProfiles(); navigate("#/preferences"); window.dispatchEvent(new HashChangeEvent("hashchange")); }),
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
              window.dispatchEvent(new HashChangeEvent("hashchange")); // repaint the screen + nav chip
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
            window.dispatchEvent(new HashChangeEvent("hashchange"));
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
      const val = prompt("Email for this profile (you can sign in with it too):", "");
      if (!val || !val.trim()) return;
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
  const rerender = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
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

  paint();
  screen.append(
    el("div", { class: "browse-head" },
      el("h1", {}, "Preferences"),
      el("span", { class: "count" }, `for ${state.profile.name}`)
    ),
    el("div", { class: "pref-grid" },
      profileSection,
      await accountCard(),
      section("Appearance", "Yours alone — follows this profile to every device.",
        appearanceSection()),
      section("Your home page", "Reorder or hide the rows on Home. New kinds of rows appear at the end. The TV follows this order too.",
        await homeRowsSection()),
      section("Playback", null,
        el("div", { class: "pref-list page-pad" },
          prefRow(
            "Autoplay next episode",
            "Start the next episode automatically when one finishes.",
            () => (playerPrefs.get("autoplayNext", true) ? "On" : "Off"),
            () => playerPrefs.set("autoplayNext", !playerPrefs.get("autoplayNext", true))
          )
        )),
      section("Subtitles", null,
        el("div", { class: "pref-list page-pad" },
          prefRow(
            "Turn subtitles on automatically",
            "When a title offers subtitles, switch one on without asking.",
            () => (playerPrefs.get("subsDefault", true) ? "On" : "Off"),
            () => playerPrefs.set("subsDefault", !playerPrefs.get("subsDefault", true))
          ),
          prefRow(
            "Preferred subtitle language",
            "Which one to pick when a title offers several. Falls back to the first available.",
            () => ({ any: "First available", he: "Hebrew", en: "English" }[playerPrefs.get("subLang", "any")] || "First available"),
            () => cycle("subLang", ["any", "he", "en"], "any")
          ),
          prefRow(
            "Subtitle size",
            null,
            () => ({ S: "Small", M: "Medium", L: "Large" }[playerPrefs.get("cueSize", "M")] || "Medium"),
            () => { cycle("cueSize", ["S", "M", "L"], "M"); applyCueStyle(); }
          ),
          prefRow(
            "Subtitle background",
            "A dark box behind the text — easier to read on bright scenes.",
            () => (playerPrefs.get("cueBackground", true) ? "On" : "Off"),
            () => { playerPrefs.set("cueBackground", !playerPrefs.get("cueBackground", true)); applyCueStyle(); }
          )
        )),
      section("Genres you like", "We use these — plus your watch history and star ratings — to pick what shows up on Home.",
        genres.length
          ? chips
          : el("div", { class: "empty-note" }, "No genres yet — they turn up once the library finishes reading itself.")),
    ),
    el("div", { class: "detail-actions", style: { padding: "8px var(--page-x) 26px" } },
      el("button", { class: "btn btn-primary focusable", html: "<span>Done</span>", onclick: () => navigate("#/") })
    ),
  );
};
