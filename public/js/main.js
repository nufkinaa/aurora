// Aurora boot: profile gate -> router -> screens.
import "./focus.js";
import { $, el } from "./ui.js";
import { route, startRouter, navigate } from "./router.js";
import { state, loadProfiles, setProfile, savedToken } from "./state.js";
import { api, setAuthToken } from "./api.js";
import { connect, onMessage } from "./ws.js";
import { renderHome } from "./screens/home.js";
import { renderMovies, renderShows, renderMyList } from "./screens/browse.js";
import { renderSearch } from "./screens/search.js";
import { renderDetail } from "./screens/discover-detail.js";
import { renderPlayer } from "./screens/player.js";
import { renderRequests } from "./screens/requests.js";
import { renderPreferences } from "./screens/preferences.js";
import { renderWrapped } from "./screens/wrapped.js";
import { renderTaste } from "./screens/taste.js";
import { renderPickForMe } from "./screens/pickforme.js";
import { showProfileGate } from "./screens/profiles.js";
import { showLoginScreen } from "./screens/login.js";
import { showClaimModal } from "./claim.js";
import { showShortcutsOverlay } from "./screens/shortcuts.js";
import { initAurora } from "./aurora.js";
import { initScreensaver } from "./screensaver.js";

route("/", renderHome);
route("/movies", renderMovies);
route("/shows", renderShows);
route("/list", renderMyList);
route("/search", renderSearch);
// One detail page for everything — a title looks the same whether it is on
// disk, streamable, or both (see screens/discover-detail.js).
route("/movie/:id", (root, p) => renderDetail(root, { source: "library", type: "movie", id: p.id }));
route("/show/:id", (root, p) => renderDetail(root, { source: "library", type: "show", id: p.id }));
route("/play/:id", renderPlayer);
route("/requests", renderRequests); // no longer in nav; kept for deep links
route("/discover/:type/:id", (root, p) => renderDetail(root, { source: "discover", type: p.type, id: p.id }));
route("/preferences", renderPreferences);
route("/wrapped", renderWrapped);
route("/taste", renderTaste);
route("/pick", renderPickForMe);

// "?" anywhere opens the keyboard shortcuts overlay
document.addEventListener("keydown", (e) => {
  if (e.key === "?" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || "")) {
    showShortcutsOverlay();
  }
});

const paintProfileChip = () => {
  if (!state.profile) return;
  const a = $("#nav-avatar");
  if (state.profile.avatarImage) {
    a.textContent = "";
    a.style.background = `url("${state.profile.avatarImage}") center/cover`;
  } else {
    a.textContent = state.profile.avatar;
    a.style.background = state.profile.color;
  }
  $("#nav-profile-name").textContent = state.profile.name;
};

// Nav turns solid once scrolled past the hero's top edge. The initial state
// runs through the same rule — it used to force .solid at boot, which kept
// the chrome (and now the aurora's absence) wrong until the first scroll.
const paintNavSolid = () =>
  $("#nav").classList.toggle("solid", (window.scrollY || document.body.scrollTop || 0) > 24);
window.addEventListener("scroll", paintNavSolid, { passive: true });
window.addEventListener("hashchange", () => setTimeout(paintNavSolid, 0));
paintNavSolid();
// The chip repaints on navigation too — profile edits (avatar photo, name)
// land in state.profile and this keeps the nav honest without a plumbing
// event. It's two DOM writes; free.
window.addEventListener("hashchange", () => setTimeout(paintProfileChip, 0));
initAurora($("#nav-aurora")); // the aurora in the nav's empty stretch
initScreensaver(); // idle-on-home backdrop slideshow (any input wakes)

