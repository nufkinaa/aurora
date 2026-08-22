// Aurora design tokens, transcribed from public/css/tokens.css.
//
// The values here are the PINNED ones (SPEC/99-open.md §A0.1), not the ones this
// file shipped before: eight of them disagreed with the spec, and P10 forbids
// quoting this file as corroboration for any of them — agreeing on one value out
// of a block that disagrees on three is not a check.
import { useWindowDimensions } from "react-native";
export const colors = {
  bg: "#0b0c14",
  bgRaised: "#131523",
  // rgba AS AUTHORED (tokens.css:22-24), not flattened to opaque hexes. The
  // flattening was a guess at what white-over-bg looks like, and it is wrong the
  // moment one of these sits over artwork rather than over the page — which is
  // most of the time, on a card or a hero.
  surface: "rgba(255,255,255,0.06)",
  surfaceHover: "rgba(255,255,255,0.11)",
  line: "rgba(255,255,255,0.09)",
  // tokens.css:25. One use site in the whole stylesheet — `.game-head`'s bar — at
  // its authored alpha. Findings ★2: it is not a panel fill and never sat under a
  // backdrop-filter, so it is NOT pushed to 0.92.
  glass: "rgba(13,14,24,0.72)",
  text: "#f3f4f8",
  textDim: "#9aa1b5",
  textFaint: "#616880",
  accent: "#8b7bff",
  accentStrong: "#6c58ff",
  progress: "#8b7bff",
  // --focus-ring is WHITE on the site (rgba(255,255,255,.95)); violet is used by
  // exactly one rule there, .btn-primary:focus. This was inverted for a while —
  // everything got violet — which is why the app read as "not the site". Light
  // fills keep the ring visible with a background-coloured gap instead of by
  // recolouring it (see Focusable's `light`).
  focusRing: "rgba(255,255,255,0.95)",
  star: "#f5c542",
  // Film vs series, on home's mixed rows. One warm and one cool, because warm
  // against cool is the difference the eye catches before it reads either word.
  kindFilm: "#f0c67e",
  kindSeries: "#7fd1e8",
  black: "#000000",
  white: "#ffffff",
};

export const radius = { s: 8, m: 12, l: 18, pill: 999 };

// The type scale, pinned. Reading-tier sizes are the site's own px taken at ×1.0
// with a 14dp floor — a TV is further away, but so is the whole page, and scaling
// type on its own is what made this app read as a zoomed web page.
//
//   hero  34  P9. `--fs-hero` is `clamp(2.4rem, 4.5vw, 4.2rem)` = 67.2px at the
//             1900px authoring width, and 4.5vw is a WIDTH clamp: 67.2/1900 x 960.
//             The 40 this file shipped came from applying RULE C on the height
//             axis against an authoring height that does not exist (00-tokens
//             finding 5).
//   title 26  P8 · tokens.css:77, used at screens.css:631 for movie and show
//             alike. The honest sensitivity range is 25-31dp (§F.1); 26 is its
//             conservative end.
//   row   20  `--fs-row: 1.25rem`.
//   body  16  `--fs-body: 1rem`.
//   small 14  `--fs-small: 0.85rem` = 13.6px, raised to the reading floor. P14:
//             `--text-faint` is 3.53:1 on `--bg`, below AA at any size, so
//             hierarchy is carried by COLOUR and nothing goes under 14.
export const fontSize = {
  hero: 34,
  title: 26,
  row: 20,
  body: 16,
  small: 14,
};

// pageX is the TV SAFE INSET, not the site's page gutter — P2. `--page-x` is
// `clamp(24px, 4.5vw, 64px)` = 64px at the authoring width, i.e. 3.37% of it,
// which re-expressed on a 960dp window is 32dp. The 5% action-safe inset the
// panel needs is 48dp horizontally, and it ABSORBS the gutter rather than
// stacking with it: both exist to keep content off the edge, and adding them is
// two solutions to one problem.
//
// pageY is the same 5% on the SHORT axis — 27dp on a 540dp panel.
//
// contentLeft is the rail (72) plus a 24dp gutter, per P1. Content starts AFTER
// the rail rather than sliding under it: the site's nav is a top bar that hides
// on scroll, and a permanently visible rail would cover whatever slid beneath it.
export const spacing = {
  xs: 4, sm: 8, md: 14, lg: 20, xl: 32,
  pageX: 48, pageY: 27, contentLeft: 96,
};

// The left rail (Deviation 1), PINS P1. 72dp collapsed — a 24dp icon centred in
// it leaves 24dp either side and 72 clears the 48dp focus minimum on both axes.
// 240dp expanded — 25% of a 960dp window, which holds "My List" at row type
// without truncation. Expanded draws OVER the page and never reflows it.
export const nav = { rail: 72, railOpen: 240 };

