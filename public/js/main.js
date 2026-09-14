// Aurora boot: profile gate -> router -> screens.
import "./focus.js";
import { $, el, toast } from "./ui.js";
import { route, startRouter, navigate } from "./router.js";
import { state, loadProfiles, setProfile, savedToken, downloads, readyDownloads } from "./state.js";
import { api, setAuthToken } from "./api.js";
import { connect, onMessage } from "./ws.js";
import { renderHome } from "./screens/home.js";
import { renderMovies, renderShows, renderMyList } from "./screens/browse.js";
import { renderSearch } from "./screens/search.js";
import { renderRequests } from "./screens/requests.js";
import { renderWrapped } from "./screens/wrapped.js";
import { renderTaste } from "./screens/taste.js";
import { renderPickForMe } from "./screens/pickforme.js";
import { renderWhatsNew, paintNewDot } from "./screens/whatsnew.js";
import { showProfileGate } from "./screens/profiles.js";
import { showLoginScreen } from "./screens/login.js";
import { showClaimModal } from "./claim.js";
import { showShortcutsOverlay } from "./screens/shortcuts.js";
import { showReportSheet } from "./report.js";
import { pushScope, popScope } from "./focus.js";
import { initAurora } from "./aurora.js";
import { initScreensaver } from "./screensaver.js";

// The three heaviest screens — player (94 KB), the unified detail page
// (65 KB) and preferences (which statically pulls player.js in for the
// subtitle prefs) — load on first navigation instead of at boot, the same
// shape as pair.js below. Safe because the router AWAITS handlers
// (router.js:59), so the resolved cleanup function still reaches
// current.cleanup; they're also warmed right after boot (see the idle
// callback at the bottom) so a real click never waits on the network.
const renderDetailLazy = (root, opts) =>
  import("./screens/discover-detail.js").then((m) => m.renderDetail(root, opts));

route("/", renderHome);
route("/movies", renderMovies);
route("/shows", renderShows);
route("/list", renderMyList);
route("/search", renderSearch);
// One detail page for everything — a title looks the same whether it is on
// disk, streamable, or both (see screens/discover-detail.js).
route("/movie/:id", (root, p) => renderDetailLazy(root, { source: "library", type: "movie", id: p.id }));
route("/show/:id", (root, p) => renderDetailLazy(root, { source: "library", type: "show", id: p.id }));
route("/play/:id", (root, p) => import("./screens/player.js").then((m) => m.renderPlayer(root, p)));
route("/requests", renderRequests); // no longer in nav; kept for deep links
route("/downloads", (root, p) => import("./screens/downloads.js").then((m) => m.renderDownloads(root, p)));
// Join a watch party by code: look the party up, hand its item to the
// player (a torrent play-item travels with the party; a library id is
// enough on its own), and open the player in party mode.
route("/saved", (root, p) => import("./screens/saved.js").then((m) => m.renderSaved(root, p)));
route("/party/:code", async (root, p) => {
  const code = String(p.code || "").toUpperCase();
  let party = null;
  try { party = await api.party(code); } catch {}
  if (!party || !party.item) {
    toast("No party with that code", "👥");
    return navigate("#/");
  }
  if (String(party.item.id).startsWith("torrent|")) state.pendingItems[party.item.id] = party.item;
  navigate(`#/play/${encodeURIComponent(party.item.id)}?party=${code}`);
});
// `#/discover/series/tt123?s=2&e=5` opens season 2 with episode 5's sources
// showing — where Up next lands for a streamed show.
route("/discover/:type/:id", (root, p) => {
  const [id, q = ""] = String(p.id).split("?");
  const qs = new URLSearchParams(q);
  const s = parseInt(qs.get("s") || "", 10);
  const e = parseInt(qs.get("e") || "", 10);
  return renderDetailLazy(root, { source: "discover", type: p.type, id, jump: s > 0 && e > 0 ? { season: s, episode: e } : null });
});
route("/preferences", (root, p) => import("./screens/preferences.js").then((m) => m.renderPreferences(root, p)));
route("/wrapped", renderWrapped);
route("/taste", renderTaste);
route("/pick", renderPickForMe);
route("/new", renderWhatsNew);
route("/pair/:code", (root, p) => import("./screens/pair.js").then((m) => m.renderPair(root, p)));

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

