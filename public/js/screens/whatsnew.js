// "New" — what Aurora can do now, and how to use it. A grid of glass cards,
// each with a small living cue, one plain sentence, a "how", and a button
// that takes you to where the feature lives. Curated by hand (the raw
// changelog stays under Preferences → What's new); the cards from the
// newest release carry a NEW ribbon, and the nav's dot goes out once you've
// been here on this version.
import { el, toast } from "../ui.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { navigate } from "../router.js";
import { showReportSheet } from "../report.js";

// `since`: the release a feature landed in — the newest release's cards get
// the ribbon. `cue`: which small animation the glyph tile plays.
const FEATURES = [
  {
    since: "1.6.0", cue: "trailer", glyph: "🎬",
    title: "Trailers on the billboard",
    what: "Let a title sit on the home hero for six seconds and its trailer plays, quietly, then the billboard moves on.",
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
    how: "Wrong on a show? Gear → Skip intro → Ignore the detected intro, or mark it by hand: Mark intro start, then the Ends here chip.",
    go: { label: "Open Shows", to: "#/shows" },
  },
  {
    since: "1.4.0", cue: "subs", glyph: "💬",
    title: "Subtitles that find themselves",
    what: "Pick a language once and it follows your profile everywhere. A title you own that lacks it gets one fetched and switched on.",
    how: "Preferences → Subtitles → Preferred subtitle language.",
    go: { label: "Set a language", to: "#/preferences" },
  },
  {
    since: "1.1.0", cue: "smart", glyph: "⬇",
    title: "Smart downloads",
    what: "Two-thirds into an episode, the next one starts downloading to the server so it plays from disk.",
    how: "A toast says when it queues, with Cancel on it. Off per profile under Preferences → Playback.",
    go: { label: "My downloads", to: "#/downloads" },
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
    since: "1.2.0", cue: "look", glyph: "✨",
    title: "Two looks",
    what: "Apple Horror — glass over a living sky — or the classic Legacy look. Yours alone, per profile.",
    how: "Preferences → Appearance → Look.",
    go: { label: "Change the look", to: "#/preferences" },
  },
  {
    since: "1.5.0", cue: "report", glyph: "🛠️",
    title: "Report a problem",
    what: "A few words is enough. Where you were, what was playing and the last errors this page saw come along by themselves.",
    how: "Profile menu → Report a problem, or the player's gear menu → Help.",
    go: { label: "Report something", to: "report" },
  },
  {
    since: "1.4.0", cue: "keys", glyph: "⌨️",
    title: "Keyboard shortcuts",
    what: "Space plays, arrows skip, C for subtitles, M mutes, F fullscreen.",
    how: "Press ? anywhere for the full list.",
    go: { label: "Show shortcuts", to: "shortcuts" },
  },
  {
    since: "1.1.0", cue: "resume", glyph: "▶️",
    title: "Resume, with the frame",
    what: "Coming back to a title shows the frame you stopped on, in the player and on its page.",
    how: "Start over is one press away on the card, for the six seconds it stays up.",
    go: null,
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
  // the newest release any card belongs to — those get the ribbon
  const newest = FEATURES.map((f) => f.since).sort(cmpVersion).pop();
  try { if (version) localStorage.setItem(NEW_SEEN_KEY, version); } catch {}
  document.getElementById("nav-new")?.classList.remove("has-new");

  const act = (f) => {
    if (!f.go) return null;
    const onclick = () => {
      if (f.go.to === "join-party") return document.dispatchEvent(new CustomEvent("aurora-join-party"));
      if (f.go.to === "report") return showReportSheet();
      if (f.go.to === "shortcuts") return document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
      navigate(f.go.to);
    };
    return el("button", { class: "btn small focusable wn-go", onclick }, f.go.label);
  };

  const card = (f, i) =>
    el("article", { class: `wn-card${cmpVersion(f.since, newest) === 0 ? " is-new" : ""}`, style: { "--i": i } },
      el("div", { class: `wn-cue cue-${f.cue}` }, el("span", { class: "wn-glyph" }, f.glyph), el("i"), el("i"), el("i")),
      el("div", { class: "wn-body" },
        el("div", { class: "wn-head" },
          el("h2", { class: "wn-title" }, f.title),
          cmpVersion(f.since, newest) === 0 && el("span", { class: "wn-ribbon" }, "New")),
        el("p", { class: "wn-what" }, f.what),
        el("p", { class: "wn-how" }, el("b", {}, "How "), f.how),
        act(f)));

  screen.append(
    el("div", { class: "wn-hero" },
      el("div", { class: "wn-kicker" }, version ? `Aurora ${version}` : "Aurora"),
      el("h1", { class: "wn-h1" }, "New in Aurora"),
      el("p", { class: "wn-sub" }, `Hi ${state.profile ? state.profile.name : "there"} — here's what you can do now, and how. The full changelog lives under Preferences.`)),
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