// Focus treatment shared by every focusable: a bright ring + scale-up, matching
// the web app's 10-foot focus cue.
export const focus = {
  borderWidth: 3,
  // components.css:255 — `transform: scale(1.055) translateY(-3px)` on `.card`.
  // This is the DEFAULT only; the site's focus scale is not one number, so every
  // element that differs passes its own `scaleTo` (§B row 55): `.profile-tile`
  // 1.07, `.source-dl` 1.03, a full-width `.episode` / `.source-row` 1.01.
  scale: 1.055,
  // How long the ring + scale take to settle. Was a hardcoded 60ms, which is
  // fast enough to read as an instant snap between rows rather than movement.
  // 160 is the site's own `--t-fast`, the token it uses for .pbtn and the card
  // shade; its cards animate transform over `--t-med` (280ms), which is too
  // slow to hold up when a D-pad direction is held down and the highlight has
  // to keep up with ~20 moves a second.
  duration: 160,
  // `--ease: cubic-bezier(0.2, 0.7, 0.2, 1)` from tokens.css — the curve every
  // transition on the site uses, so movement here has the same character.
  ease: [0.2, 0.7, 0.2, 1] as const,
  // Spring for the focus scale. Tuned to settle in roughly the same time as the
  // 160ms ring fade with a small overshoot — enough to read as momentum, not
  // enough to wobble when a D-pad direction is held and focus moves ~20x/second.
  spring: {tension: 180, friction: 14, restDisplacementThreshold: 0.001},
};

// --card-aura (tokens.css:64-67), as PINNED. Two layers and no more: the 2dp
// hairline white EDGE and the deep lift shadow under it, with the card rising 3dp
// toward you (components.css:255).
//
// `.card::before` — the blurred white silhouette, its grain mask and its
// opacity 0 -> 0.55 fade — is NOT ported (P6 / D2). So `--card-aura-reach` has no
// consumer left and is deliberately absent from this object: the only things that
// now reach past a card are the lift shadow and half the focus scale.
export const cardAura = {
  // tokens.css:65. A card's ring is 2dp at 0.9 — NOT the 3dp @ 0.95 --focus-ring
  // every other element takes. Card passes both to Focusable.
  edge: {width: 2, color: 'rgba(255,255,255,0.9)'},
  // tokens.css:66.
  shadow: '0 18px 36px rgba(0,0,0,0.6)',
  lift: 3,
};

// What a clipping container must leave around a focused card — P7 as amended / D4.
// ASYMMETRIC, because the treatment is: above = 5.1 of scale growth + 3 of lift +
// 18 of shadow reaching up + 2 of edge; below = 5.1 + 54 of shadow reaching down +
// 2. The 3dp lift is deliberately not credited back, so it is 61 and not 58.
//
// Horizontal is ZERO by design: a clipped DARK shadow on a dark ground is
// invisible, and the white halo that made horizontal clipping visible is gone.
//
// This is an UPPER BOUND, not a measurement (§F.4): three derivations give
// 28/61, ~11/39 and the 18/18 this file used to ship. The largest is pinned
// deliberately — over-provisioning costs vertical space, under-provisioning clips
// the focus treatment, and on a 540dp canvas a clipped ring is instantly visible
// where a slightly sparse shelf is not. Measure on the Streamer before reclaiming
// any of it (G.2).
export const CLEARANCE = {above: 28, below: 61};

// The margins that give the clearance back, so the page rhythm on screen is
// unchanged by however far the focus treatment reaches: net 5dp above / 8dp below,
// which is the site's own invariant (components.css:536-542, whose comment says it
// "nets out to the original 10px above / 16px below"; x0.505 -> 5/8).
//
// A plain View can carry these. A RECYCLED list cell cannot be relied on to
// (§F.4/G.1) — so vertical FlatLists spend the clearance as contentContainer
// padding with NO negative margins, and are that much taller. The inverse — keep
// the margins, shrink the padding — is forbidden: it is the one variant that
// clips the focus treatment.
export const CANCEL = {top: -23, bottom: -53};

export const motion = { fast: 160, med: 280 };

// TV layout space varies more than it looks. Measured: the Google TV Streamer
// lays out at 960x540 dp (1080p panel, density 320); other sets report
// 1280x720 dp. A dp size tuned on one is wrong on the other — the 460dp hero
// this app used to hardcode is 85% of a 540dp screen, so the nav + hero came to
// MORE than the whole screen and not one row was visible until you pressed
// down. Size the big blocks off the real window instead.
export const useTvMetrics = () => {
  const { width, height } = useWindowDimensions();
  // Android TV panels do not agree on a dp size. Measured: the Google TV
  // Streamer lays out at 960x540 (1080p at density 320); plenty of sets report
  // 1280x720, and some 4K sets 1920x1080. Every figure here is therefore a RATIO
  // of the real window, never a constant.
  const short = Math.min(width, height);
  return {
    width,
    height,
    // `.hero { min-height: 76vh }` — screens.css:4. 410dp on a 540dp panel.
    //
    // The app shipped 0.42 with a written "budget" arguing that a taller hero
    // leaves no room for shelves. That budget is void (RULES rule 13, SPEC
    // 99-open §I.3): it was reasoning about the OLD app, and the site's own
    // answer is that the shelves begin below the fold and you scroll to them.
    heroH: Math.round(height * 0.76),
    // screens.css:7 — `padding: 0 var(--page-x) 56px`, the gap under the lockup.
    heroPadBottom: 28,
    // PINS P9 / 00-tokens finding 5: `--fs-hero` is a 4.5vw WIDTH clamp, so it
    // re-expresses as a fraction of WIDTH — 67.2/1900 = 3.54%. 34dp @960.
    heroTitle: Math.round(width * 0.0354),
    // TV overscan: plenty of sets crop a few percent of every edge, and a row
    // flush to the viewport bottom would lose its focus ring off-screen.
    safeBottom: Math.max(20, Math.round(short * 0.05)),
    detailBackdrop: Math.round(height * 0.6),
  };
};

export default {
  colors, radius, fontSize, spacing, nav, focus, motion, cardAura, CLEARANCE, CANCEL,
};