// The glass look's sky: the sign-in aurora, slowed, behind every page. Started
// when the look is glass and torn down when it isn't — the classic look never
// pays for a full-viewport canvas it doesn't show.
{
  let stopSky = null;
  const syncSky = () => {
    const glass = document.documentElement.dataset.look === "glass";
    if (glass && !stopSky) {
      import("./aurora-sky.js").then((m) => {
        if (document.documentElement.dataset.look !== "glass" || stopSky) return;
        stopSky = m.initAuroraSky($("#glass-sky"), { pace: 0.95 });
      });
    } else if (!glass && stopSky) {
      stopSky();
      stopSky = null;
    }
  };
  syncSky();
  window.addEventListener("aurora-look", syncSky);
}
initScreensaver(); // idle-on-home backdrop slideshow (any input wakes)

// Toasts ride into (and out of) the fullscreen element: anything outside
// the top layer never paints while the player is fullscreen.
{
  const toasts = $("#toasts");
  const home = toasts && toasts.parentElement;
  document.addEventListener("fullscreenchange", () => {
    if (!toasts) return;
    (document.fullscreenElement || home).append(toasts);
  });
}

// First desktop visit: one quiet hint that "?" lists the keyboard shortcuts.
// A mouse-and-keyboard device only (phones and TVs have no "?" to press).
{
  const desktop = matchMedia("(pointer: fine)").matches && !("ontouchstart" in window) && innerWidth > 900;
  let seen = true;
  try { seen = !!localStorage.getItem("aurora-kbd-hint"); } catch {}
  if (desktop && !seen) {
    // Not over a wall (profile gate, sign-in, the look note): wait it out.
    const tryHint = (left) => setTimeout(() => {
      if (document.querySelector(".profiles-gate, .login-card, .look-notice, .peek-wrap")) {
        if (left > 0) tryHint(left - 1);
        return;
      }
      try { localStorage.setItem("aurora-kbd-hint", "1"); } catch {}
      toast("Press ? any time for the keyboard shortcuts", "⌨️", { label: "Show me", onClick: showShortcutsOverlay });
    }, 6000);
    tryHint(10);
  }
}

// Live download pill: after requesting a download and leaving the page there
// was zero feedback until you wandered back. One global subscription feeds a
// tiny "⬇ 2 · 47%" in the nav while something is moving — and once YOUR
// download has landed, a green "✓ 1 ready" that stays until you open the
// title (the player and the downloads page clear it), so a finished
// download is never something you find out about by wandering back.
{
  const pill = $("#nav-dl");
  const ACTIVE = ["pending", "approved", "downloading"];
  const paint = () => {
    const ready = readyDownloads();
    if (ready.length > 0) {
      pill.textContent = `✓ ${ready.length} ready`;
      pill.title = ready.length === 1 ? `“${ready[0].label || ready[0].title}” is ready to play` : `${ready.length} downloads ready to play`;
      pill.classList.add("ready");
      return pill.classList.remove("hidden");
    }
    pill.classList.remove("ready");
    pill.title = "Downloads in progress";
    const act = [...downloads.values()].filter((j) => ACTIVE.includes(j.status));
    if (act.length === 0) return pill.classList.add("hidden");
    const pct = Math.round(
      (act.reduce((s, j) => s + (j.progress || 0), 0) / act.length) * 100,
    );
    pill.textContent = `⬇ ${act.length} · ${pct}%`;
    pill.classList.remove("hidden");
  };
  // "mine" is decided server-side per profile, so the list is (re)fetched
  // for whoever is signed in — at boot, and again when the profile changes.
  let fetchedFor = undefined; // never "the null profile" — boot must fetch too
  const load = () => {
    const pid = state.profile ? state.profile.id : null;
    if (pid === fetchedFor) return;
    fetchedFor = pid;
    api.downloads(pid)
      .then((res) => {
        // the route answers a bare array
        for (const j of Array.isArray(res) ? res : res.downloads || []) downloads.set(j.id, j);
        paint();
      })
      .catch(() => { fetchedFor = null; });
  };
  load();
  onMessage("server_notice", ({ message }) => { if (message) toast(message, "🛠️"); });
  onMessage("download_update", ({ job }) => {
    if (!job) return;
    // A smart download appearing for the first time is the one download the
    // viewer never asked for — say so once, so the new row on the Downloads
    // page isn't a mystery (and so they know the feature is doing its job).
    if (!downloads.has(job.id) && job.mine && job.smart) {
      const ep = job.season && job.episode ? ` S${job.season}E${job.episode}` : "";
      let first = false;
      try { first = !localStorage.getItem("aurora-smartdl-explained"); localStorage.setItem("aurora-smartdl-explained", "1"); } catch {}
      const cancel = {
        label: "Cancel",
        onClick: () => api.downloadCancel(job.id, state.profile.id).then(() => toast("Cancelled — it won't queue this one again", "🗑")).catch(() => {}),
      };
      toast(
        first
          ? `Smart downloads: you're two-thirds through, so the next episode (${job.title || job.label}${ep}) is downloading to the server. Turn it off under Preferences → Playback.`
          : `Next up is downloading: ${job.title || job.label}${ep} · smart downloads`,
        "⬇",
        cancel,
      );
    }
    downloads.set(job.id, job);
    paint();
  });
  window.addEventListener("hashchange", () => setTimeout(() => { load(); paint(); }, 0));
}

