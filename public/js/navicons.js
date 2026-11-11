// The phone menu's icons (js/navmore.js, the tab bar's More), one per line.
//
// elia, 2026-11-10: "on the side panel on web mobile put icons also". They are
// the Android phone app's More sheet's glyphs, path for path, so the website's
// menu and the app's read as one thing:
//   tv-native/src/phone/moreItems.ts — which icon each line wears (`icon:`)
//   tv-native/src/phone/ui/Icon.tsx  — the phone's own paths (EXTRA, LINE)
//   tv-native/src/components/Icon.tsx — the site's set as the TV draws it
// Search and Settings keep the website's line glyphs (the tab bar's magnifier
// and the top bar's gear — the phone app has them too, as navSearch/navGear).
// Every other one is a 24×24 filled silhouette. All draw in currentColor (lit,
// focused and plain rows colour them as they colour the words), carry no
// words of their own and are hidden from assistive tech: a line's name is its
// words. test/navicons.test.js holds the two sides together: every line of the
// menu has an icon here, and each is the app's path for that line.

const fill = (inner) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`;
const p = (d) => `<path d="${d}"/>`;
const line = (w, inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" aria-hidden="true" focusable="false">${inner}</svg>`;

// two heads: Swipe your taste and Join a watch party (the app's `people`)
const PEOPLE = fill(p("M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm7 1a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9 13c-3.3 0-7 1.7-7 4.2V20h14v-2.8C16 14.7 12.3 13 9 13zm7 1.2c-.6 0-1.2.1-1.8.2 1.1.9 1.8 2 1.8 3.4V20h6v-2.6c0-2-3.3-3.2-6-3.2z"));

// a child's face, for Children mode (the app's `child`)
const CHILD = "M9 11.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5zm6 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8 0-.29.02-.58.05-.86 2.36-1.05 4.23-2.98 5.21-5.37C11.07 8.33 14.05 10 17.42 10c.78 0 1.53-.09 2.25-.26.21.71.33 1.47.33 2.26 0 4.41-3.59 8-8 8z";

// [the app's icon name, the glyph]
export const NAV_ICONS = {
  search: ["navSearch", line(2.4, '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>')],
  home: ["home", fill(p("M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"))],
  movies: ["film", fill(p("M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4h-4z"))],
  shows: ["series", fill('<rect x="2" y="4" width="20" height="13" rx="2"/><rect x="8" y="19" width="8" height="2" rx="1"/>')],
  list: ["bookmark", fill(p("M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"))],
  calendar: ["calendar", fill(p("M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11zM7 11h5v5H7z"))],
  pick: ["chat", fill(p("M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"))],
  new: ["sparkle", fill(p("M10 2.5l1.9 5.6 5.6 1.9-5.6 1.9L10 17.5l-1.9-5.6L2.5 10l5.6-1.9zM18 13.5l.95 2.05L21 16.5l-2.05.95L18 19.5l-.95-2.05L15 16.5l2.05-.95zM18 2.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"))],
  saved: ["downloadDevice", fill(p("M21 2H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7v2H7v2h10v-2h-3v-2h7a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm0 14H3V4h18v12zM11 6h2v3.2h2.2L12 13 8.8 9.2H11V6z"))],
  downloads: ["download", fill(p("M12 3v10.6l-3.8-3.8-1.4 1.4L12 17.4l5.2-6.2-1.4-1.4-2.8 3.8V3h-2zM5 19h14v2H5z"))],
  remote: ["tv", fill(p("M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"))],
  household: ["send", fill(p("M3.4 20.4 21 12 3.4 3.6 3.4 10.2 15 12 3.4 13.8z"))],
  wrapped: ["star", fill(p("M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"))],
  taste: ["people", PEOPLE],
  apps: ["apps", fill(p("M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z"))],
  pair: ["remote", fill(p("M15 9H9c-.55 0-1 .45-1 1v12c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V10c0-.55-.45-1-1-1zm-3 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM7.05 6.05l1.41 1.41C9.37 6.56 10.62 6 12 6s2.63.56 3.54 1.46l1.41-1.41C15.68 4.78 13.93 4 12 4s-3.68.78-4.95 2.05zM12 0C8.96 0 6.21 1.23 4.22 3.22l1.41 1.41C7.26 3.01 9.51 2 12 2s4.74 1.01 6.36 2.64l1.41-1.41C17.79 1.23 15.04 0 12 0z"))],
  party: ["people", PEOPLE], // (the app gives both lines the same two heads)
  // Children mode: a child's face (the app's `child`)
  children: ["child", fill(p(CHILD))],
  report: ["warning", fill(p("M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"))],
  settings: ["navGear", line(2, '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>')],
  // you: the person (drawn only when the bar has no avatar to show, which it always has)
  profile: ["person", fill(p("M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"))],
};
// Glyphs that point along the line of reading turn round when the page reads
// right to left (the app's MIRRORED set: of these, the paper plane).
export const MIRRORED = new Set(["household"]);

// The glyph of a menu line, or "" (a line without one is a defect the test catches).
export const navIcon = (id) => (NAV_ICONS[id] ? NAV_ICONS[id][1] : "");
