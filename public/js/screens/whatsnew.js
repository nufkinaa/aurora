// "New" — what Aurora can do now, and how to use it. A grid of glass cards,
// each with a small living cue, one plain sentence, a "how", and a button
// that takes you to where the feature lives. Curated by hand (the raw
// changelog stays under Settings → More settings → What's new); the cards from the
// newest release carry a NEW ribbon, and the nav's dot goes out once you've
// been here on this version.
import { el, toast } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { navigate } from "../router.js";
import { showReportSheet } from "../report.js";

// `since`: the release a feature landed in — everything from NEW_FROM on
// carries the ribbon (move it forward when a new batch arrives, so the ribbon
// stays on what is actually recent). `cue`: which small animation the glyph
// tile plays. Cards are retired when the thing stops being news: the two
// looks, the keyboard shortcuts and resume-with-the-frame went 2026-10-05.
const NEW_FROM = "1.6.9";
const FEATURES = [
  {
    since: "1.6.12", cue: "look", glyph: "🔍",
    title: "X-Ray",
    what: "Who is in it, who made it and what people thought — the cast with their characters and faces, ratings side by side, director, writers, awards. For a series it is about one episode at a time, guest stars included.",
    how: "Press X-Ray on any title's page, or the X-Ray button in the player — the film pauses and picks up again when you close it.",
    go: { label: "Open a title", to: "#/movies" },
  },
  {
    since: "1.6.20", cue: "smart", glyph: "📶",
    title: "Quality that follows your connection",
    what: "Aurora watches how fast the film is arriving. When the line falls behind it moves to 720p or 480p before the picture freezes, and back up when there is room again — the film keeps playing through the change.",
    how: "Nothing to do. A small \"Auto 720p\" in the corner tells you, with Revert on it. To choose yourself: the player's gear → Quality, or Settings → More settings → Data use.",
    go: { label: "Data use", to: "#/preferences" },
  },
  {
    since: "1.6.13", cue: "trailer", glyph: "✅",
    title: "Ready to watch",
    what: "When something you saved finishes downloading, Aurora tells you once, wherever you are in the app, with Play right on the message.",
    how: "For a notification while Aurora is in the background: Settings → More settings → Downloads → Tell me when it's ready.",
    go: { label: "My downloads", to: "#/downloads" },
  },
  {
    since: "1.6.13", cue: "offline", glyph: "📲",
    title: "Save the next three",
    what: "One press on a series you own saves the next three episodes you haven't finished to this device — for a flight, a train, a weekend away.",
    how: "Open the series and press Save next 3. The size is asked once; episodes already saved are skipped.",
    go: { label: "Open Shows", to: "#/shows" },
  },
  {
    since: "1.6.13", cue: "hold", glyph: "🏠",
    title: "Popular in this house",
    what: "Search, before you type anything, shows what the household has been watching these last six weeks — minus what you have already finished.",
    how: "Open Search and look under your recent searches.",
    go: { label: "Open Search", to: "#/search" },
  },
  {
    since: "1.6.6", cue: "look", glyph: "🧭",
    title: "More like this, by feel",
    what: "The row under a title now looks for the same vibe — shared themes, tone and quality — not just whatever is popular in the genre.",
    how: "Hover a card in the row to see why it was picked: \"Same vibe: alien contact · scientist\".",
    go: { label: "Browse movies", to: "#/movies" },
  },
  {
    since: "1.6.6", cue: "smart", glyph: "⬇",
    title: "Smart downloads tidy up after you",
    what: "Two-thirds into an episode, the next one downloads to the server. Once you have finished an episode it fetched and started a later one, it is removed again.",
    how: "Never touches anything downloaded by hand, or an episode someone else is part-way through. Both switches are under Settings → More settings → Downloads.",
    go: { label: "My downloads", to: "#/downloads" },
  },
  {
    since: "1.6.0", cue: "trailer", glyph: "🎬",
    title: "Trailers on the billboard",
    what: "Let a title sit on the home hero for four seconds and its trailer plays, quietly, then the billboard moves on.",
    how: "Press Unmute above the dots for sound — that gives it 50 seconds. A dot, a swipe or scrolling ends it.",
    go: { label: "Go home", to: "#/" },
  },
  {
    since: "1.4.0", cue: "hold", glyph: "👆",
    title: "Hold a card to peek",
    what: "Hold any poster (or right-click it) and it opens as a sheet: what it is, how much is left, the synopsis.",
    how: "Play, Details and My List are right there. Back, the backdrop or ✕ puts you exactly where you were.",
    go: { label: "Try it on Movies", to: "#/movies" },
  },
  {
    since: "1.1.0", cue: "party", glyph: "👥",
    title: "Watch together",
    what: "A few devices, one title, in step. Play, pause and jumps happen for everyone.",
    how: "In the player press 👥 → Start a party, and share the four-letter code. Others join from the profile menu. Up next carries the whole room along.",
    go: { label: "Join a party", to: "join-party" },
  },
  {
    since: "1.3.0", cue: "skip", glyph: "⏭",
    title: "Skip intro, Up next — detected",
    what: "Aurora listens to every episode and finds the theme and the credits by itself, so the buttons appear at the right moment.",
    how: "Nothing to set up — the Skip intro button appears by itself while the theme plays.",
    go: { label: "Open Shows", to: "#/shows" },
  },
  {
    since: "1.4.0", cue: "subs", glyph: "💬",
    title: "Subtitles that find themselves",
    what: "Pick a language once and it follows your profile everywhere. A title you own that lacks it gets one fetched and switched on.",
    how: "Settings → Subtitles → Subtitle language.",
    go: { label: "Set a language", to: "#/preferences" },
  },
  {
    since: "1.1.0", cue: "offline", glyph: "📱",
    title: "Save a title for the road",
    what: "Keep a phone-playable copy inside Aurora on this device. It plays with no server in reach.",
    how: "On an https address, press 📱 on any title you own. Your copies live under Saved.",
    go: { label: "Saved on this device", to: "#/saved" },
  },
  {
    since: "1.4.0", cue: "tap", glyph: "👉",
    title: "Phone gestures",
    what: "Double-tap the left or right of the picture to skip ten seconds, with a ripple where your finger landed.",
    how: "Dragging the scrubber ticks under your finger where the intro ends and the credits start.",
    go: null,
  },
  {
    since: "1.5.0", cue: "report", glyph: "🛠️",
    title: "Report a problem",
    what: "A few words is enough. Where you were, what was playing and the last errors this page saw come along by themselves.",
    how: "Profile menu → Report a problem, or the player's gear menu → Help.",
    go: { label: "Report something", to: "report" },
  },
];