// Offline copies: the worker that serves the app and saved titles with no
// server in reach, the "Saved" nav entry (shown once something is saved,
// or whenever the server is unreachable), and the flush of progress made
// offline the moment the server is back.
{
  import("./offline.js").then((offline) => {
    offline.registerWorker();
    const nav = $("#nav-saved");
    const paint = async () => {
      let any = false;
      try { any = (await offline.listSaved()).length > 0; } catch {}
      // Only where offline copies can exist at all (https / localhost) —
      // over plain http the entry would lead to a screen that says no.
      nav.classList.toggle("hidden", !offline.available() || !(any || !navigator.onLine || !state.ws));
    };
    paint();
    window.addEventListener("hashchange", () => setTimeout(paint, 0));
    window.addEventListener("offline", paint);
    window.addEventListener("online", () => { paint(); offline.flushProgress().catch(() => {}); });
    // the socket coming back is the surest "server is there" signal
    onMessage("welcome", () => { offline.flushProgress().catch(() => {}); paint(); });
  }).catch(() => {});
}

// First entry after the redesign: one small note, once per profile (the
// flag rides the profile, so every device sees it exactly once), saying the
// look can be switched under Preferences. Nothing else is asked of them.
{
  const showLookNotice = () => {
    const p = state.profile;
    if (!p || p.lookNoticeSeen || document.querySelector(".look-notice")) return;
    const seen = () => {
      p.lookNoticeSeen = true;
      const save = (left) =>
        api.updateProfile(p.id, { lookNoticeSeen: true }).catch(() => {
          if (left > 0) setTimeout(() => save(left - 1), 4000); // quietly, a few times
        });
      save(3);
    };
    const close = () => {
      document.removeEventListener("ui-back", onBack);
      wrap.classList.add("leaving");
      setTimeout(() => wrap.remove(), 260);
      seen();
    };
    const onBack = (e) => { e.preventDefault(); close(); };
    const card = el("div", { class: "look-notice" },
      el("div", { class: "look-notice-glyph" }),
      el("div", { class: "look-notice-title" }, "Aurora has a new look"),
      el("p", { class: "look-notice-text" },
        "Glass over a living sky, a Tonight row with what's ready for you, and a cleaner player. ",
        "The Legacy look is still here — switch between the two any time under Preferences → Appearance → Look."),
      el("div", { class: "look-notice-actions" },
        el("button", { class: "btn focusable", onclick: () => { close(); navigate("#/preferences"); } }, "Open Preferences"),
        el("button", { class: "btn btn-primary focusable", onclick: close }, "Got it")));
    const wrap = el("div", { class: "look-notice-wrap ui-overlay", onclick: (e) => e.target === wrap && close() }, card);
    document.addEventListener("ui-back", onBack);
    document.body.append(wrap);
    setTimeout(() => card.querySelector(".btn-primary")?.focus({ preventScroll: true }), 60);
  };
  // after the profile is in and the first screen has painted
  window.addEventListener("aurora-profile", () => setTimeout(showLookNotice, 900));
}