// Live download pill: after requesting a download and leaving the page there
// was zero feedback until you wandered back. One global subscription feeds a
// tiny "⬇ 2 · 47%" in the nav; hidden whenever nothing is moving.
{
  const pill = $("#nav-dl");
  const ACTIVE = ["pending", "approved", "downloading"];
  const jobs = new Map();
  const paint = () => {
    const act = [...jobs.values()].filter((j) => ACTIVE.includes(j.status));
    if (act.length === 0) return pill.classList.add("hidden");
    const pct = Math.round(
      (act.reduce((s, j) => s + (j.progress || 0), 0) / act.length) * 100,
    );
    pill.textContent = `⬇ ${act.length} · ${pct}%`;
    pill.classList.remove("hidden");
  };
  api.downloads()
    .then((res) => {
      // the route answers a bare array
      for (const j of Array.isArray(res) ? res : res.downloads || []) jobs.set(j.id, j);
      paint();
    })
    .catch(() => {});
  onMessage("download_update", ({ job }) => {
    if (!job) return;
    jobs.set(job.id, job);
    paint();
  });
}

// On narrow screens the nav is a swipeable strip. Fade the clipped edge so
// it's visible that more items exist, and nudge it once so the swipe is
// discoverable without knowing.
{
  const nav = $("#nav");
  const paintEdges = () => {
    nav.classList.toggle("clip-right", nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 4);
    nav.classList.toggle("clip-left", nav.scrollLeft > 4);
  };
  nav.addEventListener("scroll", paintEdges, { passive: true });
  window.addEventListener("resize", paintEdges);
  paintEdges();

  // One-time peek: scroll a little and back so the strip visibly moves
  if (nav.scrollWidth > nav.clientWidth && !localStorage.getItem("aurora-nav-hinted")) {
    localStorage.setItem("aurora-nav-hinted", "1");
    setTimeout(() => {
      nav.scrollTo({ left: 90, behavior: "smooth" });
      setTimeout(() => nav.scrollTo({ left: 0, behavior: "smooth" }), 650);
    }, 900);
  }
}

// Back behaves like a TV app: leave sub-pages toward home, never exit blindly.
// Overlays (player, game stage, modals, profile gate) own Back themselves -
// they carry .ui-overlay, and this handler registered first can't rely on
// their preventDefault, so it checks the DOM instead.
document.addEventListener("ui-back", (e) => {
  const hash = location.hash || "#/";
  if (hash.startsWith("#/play/")) return; // the player owns Back
  if (document.querySelector(".ui-overlay")) return;
  e.preventDefault();
  if (hash === "#/" || hash === "") return;
  if (history.length > 1) history.back();
  else navigate("#/");
});

