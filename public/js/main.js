// Aurora boot: profile gate -> router -> screens.
import "./focus.js";
// Device tier for the glass look (glass.css, data-fx): a genuinely weak
// device — two cores, 2 GB, or data saver on — gets no live blur. Set before
// anything paints, so there is no frosted first frame.
try {
  const n = navigator;
  const lite = (n.deviceMemory && n.deviceMemory <= 2) || (n.hardwareConcurrency && n.hardwareConcurrency <= 2) || !!(n.connection && n.connection.saveData);
  document.documentElement.dataset.fx = lite ? "lite" : "full";
} catch {}
import { $, el, toast, icons } from "./ui.js";
import { route, startRouter, navigate } from "./router.js";
import { state, loadProfiles, setProfile, savedToken, downloads, readyDownloads, refreshPersonPrefs } from "./state.js";
import { api, setAuthToken, forgetWarm } from "./api.js";
import { connect, reconnect, onMessage, emit } from "./ws.js";
import { appRunning, onSigninRequired, onSignedOut } from "./session.js";
import { showResetWall, resetWallUp } from "./resetwall.js";
import { renderHome } from "./screens/home.js";
import { showProfileGate } from "./screens/profiles.js";
import { showLoginScreen } from "./screens/login.js";
import { showClaimModal } from "./claim.js";
import { showShortcutsOverlay } from "./screens/shortcuts.js";
import { showReportSheet } from "./report.js";
import { pushScope, popScope } from "./focus.js";
import { initAurora } from "./aurora.js";
import { initScreensaver } from "./screensaver.js";
import { initPrefetch } from "./prefetch.js";
import { track } from "./usage.js";
import { watchArrivals } from "./recommend.js";
import "./telemetry.js"; // [analytics] error reports, timings, control counts — behind the same switch
import { onNet, netInfo } from "./net.js";

// "The first screen is done": it has painted and the pictures in view have
// arrived (or enough time has passed that waiting longer helps nobody). Work
// that is for LATER — the other screens' code, the offline worker and its
// copy of the app — hangs off this instead of off "the browser is idle",
// so it never competes with what the person is looking at for the line or
// for the processor.
const whenIdle = () => new Promise((resolve) =>
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(() => resolve(), { timeout: 2000 }));
const firstScreen = new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; whenIdle().then(resolve); } };
  const picturesIn = () => {
    for (const img of document.images) {
      if (img.complete) continue;
      const r = img.getBoundingClientRect();
      if (r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) return false;
    }
    return true;
  };
  window.addEventListener("aurora-route", () => {
    // (a slow line gets longer: there the pictures are what the line is for)
    const giveUpAt = performance.now() + (document.documentElement.dataset.net === "slow" ? 12000 : 6000);
    const look = () => {
      if (done) return;
      if (picturesIn() || performance.now() > giveUpAt) return finish();
      setTimeout(look, 300);
    };
    setTimeout(look, 300);
  }, { once: true });
  // No screen at all yet — the profile door or the sign-in page is up, and
  // may stay up: the rest is warmed behind it, as it always was.
  setTimeout(() => { if (!done && !document.querySelector("#app .screen")) finish(); }, 4000);
  setTimeout(finish, 30000);
});

// Only what boot needs is imported statically: home, the profile door, the
// sign-in screen and the shared chrome. Every other screen loads on first
// navigation, the same shape as pair.js below — the player (150 KB), the
// unified detail page, preferences, and now the browse pages, search,
// requests, Wrapped, taste, the AI tab and the New page too (another ~70 KB
// a cold phone load was parsing before it could paint the door). Safe
// because the router AWAITS handlers (router.js), so the resolved cleanup
// function still reaches current.cleanup; they're all warmed right after
// boot (see the idle callback at the bottom) so a real click never waits
// on the network.
const renderDetailLazy = (root, opts) =>
  import("./screens/discover-detail.js").then((m) => m.renderDetail(root, opts));