// A dot on the gear while there's a release the person hasn't read about
// (Preferences → What's new marks it seen). One fetch at boot; the server
// answers from a parsed-once cache.
{
  const gear = $(".nav-gear");
  let version = null;
  const paint = () => {
    let seen = null;
    try { seen = localStorage.getItem("aurora-seen-version"); } catch {}
    gear.classList.toggle("has-new", !!version && seen !== version);
  };
  api.changelog().then((d) => { version = d && d.version; paint(); }).catch(() => {});
  window.addEventListener("aurora-version-seen", paint);
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
// "Join a watch party": a four-letter code from whoever started one.
document.addEventListener("aurora-join-party", () => showJoinParty());
const showJoinParty = () => {
  const input = el("input", {
    class: "focusable party-code-input",
    type: "text",
    maxlength: "4",
    placeholder: "CODE",
    autocapitalize: "characters",
    autocomplete: "off",
    "aria-label": "Party code",
  });
  const go = () => {
    const code = input.value.trim().toUpperCase();
    if (code.length < 4) return toast("Codes are four characters", "👥");
    close();
    navigate(`#/party/${code}`);
  };
  const box = el("div", { class: "look-notice sheet party-join", role: "dialog", "aria-label": "Join a watch party" },
    el("div", { class: "sheet-icon" }, "👥"),
    el("div", { class: "look-notice-title" }, "Join a watch party"),
    el("p", { class: "look-notice-text" }, "The code is on the host's screen — press 👥 in their player to see it."),
    input,
    el("div", { class: "look-notice-actions" },
      el("button", { class: "btn focusable", onclick: () => close() }, "Cancel"),
      el("button", { class: "btn btn-primary focusable", onclick: go }, "Join")));
  const wrap = el("div", { class: "look-notice-wrap ui-overlay", onclick: (e) => e.target === wrap && close() }, box);
  const close = () => {
    document.removeEventListener("ui-back", onBack);
    popScope(wrap);
    wrap.classList.add("leaving");
    setTimeout(() => wrap.remove(), 220);
  };
  const onBack = (e) => { e.preventDefault(); close(); };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  input.addEventListener("input", () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
  document.addEventListener("ui-back", onBack);
  document.body.append(wrap);
  pushScope(wrap);
  setTimeout(() => input.focus({ preventScroll: true }), 40);
};

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
    item("My downloads", () => { close(); navigate("#/downloads"); }),
    item("What's new", () => { close(); navigate("#/new"); }),
    item("Report a problem", () => { close(); showReportSheet(); }),
    item("Join a watch party", () => { close(); showJoinParty(); }),
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

// Warm the lazy screens once the browser goes idle: boot's critical path is
// long done by then, and the module cache means the later route hit is
// instant — same UX as when these were eager, minus their cost at boot.
(window.requestIdleCallback || ((fn) => setTimeout(fn, 2500)))(() => {
  import("./screens/player.js").catch(() => {});
  import("./screens/discover-detail.js").catch(() => {});
  import("./screens/preferences.js").catch(() => {});
});

// The AI tab only exists when the server has an AI key configured.
// Failure here is silent by design: no key, no tab, nothing else changes.
api
  .aiStatus()
  .then((s) => {
    if (s && s.enabled) document.getElementById("nav-pick")?.classList.remove("hidden");
  })
  .catch(() => {});
// The "New" tab's dot: lit until this version's page has been seen.
paintNewDot();