// The profile chip opens a small menu (elia: "fix that whole segment") —
// switch profile where the wall exists, preferences, and a proper red
// sign-out when signed in. In closed mode there is no wall to switch on,
// so the menu is the whole story.
const openGate = () => {
  // Opened over the running app — dismissable, unlike the boot gate.
  showProfileGate(() => {
    paintProfileChip();
    navigate("#/");
    // force re-render if already home
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, { dismissable: true });
};

const showProfileMenu = () => {
  document.querySelector(".nav-menu-wrap")?.remove(); // toggle: second click closes
  const item = (label, onclick, cls = "") =>
    el("button", { class: `nav-menu-item focusable ${cls}`, onclick }, label);
  const menu = el("div", { class: "nav-menu" },
    el("div", { class: "nav-menu-head" },
      el("div", { class: "nav-menu-name" }, state.profile?.name || "Aurora"),
      state.user && el("div", { class: "nav-menu-sub" }, `@${state.user.username || state.user.name}`)),
    state.authMode !== "closed" &&
      item("Switch profile", () => { close(); openGate(); }),
    item("Preferences", () => { close(); navigate("#/preferences"); }),
    state.user &&
      item("Sign out", async () => {
        close();
        try { await api.logout(); } catch {}
        // out means out: forget the device's shortcuts back in
        try {
          localStorage.removeItem("aurora-profile");
          if (state.profile) sessionStorage.removeItem(`aurora-token-${state.profile.id}`);
        } catch {}
        location.reload();
      }, "danger"),
  );
  const wrap = el("div", { class: "nav-menu-wrap ui-overlay", onclick: (e) => e.target === wrap && close() }, menu);
  const close = () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("ui-back", onBack);
    wrap.remove();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const onBack = (e) => { e.preventDefault(); close(); };
  document.addEventListener("keydown", onKey);
  document.addEventListener("ui-back", onBack);
  document.body.append(wrap);
  setTimeout(() => menu.querySelector("button")?.focus({ preventScroll: true }), 40);
};

$("#nav-profile").addEventListener("click", () => {
  // Before any profile is active (shouldn't happen — the gate covers boot),
  // fall through to the wall rather than a menu about nothing.
  if (!state.profile) return openGate();
  showProfileMenu();
});

const boot = async () => {
  connect();

  // Sign-in comes before the profile wall ONLY when the wall is closed.
  // "open" boots exactly as always; "transition" also boots normally — the
  // one-time claim step appears at the profile door instead (the wall, and
  // the auto-entry path below), so the household migrates at its own pace.
  // A throw here (older server without /api/me) is treated as open.
  // ACCOUNT = PROFILE: a successful login hands back the profile AND an
  // unlock token (login verified the very same password), so we walk
  // straight in — no wall, no second password prompt.
  let loginEntry = null;
  try {
    const me = await api.me();
    state.authMode = me.authMode || "open";
    state.user = me.user || null;
    if (state.authMode === "closed" && !state.user) {
      const res = await showLoginScreen();
      state.user = (res && res.user) || null;
      if (res && res.profile) loginEntry = res;
    }
  } catch {}

  try {
    await loadProfiles();
  } catch {
    document.getElementById("app").append(
      el("div", { class: "empty", style: { paddingTop: "30vh" } },
        el("div", { class: "glyph" }, "📡"),
        "Can't reach the Aurora server."
      )
    );
    return;
  }

  const start = () => {
    paintProfileChip();
    startRouter(document.getElementById("app"));
  };

  // Transition-mode migration must also reach devices that AUTO-enter a
  // remembered profile (they never touch the wall, so the wall's claim step
  // would never fire for them). Same one-time modal, same rules; cancelling
  // drops back to the wall. setProfile has already run here, so the profile
  // token is attached for the claimable check.
  const claimGateThenStart = async (p) => {
    if (state.authMode === "transition" && !state.user) {
      let claimable = null;
      try { claimable = (await api.claimable(p.id)).claimable; } catch {}
      if (claimable) {
        showClaimModal(claimable, () => start(), {
          required: true,
          profileId: p.id,
          onCancel: () => showProfileGate(start),
        });
        return;
      }
    }
    start();
  };

  // Fresh login on a closed wall: enter the signed-in profile directly.
  if (loginEntry) {
    await setProfile(loginEntry.profile, loginEntry.profileToken || null);
    start();
    return;
  }

  // Enter a profile without the gate when we safely can: password-free ones
  // freely, protected ones if this browser session still holds a valid
  // unlock token (survives reloads, not a browser restart) — or, new with
  // sign-in, if the SIGNED-IN account is this profile: the session was
  // minted by the same password, so it converts to an unlock token.
  const enterProtectedWithToken = async (p) => {
    const tok = savedToken(p.id);
    if (tok) {
      setAuthToken(tok);
      try {
        await api.profileState(p.id); // 200 = token still valid
        await setProfile(p, tok);
        await claimGateThenStart(p);
        return true;
      } catch {
        setAuthToken(null);
      }
    }
    if (state.user && state.user.profileId === p.id) {
      try {
        const r = await api.sessionProfileToken();
        if (r.token && r.profileId === p.id) {
          await setProfile(p, r.token);
          start(); // signed in — nothing left to claim
          return true;
        }
      } catch {}
    }
    return false;
  };

  // Admin-locked profiles never auto-enter — back to the gate, where the tile
  // shows as locked.
  const p = state.profile || (state.profiles.length === 1 ? state.profiles[0] : null);
  if (p && p.locked) {
    showProfileGate(start);
  } else if (p && !p.hasPassword) {
    await setProfile(p);
    await claimGateThenStart(p);
  } else if (p && p.hasPassword && (await enterProtectedWithToken(p))) {
    // entered via saved session token
  } else {
    showProfileGate(start);
  }
};

boot();

// The AI tab only exists when the server has an AI key configured.
// Failure here is silent by design: no key, no tab, nothing else changes.
api
  .aiStatus()
  .then((s) => {
    if (s && s.enabled) document.getElementById("nav-pick")?.classList.remove("hidden");
  })
  .catch(() => {});