// A page that is still on its way (the screen's code, then its first data)
// shows its outline instead of an empty dark page (2026-10-07): a heading bar
// and a grid of cards, shimmering. Gone the moment the screen has painted.
const routeSkeleton = () => {
  const d = document.createElement("div");
  d.className = "route-skel";
  d.setAttribute("aria-hidden", "true");
  d.innerHTML = '<div class="skeleton route-skel-head"></div><div class="route-skel-grid">' + '<div class="skeleton grid-skel"></div>'.repeat(12) + "</div>";
  return d;
};
const withSkeleton = (run) => (root, p) => {
  const sk = routeSkeleton();
  // only if the wait is long enough to notice — a flash of skeleton is worse than none
  const t = setTimeout(() => { if (!root.querySelector(".screen")) root.append(sk); }, 140);
  const done = () => { clearTimeout(t); sk.remove(); };
  let out;
  try { out = run(root, p); } catch (e) { done(); throw e; }
  const mo = new MutationObserver(() => { if (root.querySelector(".screen")) { done(); mo.disconnect(); } });
  mo.observe(root, { childList: true });
  Promise.resolve(out).then(() => { done(); mo.disconnect(); }, () => { done(); mo.disconnect(); });
  return out;
};
const lazy = (file, name) => withSkeleton((root, p) => import(file).then((m) => m[name](root, p)));