const cmpVersion = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

export const NEW_SEEN_KEY = "aurora-new-seen";

export const renderWhatsNew = async (root) => {
  const screen = el("div", { class: "screen whatsnew" });
  root.append(screen);

  let version = null;
  try { version = (await api.changelog()).version || null; } catch {}
  const isNew = (f) => cmpVersion(f.since, NEW_FROM) >= 0;
  try { if (version) localStorage.setItem(NEW_SEEN_KEY, version); } catch {}
  document.getElementById("nav-new")?.classList.remove("has-new");

  const act = (f) => {
    if (!f.go) return null;
    const onclick = () => {
      if (f.go.to === "join-party") return document.dispatchEvent(new CustomEvent("aurora-join-party"));
      if (f.go.to === "report") return showReportSheet();
      navigate(f.go.to);
    };
    return el("button", { class: "btn small focusable wn-go", onclick }, f.go.label);
  };

  const card = (f, i) =>
    el("article", { class: `wn-card${isNew(f) ? " is-new" : ""}`, style: { "--i": i } },
      el("div", { class: `wn-cue cue-${f.cue}` }, el("span", { class: "wn-glyph" }, f.glyph), el("i"), el("i"), el("i")),
      el("div", { class: "wn-body" },
        el("div", { class: "wn-head" },
          el("h2", { class: "wn-title" }, f.title),
          isNew(f) && el("span", { class: "wn-ribbon" }, "New")),
        el("p", { class: "wn-what" }, f.what),
        el("p", { class: "wn-how" }, el("b", {}, "How "), f.how),
        act(f)));

  screen.append(
    el("div", { class: "wn-hero" },
      el("div", { class: "wn-kicker" }, version ? `Aurora ${version}` : "Aurora"),
      el("h1", { class: "wn-h1" }, "New in Aurora"),
      el("p", { class: "wn-sub" }, `Hi ${state.profile ? state.profile.name : "there"} — here's what you can do now, and how. The full changelog lives under Settings.`)),
    el("div", { class: "wn-grid" }, FEATURES.map(card)),
    el("div", { class: "wn-foot" },
      el("button", { class: "btn focusable", onclick: () => navigate("#/preferences"), html: "<span>Full changelog</span>" }),
      el("button", { class: "btn btn-primary focusable", onclick: () => navigate("#/"), html: "<span>Back to browsing</span>" })),
  );
};

// The nav's dot: on until this version's page has been seen.
export const paintNewDot = async () => {
  const nav = document.getElementById("nav-new");
  if (!nav) return;
  try {
    const { version } = await api.changelog();
    let seen = null;
    try { seen = localStorage.getItem(NEW_SEEN_KEY); } catch {}
    nav.classList.toggle("has-new", !!version && seen !== version);
  } catch {}
};
