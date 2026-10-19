// HOW SUBTITLES LOOK — one set of choices for the website and the TV, kept on
// the PERSON (their profile's `prefs`, synced to every device). PURE — no
// imports: test/player-options.test.js runs it as it is, and holds this table,
// the TV's (tv-native/src/subStyle.ts) and the server's (src/profiles.js
// PLAYER_OPTIONS) together.
//
//   subSize     S | M | L | XL                          default M
//   subColor    white | yellow | cyan | green           default white
//   subBg       none | shadow | outline | box           default box
//   subOpacity  25 | 50 | 75 | 100  (the box only)      default 75
//   subWeight   normal | bold                           default bold
//   subPos      lower | raised                          default lower
//
// The subtitle DELAY (the timing buttons) is not one of these: it is kept per
// title and track on the device (subdelay.js), because the delay that fixes
// one file is wrong for the next.
//
// Until 2026-10-19 the site had two device-only keys, `cueSize` (S/M/L) and
// `cueBackground` (on/off), in this browser's "aurora-player" settings, and the
// TV the same two in its box prefs. `styleFromDevice` turns those into the
// person's choices the first time a person is seen after the update.
export const SUB_STYLE_DEFAULTS = {
  subSize: "M",
  subColor: "white",
  subBg: "box",
  subOpacity: 75,
  subWeight: "bold",
  subPos: "lower",
};
export const SUB_STYLE_KEYS = Object.keys(SUB_STYLE_DEFAULTS);
export const SUB_STYLE_CHOICES = {
  subSize: ["S", "M", "L", "XL"],
  subColor: ["white", "yellow", "cyan", "green"],
  subBg: ["none", "shadow", "outline", "box"],
  subOpacity: [25, 50, 75, 100],
  subWeight: ["normal", "bold"],
  subPos: ["lower", "raised"],
};
// The words, the same on both platforms.
export const SUB_STYLE_NAMES = {
  subSize: "Size",
  subColor: "Text colour",
  subBg: "Background",
  subOpacity: "Box opacity",
  subWeight: "Text weight",
  subPos: "Position",
};
export const SUB_STYLE_LABELS = {
  subSize: { S: "Small", M: "Medium", L: "Large", XL: "Extra large" },
  subColor: { white: "White", yellow: "Yellow", cyan: "Cyan", green: "Green" },
  subBg: { none: "None", shadow: "Shadow", outline: "Outline", box: "Box" },
  subOpacity: { 25: "25%", 50: "50%", 75: "75%", 100: "100%" },
  subWeight: { normal: "Regular", bold: "Bold" },
  subPos: { lower: "Lower", raised: "Raised" },
};
// Settings' rows (the player's menu uses SUB_STYLE_NAMES): label and note.
export const SUB_STYLE_SETTINGS = {
  subSize: ["Subtitle size", null],
  subColor: ["Text colour", null],
  subBg: ["Background", "Shadow and outline keep the text readable without a box."],
  subOpacity: ["Box opacity", "How dark the box is."],
  subWeight: ["Text weight", null],
  subPos: ["Position", "Raised keeps them clear of words burnt into the picture."],
};
export const SUB_COLORS = { white: "#ffffff", yellow: "#ffe14d", cyan: "#5ee7ff", green: "#7dff8f" };

const valid = (k, v) => SUB_STYLE_CHOICES[k] && SUB_STYLE_CHOICES[k].includes(v);

// The full style out of anything (a profile's prefs, this browser's settings):
// every key present, each a real choice.
export const readStyle = (from) => {
  const src = from && typeof from === "object" ? from : {};
  const out = {};
  for (const k of SUB_STYLE_KEYS) out[k] = valid(k, src[k]) ? src[k] : SUB_STYLE_DEFAULTS[k];
  return out;
};

// The choice after `cur` (a press on a settings row steps through them).
export const nextChoice = (key, cur) => {
  const list = SUB_STYLE_CHOICES[key] || [];
  const i = list.indexOf(cur);
  return list[(i + 1) % list.length];
};

// The label for a key's current value.
export const styleLabel = (key, style) => (SUB_STYLE_LABELS[key] || {})[readStyle(style)[key]] || "";

// THE ONE-TIME MOVE of a device's old choices. Only real choices count (what
// differs from the default); `platform` because the old "background off" was
// drawn differently: the site showed bare text, the TV a drop shadow.
export const styleFromDevice = (local, platform = "web") => {
  const out = {};
  if (!local || typeof local !== "object") return out;
  if (["S", "L"].includes(local.cueSize)) out.subSize = local.cueSize;
  if (local.cueBackground === false) out.subBg = platform === "tv" ? "shadow" : "none";
  return out;
};

// ---- drawing (the site: ::cue and the previews) ----
// Font size per step: a share of the window's width, never under a floor (on a
// phone held upright 2.2vw is 8.6 px — unreadable).
export const CUE_VW = { S: 1.4, M: 2.2, L: 3.2, XL: 4.2 };
export const CUE_MIN_PX = { S: 12, M: 15, L: 19, XL: 23 };

// text-shadow for a background choice ("none" when there is none)
export const cueShadow = (style) => {
  const s = readStyle(style);
  if (s.subBg === "shadow") return "0 0.08em 0.25em rgba(0,0,0,0.95), 0 0 0.12em rgba(0,0,0,0.9)";
  if (s.subBg === "outline") {
    const w = "0.07em";
    const n = `-${w}`;
    return [`${n} ${n}`, `${w} ${n}`, `${n} ${w}`, `${w} ${w}`, `0 ${w}`, `0 ${n}`, `${w} 0`, `${n} 0`].map((o) => `${o} 0 #000`).join(", ");
  }
  return "none";
};
export const cueBackdrop = (style) => {
  const s = readStyle(style);
  return s.subBg === "box" ? `rgba(0, 0, 0, ${s.subOpacity / 100})` : "transparent";
};

// The ::cue rule for a style. `size` is the CSS font size to use.
export const cueCss = (style, size) => {
  const s = readStyle(style);
  return (
    `video::cue { font-size: ${size}; color: ${SUB_COLORS[s.subColor]}; ` +
    `background: ${cueBackdrop(s)}; text-shadow: ${cueShadow(s)}; ` +
    `font-weight: ${s.subWeight === "bold" ? 700 : 400}; font-family: inherit; line-height: 1.4; }`
  );
};

// ---- where the cue sits ----
// "lower" is the browser's own place (the foot of the picture); "raised" puts
// the cue's bottom edge this far down the picture, clear of burnt-in text and
// a TV's overscan. With the controls up, the cue goes above them whichever is
// higher (player.js liftLine).
export const RAISED_PCT = 80;
