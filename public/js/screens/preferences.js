// Preferences: your profile (name/avatar/password), playback + subtitle
// defaults, and the liked genres used to tailor Home recommendations.
// Reopenable anytime from the nav gear.
import { el, toast } from "../ui.js";
import { loadLibrary, loadProfiles, state } from "../state.js";
import { api } from "../api.js";
import { navigate } from "../router.js";
import { profileModal } from "./profiles.js";
import { playerPrefs, applyCueStyle } from "./player.js";

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

  screen.append(
    el("div", { class: "browse-head" },
      el("h1", {}, "Preferences"),
      el("span", { class: "count" }, `for ${state.profile.name}`)
    ),
    // Your profile — the only place to edit your profile / set a password
    el("h2", { class: "row-title", style: { marginTop: "8px" } }, "Your profile"),
    el("div", { class: "pref-profile page-pad" },
      el("div", { class: "big-avatar small", style: { background: state.profile.color } }, state.profile.avatar),
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
    // ---- Playback ----
    el("h2", { class: "row-title", style: { marginTop: "18px" } }, "Playback"),
    el("div", { class: "pref-list page-pad" },
      prefRow(
        "Autoplay next episode",
        "Start the next episode automatically when one finishes.",
        () => (playerPrefs.get("autoplayNext", true) ? "On" : "Off"),
        () => playerPrefs.set("autoplayNext", !playerPrefs.get("autoplayNext", true))
      )
    ),

    // ---- Subtitles ----
    el("h2", { class: "row-title", style: { marginTop: "18px" } }, "Subtitles"),
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
    ),

    el("h2", { class: "row-title", style: { marginTop: "18px" } }, "Genres you like"),
    el("p", { class: "pref-note" }, "We use these — plus your watch history and star ratings — to pick what shows up on Home."),
  );

  if (genres.length === 0) {
    screen.append(el("div", { class: "empty" }, "No genres yet — they turn up once the library finishes reading itself."));
  } else {
    paint();
    screen.append(chips,
      el("div", { class: "detail-actions", style: { padding: "20px var(--page-x)" } },
        el("button", { class: "btn btn-primary focusable", html: "<span>Done</span>", onclick: () => navigate("#/") })
      )
    );
  }
};