route("/", renderHome);
route("/movies", lazy("./screens/browse.js", "renderMovies"));
route("/shows", lazy("./screens/browse.js", "renderShows"));
route("/list", lazy("./screens/browse.js", "renderMyList"));
route("/search", lazy("./screens/search.js", "renderSearch"));
// a search someone else started for you (a cast member's card in X-Ray)
route("/search/:q", (root, p) => import("./screens/search.js").then((m) => {
  m.presetSearch(p.q);
  history.replaceState(null, "", "#/search"); // Back returns to plain Search
  return m.renderSearch(root);
}));
// One detail page for everything — a title looks the same whether it is on
// disk, streamable, or both (see screens/discover-detail.js).
route("/movie/:id", (root, p) => renderDetailLazy(root, { source: "library", type: "movie", id: p.id }));
route("/show/:id", (root, p) => renderDetailLazy(root, { source: "library", type: "show", id: p.id }));
route("/play/:id", (root, p) => import("./screens/player.js").then((m) => m.renderPlayer(root, p)));
route("/requests", lazy("./screens/requests.js", "renderRequests")); // no longer in nav; kept for deep links
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
route("/wrapped", lazy("./screens/wrapped.js", "renderWrapped"));
route("/taste", lazy("./screens/taste.js", "renderTaste"));
route("/taste/list", lazy("./screens/taste.js", "renderTasteList"));
route("/pick", lazy("./screens/pickforme.js", "renderPickForMe"));
route("/new", lazy("./screens/whatsnew.js", "renderWhatsNew"));
route("/household", lazy("./screens/household.js", "renderHousehold")); // "Show all recommended" (js/recommend.js)
route("/household/sent", withSkeleton((root) => import("./screens/household.js").then((m) => m.renderHousehold(root, { tab: "sent" })))); // …on its "You sent" tab
route("/pair/:code", (root, p) => import("./screens/pair.js").then((m) => m.renderPair(root, p)));
// no code in the address ({host}/link, typed by hand off the TV): the code field
route("/pair", (root) => import("./screens/pair.js").then((m) => m.renderPair(root, {})));
// [phone-remote] the remote (screens/remote.js): this phone driving a TV
route("/remote", (root, p) => import("./screens/remote.js").then((m) => m.renderRemote(root, p)));
route("/remote/:id", (root, p) => import("./screens/remote.js").then((m) => m.renderRemote(root, p)));
// [/phone-remote]

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
// It starts once the browser is idle, not during boot: on a throttled phone
// the painter was the single biggest main-thread cost of the first seconds
// (Lighthouse: ~1.2s of a 2.4s total), holding back the first paint of the
// door it sits behind. The canvas fades in (CSS .on) instead of popping.
{
  let stopSky = null;
  const syncSky = () => {
    const glass = document.documentElement.dataset.look === "glass";
    if (glass && !stopSky) {
      import("./aurora-sky.js").then((m) => {
        if (document.documentElement.dataset.look !== "glass" || stopSky) return;
        const canvas = $("#glass-sky");
        stopSky = m.initAuroraSky(canvas, { pace: 0.95 });
        canvas.classList.add("on"); // the CSS fade covers the first frame's arrival
      });
    } else if (!glass && stopSky) {
      stopSky();
      stopSky = null;
      $("#glass-sky").classList.remove("on");
    }
  };
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 900)))(syncSky, { timeout: 2500 });
  window.addEventListener("aurora-look", syncSky);
}
// each nav button's text follows the brightness behind it (navTone.js)
(window.requestIdleCallback || ((fn) => setTimeout(fn, 700)))(() => {
  import("./navTone.js").then((m) => m.startNavTone()).catch(() => {});
}, { timeout: 2000 });
initScreensaver(); // idle-on-home backdrop slideshow (any input wakes)
initPrefetch(); // the next screen's data, fetched while this one is read
// The connection (net.js): one usage event per tab once it is known, another
// when it changes — so the admin can see how many sessions are on a thin
// line. NOT a toast: lighter pictures are not worth interrupting anyone for
// (2026-10-26: "almost always says when I get into the site that I have a
// slow connection — an annoying message"). The viewer hears about the line
// only when it changes what they watch — the player says so when it starts a
// film on a lighter stream (net.js slowNoteDue).
{
  const report = () => {
    const n = netInfo();
    track("net", { tier: n.tier, src: n.source, ...(n.kbps != null ? { kbps: n.kbps } : {}), ...(n.rtt != null ? { rtt: n.rtt } : {}) });
  };
  setTimeout(report, 15000); // after the first screens have given it something to measure
  onNet(() => report());
}
// usage stats: which tab gets tapped (the screens themselves report via the router)
$("#nav").addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest(".nav-item[data-route]");
  if (a) track("nav", { to: a.getAttribute("data-route") });
});
// a library change can flip a catalogue item's "in library" mark — start over
onMessage("library_updated", () => forgetWarm("/api/catalog"));

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
  const READY_SHOW_MS = 10000;
  let readySig = "";
  let readyTimer = 0;
  const paint = () => {
    // Smart downloads (the next episode, fetched ahead by itself) never light
    // the pill: nobody asked for them, so there is nothing to announce. They
    // are on the Downloads page, marked AUTO, for whoever goes looking.
    const ready = readyDownloads().filter((j) => !j.smart);
    if (ready.length > 0) {
      // Ready: a download icon with a count badge — how many things you asked
      // for have landed and you have not opened yet. On a phone it stays. On a
      // computer it is shown for ten seconds — when the app opens, and again
      // whenever the set changes — then rests out of sight, and comes back
      // under the pointer or keyboard focus (CSS: .nav-dl.rest).
      const sig = ready.map((j) => j.id).sort().join(",");
      if (sig !== readySig) {
        readySig = sig;
        pill.classList.remove("rest");
        clearTimeout(readyTimer);
        readyTimer = setTimeout(() => pill.classList.add("rest"), READY_SHOW_MS);
      }
      pill.innerHTML = "";
      pill.append(el("span", { class: "nav-dl-icon", html: icons.download }), el("i", { class: "nav-dl-badge" }, ready.length > 99 ? "99+" : String(ready.length)));
      pill.title = ready.length === 1 ? `“${ready[0].label || ready[0].title}” is ready to play` : `${ready.length} downloads ready to play`;
      pill.setAttribute("aria-label", pill.title);
      pill.classList.add("ready");
      return pill.classList.remove("hidden");
    }
    readySig = "";
    clearTimeout(readyTimer);
    pill.classList.remove("ready", "rest");
    pill.removeAttribute("aria-label");
    pill.title = "Downloads in progress";
    const act = [...downloads.values()].filter((j) => ACTIVE.includes(j.status) && !j.smart);
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
  // A read that failed (the server restarting as the page opened) is asked
  // again by itself — 3 s, 8 s, 20 s, then every 30 s — and on the socket's
  // first welcome, instead of leaving My downloads saying "Nothing downloading
  // yet" until a reload (the TV said "Could not load your downloads" for good).
  const RETRY_MS = [3000, 8000, 20000, 30000];
  let failedFor = undefined; // the profile whose read failed (undefined: none did)
  let retryN = 0;
  let retryTimer = null;
  const load = () => {
    const pid = state.profile ? state.profile.id : null;
    if (pid === fetchedFor) return;
    fetchedFor = pid;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    api.downloads(pid)
      .then((res) => {
        // the route answers a bare array
        const list = Array.isArray(res) ? res : res.downloads || [];
        const late = failedFor !== undefined;
        failedFor = undefined;
        retryN = 0;
        if (state.downloadsFailed) { state.downloadsFailed = false; emit({ type: "downloads_read", ok: true }); }
        if (late) {
          // a screen already open (My downloads, a title's page) hears it as it hears a reconnect
          for (const job of list) emit({ type: "download_update", job, caughtUp: true });
          return;
        }
        for (const j of list) downloads.set(j.id, j);
        paint();
      })
      .catch(() => {
        // (undefined: nothing fetched for anyone, so the next load() asks whoever is in by then)
        fetchedFor = undefined;
        failedFor = pid;
        // My downloads says so instead of "Nothing downloading yet" (screens/downloads.js)
        if (!state.downloadsFailed) { state.downloadsFailed = true; emit({ type: "downloads_read", ok: false }); }
        const wait = RETRY_MS[Math.min(retryN++, RETRY_MS.length - 1)];
        retryTimer = setTimeout(() => { retryTimer = null; if (fetchedFor === undefined) load(); }, wait);
      });
  };
  load();
  // The socket came back (every welcome after the first). Whatever happened
  // to a download in between never reached this tab: a download that finished
  // during the outage stayed "downloading" on the pill, My downloads and the
  // title's page until a reload, and its "ready to watch" was never said.
  // Ask for the list again and hand each job to the same listeners the live
  // messages reach, so every open screen catches up — a job seen moving to
  // "done" is announced exactly as if its message had arrived.
  let welcomes = 0;
  onMessage("welcome", () => {
    if (++welcomes === 1 && failedFor === undefined) return; // boot's own list is `load()` above (unless it failed)
    const pid = state.profile ? state.profile.id : null;
    api.downloads(pid)
      .then((res) => {
        if ((state.profile ? state.profile.id : null) !== pid) return;
        const list = Array.isArray(res) ? res : res.downloads || [];
        fetchedFor = pid;
        failedFor = undefined;
        retryN = 0;
        if (state.downloadsFailed) { state.downloadsFailed = false; emit({ type: "downloads_read", ok: true }); }
        const ids = new Set(list.map((j) => j.id));
        for (const id of [...downloads.keys()]) if (!ids.has(id)) emit({ type: "download_removed", id });
        for (const job of list) emit({ type: "download_update", job, caughtUp: true });
      })
      .catch(() => {});
  });
  // The app icon's badge (an installed Aurora, where the platform has one):
  // a download you asked for that lands while the app is in the background
  // puts a number on the icon; coming back to the app takes it off. The
  // count lives in memory only — and a badge left over from a session that
  // was closed with it showing is cleared the next time the app is looked at.
  let badgeN = 0;
  const bumpBadge = () => {
    try {
      if (!document.hidden || typeof navigator.setAppBadge !== "function") return;
      badgeN++;
      const p = navigator.setAppBadge(badgeN);
      if (p && p.catch) p.catch(() => {});
    } catch {}
  };
  const clearBadge = () => {
    try {
      if (document.hidden) return;
      badgeN = 0;
      if (typeof navigator.clearAppBadge !== "function") return;
      const p = navigator.clearAppBadge();
      if (p && p.catch) p.catch(() => {});
    } catch {}
  };
  document.addEventListener("visibilitychange", clearBadge);
  clearBadge();
  // This profile's settings changed on another device (a TV, a phone): the
  // ones that follow the person are read again and applied here.
  onMessage("profile_updated", ({ profileId }) => {
    if (state.profile && state.profile.id === profileId) refreshPersonPrefs();
  });
  onMessage("server_notice", ({ message }) => { if (message) toast(message, "🛠️"); });
  // Somebody in the household recommended something to this person: a toast
  // (js/recommend.js), and the icon's badge when the app is in the background
  watchArrivals();
  onMessage("household_recs", (msg) => {
    if (state.profile && (!msg || !msg.profile || msg.profile === state.profile.id)) bumpBadge();
  });
  // The admin removed a request (or its file left the library): the row goes
  // everywhere it was drawn.
  onMessage("download_removed", ({ id }) => {
    if (id && downloads.delete(id)) paint();
  });
  // `caughtUp`: from the list asked for after a reconnect (above), not live
  onMessage("download_update", ({ job, caughtUp }) => {
    if (!job) return;
    // A smart download is the one download the viewer never asked for, and
    // it starts two-thirds through an episode — the worst moment for a
    // message (elia: "if we do those they need to be almost unnoticeable").
    // So: nothing at all over a playing film, and otherwise one small dim
    // line that is gone in two seconds. It can be cancelled, and the feature
    // turned off, from the Downloads page and Settings → More settings → Downloads.
    if (!caughtUp && !downloads.has(job.id) && job.mine && job.smart && !document.querySelector(".player")) {
      const ep = job.season && job.episode ? ` S${job.season}E${job.episode}` : "";
      toast(`Next episode downloading${ep ? " ·" + ep : ""}`, "⬇", null, { quiet: true });
    }
    // "Ready to watch": something you asked for has landed and is in the
    // library — said once, wherever you are in the app, with Play on it.
    // (It used to be said only if you happened to be on the Downloads page or
    // the title's own page.) Behind a film it is one quiet line, and a
    // system notification is added when the tab is in the background and
    // you turned those on under Settings. Smart downloads stay silent.
    const prev = downloads.get(job.id);
    const landed = job.status === "done" && job.libraryId && job.mine && !job.smart && !job.seenAt &&
      !(prev && prev.status === "done" && prev.libraryId);
    downloads.set(job.id, job);
    paint();
    if (landed && prev) { // `prev`: we watched it arrive — not a list being loaded
      bumpBadge(); // (only counts while the app is in the background)
      const name = job.label || job.title;
      const playing = !!document.querySelector(".player");
      if (playing) toast(`“${name}” is ready`, "✅", null, { quiet: true });
      else toast(`“${name}” is ready to watch`, "✅", { label: "Play", onClick: () => navigate(`#/play/${job.libraryId}`) });
      try {
        // with Web Push on, the server's notification is the one (same tag, so even a race shows once)
        if (document.hidden && localStorage.getItem("aurora-push") !== "1" && localStorage.getItem("aurora-notify-ready") === "1" && "Notification" in window && Notification.permission === "granted") {
          const n = new Notification("Ready to watch", { body: name, tag: `aurora-ready-${job.id}` });
          n.onclick = () => { window.focus(); navigate(`#/play/${job.libraryId}`); n.close(); };
        }
      } catch {}
    }
  });
  window.addEventListener("hashchange", () => setTimeout(() => { load(); paint(); }, 0));
}

// Offline copies: the worker that serves the app and saved titles with no
// server in reach, the "Saved" nav entry (shown once something is saved,
// or whenever the server is unreachable), and the flush of progress made
// offline the moment the server is back.
{
  import("./offline.js").then((offline) => {
    // The worker is for later (offline, the next visit): it registers once
    // the first screen is done, so its install — which copies the app's code
    // into its cache — does not share a thin line with that screen.
    firstScreen.then(() => offline.registerWorker());
    const nav = $("#nav-saved");
    const paint = async () => {
      let any = false;
      try { any = (await offline.listSaved()).length > 0 || offline.listJobs().length > 0; } catch {}
      // Only where offline copies can exist at all (https / localhost) —
      // over plain http the entry would lead to a screen that says no.
      nav.classList.toggle("hidden", !offline.available() || !(any || !navigator.onLine || !state.ws));
    };
    paint();
    // (a save that starts or ends shows or hides the entry)
    let jobsN = offline.listJobs().length;
    offline.onJobs((list) => { if (list.length !== jobsN) { jobsN = list.length; paint(); } });
    window.addEventListener("hashchange", () => setTimeout(paint, 0));
    window.addEventListener("offline", paint);
    window.addEventListener("online", () => { paint(); offline.flushProgress().catch(() => {}); });
    // the socket coming back is the surest "server is there" signal — also
    // the moment to fetch skip-intro / X-Ray for copies saved before those
    // travelled with them
    onMessage("welcome", () => {
      offline.flushProgress().catch(() => {});
      offline.backfillExtras().catch(() => {});
      paint();
    });
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
        "Glass over a living sky and a cleaner player. ",
        "The Legacy look is still here — switch between the two any time under Settings → Appearance → Look."),
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

// Web Push follows the profile: this browser has ONE subscription, and it was
// filed under whoever switched notifications on. Every time a profile is
// entered (boot, a switch at the wall, a sign-in) it is filed again under
// that profile; signing out takes it off the server (signOutHere below).
// push.js is only loaded where the switch is on.
const pushOn = () => { try { return localStorage.getItem("aurora-push") === "1"; } catch { return false; } };
window.addEventListener("aurora-profile", () => {
  if (pushOn()) import("./push.js").then((m) => m.rebind()).catch(() => {});
});
// "Sign out", from the profile menu and from Settings: out means out.
const signOutHere = async () => {
  // while the server still knows who this is; never allowed to hold the sign-out up
  if (pushOn()) {
    await Promise.race([
      import("./push.js").then((m) => m.release()).catch(() => {}),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  }
  try { await api.logout(); } catch {}
  // forget the device's shortcuts back in
  try {
    localStorage.removeItem("aurora-profile");
    if (state.profile) sessionStorage.removeItem(`aurora-token-${state.profile.id}`);
  } catch {}
  location.reload();
};
document.addEventListener("aurora-sign-out", () => signOutHere());

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
  api.version().then((d) => { version = d && d.version; paint(); }).catch(() => {});
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

// [phone-remote] "Your TVs" (js/remote.js): loaded once the app is up, at idle —
// it learns whether a TV is on, and this computer becomes one the phone can
// play on. Nothing of it is on the boot path.
let remoteMod = null;
const startRemote = () => import("./remote.js").then((m) => { remoteMod = m; m.initRemote(); }).catch(() => {});
// [/phone-remote]

const showProfileMenu = () => {
  document.querySelector(".nav-menu-wrap")?.remove(); // toggle: second click closes
  const remoteOn = !!(remoteMod && remoteMod.getDevices().length); // [phone-remote]
  const item = (label, onclick, cls = "") =>
    el("button", { class: `nav-menu-item focusable ${cls}`, onclick }, label);
  const menu = el("div", { class: "nav-menu" },
    el("div", { class: "nav-menu-head" },
      el("div", { class: "nav-menu-name" }, state.profile?.name || "Aurora"),
      state.user && el("div", { class: "nav-menu-sub" }, `@${state.user.username || state.user.name}`)),
    state.authMode !== "closed" &&
      item("Switch profile", () => { close(); openGate(); }),
    item("Settings", () => { close(); navigate("#/preferences"); }),
    item("My downloads", () => { close(); navigate("#/downloads"); }),
    // saved titles, saves under way, a video from this device (screens/saved.js)
    item("On this device", () => { close(); navigate("#/saved"); }),
    item("What's new", () => { close(); navigate("#/new"); }),
    // the product page with every Aurora app (same words as the sign-in card)
    el("a", { href: "/install", class: "nav-menu-item focusable", "data-ui": "nav.getapps" }, "Get the apps"),
    item("Report a problem", () => { close(); showReportSheet(); }),
    item("Join a watch party", () => { close(); showJoinParty(); }),
    // [phone-remote] there while a TV (or another computer) of this profile is on
    remoteOn && item("Remote", () => { close(); navigate("#/remote"); }),
    // [/phone-remote]
    state.user &&
      item("Sign out", () => {
        close();
        signOutHere();
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

// The sign-in wall went up under a running app (api.js saw a 401
// { signinRequired }): to the sign-in screen, not a page of failed requests.
window.addEventListener("aurora-signin-required", () => onSigninRequired());
// The admin signed this profile out and the tab was still showing it.
window.addEventListener("aurora-signed-out", () => onSignedOut());

// A new password is due on the profile this tab is using: the server refused
// a request for that reason (api.js), or said so to the socket. Whatever the
// screen, the blocking "pick a new password" screen goes up — once; /api/me
// says whose it is (and that it is still due: a burst of refusals can outlive
// the save). The app behind it is full of failed requests by now, so a saved
// password ends in a reload: boot walks straight back in on the fresh
// credentials.
let askingReset = false;
const raiseResetWall = async () => {
  if (askingReset || resetWallUp()) return;
  askingReset = true;
  try {
    const me = await api.me(state.token || undefined);
    if (!me.passwordResetRequired || !me.resetProfile) return;
    await showResetWall({ profile: me.resetProfile, token: state.token, passwordSetup: !!me.passwordSetup });
    location.reload();
  } catch {
    // no answer: nothing is known — the next refusal asks again
  } finally {
    askingReset = false;
  }
};
window.addEventListener("aurora-password-reset", () => { if (booted) raiseResetWall(); });
onMessage("password_reset_required", () => { if (booted) raiseResetWall(); });
// (until boot has asked /api/me itself, it is boot that decides)
let booted = false;

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
    // Asked with what this tab remembers — the sign-in cookie rides by
    // itself, the unlock token of the remembered profile is sent along — so
    // a reload (or a deep link) of a profile that owes a new password lands
    // on the "pick a new password" screen again, and nowhere else.
    let remembered = null;
    try { const id = localStorage.getItem("aurora-profile"); remembered = id ? savedToken(id) : null; } catch {}
    const me = await api.me(remembered || undefined);
    state.authMode = me.authMode || "open";
    state.user = me.user || null;
    // (remembered for the next load: index.html's early requests ask for the
    // profile list only where this visit could read it)
    try { localStorage.setItem("aurora-authmode", state.authMode); } catch {}
    if (me.passwordResetRequired && me.resetProfile) {
      // Saved: this tab holds fresh credentials (the token is kept where an
      // unlock keeps it, the profile is the remembered one) and boot goes on
      // as for any returning tab. "Sign out" reloads instead.
      const fresh = await showResetWall({ profile: me.resetProfile, token: remembered, passwordSetup: !!me.passwordSetup });
      state.user = fresh.user || null;
      setAuthToken(null); // boot attaches it again when it enters the profile
    }
    booted = true;
    // An emailed reset link (#/reset/<token>, auth-round): the new-password
    // step first, in every sign-in mode; once saved, this tab is signed in.
    const link = /^#\/reset\/([A-Za-z0-9_-]{20,200})$/.exec(location.hash || "");
    if (link) {
      try { history.replaceState(history.state, "", "#/"); } catch {}
      const res = await showLoginScreen({ view: "reset", token: link[1] });
      if (res && res.profile) {
        state.user = res.user || null;
        loginEntry = res;
      }
    }
    if (state.authMode === "closed" && !state.user) {
      // No sign-in on a server that requires one: until somebody is in again
      // the next load asks nothing early as the remembered profile (it would
      // only be refused — index.html; setProfile says when it may again).
      try { localStorage.removeItem("aurora-early"); } catch {}
      const res = await showLoginScreen();
      state.user = (res && res.user) || null;
      if (res && res.profile) loginEntry = res;
    }
  } catch {}
  booted = true;

  try {
    await loadProfiles();
  } catch {
    // No server in reach. If this device holds saved copies, that is exactly
    // the moment they exist for: open Saved (it and the player work from the
    // device's own store) instead of a dead end — the old screen said "can't
    // reach the server" and stopped, with the films right there.
    // Even with nothing saved, Saved is not a dead end now: a video from
    // this device plays there (js/localplay.js), and the screen says the
    // server is out of reach, with Try again.
    let saved = [];
    try { saved = await (await import("./offline.js")).listSaved(); } catch {}
    state.noServer = true;
    // (replaceState: no hashchange — setting location.hash here fired one
    // AFTER startRouter's own first render, and the screen was built twice)
    try { history.replaceState(history.state, "", "#/saved"); } catch { location.hash = "#/saved"; }
    startRouter(document.getElementById("app"));
    toast(saved.length ? "No server in reach — here is what's saved on this device" : "No server in reach — you can still play a file from this device", "📱");
    return;
  }

  const start = () => {
    paintProfileChip();
    startRouter(document.getElementById("app"));
    appRunning(); // from here on, losing the sign-in is session.js's business
    // What this browser can play, said to the server once per load (TV round
    // 2026-10-19, parity with the TV app): the title reads after it come back
    // with how each file plays HERE (avcaps.js, src/media/playpath.js).
    import("./avcaps.js").then((m) => m.reportCaps()).catch(() => {});
    // Booted from the worker's cached answers with no network: Home would be
    // a wall of titles that can't play. Saved is where the playable ones are.
    if (!navigator.onLine) {
      import("./offline.js").then(async (o) => {
        const list = await o.listSaved().catch(() => []);
        // (nothing saved: Saved still plays a file from this device)
        if ((location.hash || "#/") === "#/") {
          navigate("#/saved");
          toast(list.length ? "You're offline — these are saved on this device" : "You're offline — you can still play a file from this device", "📱");
        }
      }).catch(() => {});
    }
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
    // the socket above connected before there was a session: connect again,
    // signed in, or the server keeps treating it as a stranger's (ws.js)
    reconnect();
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

// Warm the lazy screens — but only once the FIRST screen is done, and one at
// a time. They used to be fetched from a requestIdleCallback registered at
// boot, and "idle" on a phone arrives early: the main thread is idle every
// time boot waits on the network (who am I, the profiles, the watch state,
// Home). So ten modules — the player's 250 KB among them — were fetched and
// compiled in the middle of that chain, at the priority of the code the page
// was waiting for: on a slow line some 160 KB ahead of Home's own data and
// pictures, on a slow phone a few hundred milliseconds of compiling before
// the first screen could build. Nothing a person does changes: a tap on a
// screen whose code is still on its way loads it then, exactly as a tap
// during the old warm-up did.
firstScreen.then(async () => {
  await whenIdle();
  startRemote(); // [phone-remote]
  for (const f of [
    "./screens/browse.js", "./screens/search.js", "./screens/discover-detail.js",
    "./screens/player.js", "./screens/preferences.js",
    "./screens/wrapped.js", "./screens/taste.js", "./screens/requests.js", "./screens/pickforme.js",
  ]) {
    await whenIdle();
    await import(f).catch(() => {});
  }
});
// The "New" tab's dot: lit until this version's page has been seen. A nav
// dot, not something the first paint waits on — it keeps its old moment (the
// first idle), since it is something a person can see arrive.
(window.requestIdleCallback || ((fn) => setTimeout(fn, 2500)))(() => {
  import("./screens/whatsnew.js").then((m) => m.paintNewDot()).catch(() => {});
});

// The AI tab only exists when the server has an AI key configured.
// Failure here is silent by design: no key, no tab, nothing else changes.
api
  .aiStatus()
  .then((s) => {
    if (s && s.enabled) document.getElementById("nav-pick")?.classList.remove("hidden");
  })
  .catch(() => {});

