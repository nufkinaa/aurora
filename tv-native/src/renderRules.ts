// The rendering switches' rules — pure, no React Native (render.ts is the glue).
//
// The native lab (docs/qa/native-lab/) rebuilt five of the TV's drawing components
// natively and found a handful of render fixes; each one is a switch here. Since the
// 2026-10-17 Mi TV pass the measured set (RECOMMENDED) is the release default; a box with
// no AuroraRender module (an older APK) still draws exactly what the JS reference draws.
//
//   components  focusable  the focus ring + spring (AuroraFocusableView.kt)
//               card       a card's pictures, shades and blur-up (AuroraCardView.kt)
//               row        a shelf's slide (AuroraRowView.kt)
//               hero       the billboard art and Home's sliding column
//                          (AuroraHeroArtView.kt, AuroraSlideColumnView.kt)
//               rail       the nav rail's drawing and slide (AuroraRailPanelView.kt)
//   fixes       cardlayer  a card at rest is ONE hardware layer (needs focusable + card)
//               cull       shelves / cards wholly off screen are not drawn (needs row or hero)
//               shadowcache a box-shadow is blurred once into a layer (needs focusable)
//               unstuff    one vsync held back when the pipeline runs a frame behind
//                          (acts on the native components' animations)
//               unstuffq   the same, also for one queued buffer (a latency trade — not in
//                          the preset)
//               pool       a shelf hands the card views of cards that left its window to
//                          the cards that came in, instead of unmounting and mounting
//                          (needs row and card)
//   deeper      keyrate    a held D-pad key moves focus at a steady rate, at most once per
//   (native-deep)          frame, and never after the key is let go (MainActivity.kt,
//                          KeyRepeatGate.kt; works with every implementation)
//               cardtext   the native card draws its words, tags and progress bar itself:
//                          one view instead of a dozen (AuroraCardView.kt, ui/card/CardDecor*.kt;
//                          needs card)
//               ringshare  one focus ring per screen moves to the focused element instead
//                          of a ring (and its shadow) per Focusable (SharedRing.kt; needs focusable)
//               herotext   Home's billboard words (title, facts, synopsis) drawn by one native
//                          view, their text shadow recorded once (AuroraHeroTextView.kt)
//
// The "deeper" switches (docs/qa/native-deep/DEVICE-PLAN.md) were built offline after the
// lab. The Mi TV pass (2026-10-17, docs/qa/release-next/PASS-REPORT.md) put `ringshare`
// (0 px against the preset; RT and long frames down everywhere) and `herotext` (max 2/255,
// the layer's offset; RT down on S2/S3/S4) in the preset. `cardtext` and `keyrate` had made
// the Movies grid slightly worse; the 2026-10-19/20 pass (docs/qa/tv-smooth/REPORT.md) found
// why and fixed both — cardtext sent every grid poster the decor JSON twice and a dozen
// props it never drew, and its shared decor nodes came back empty after a shelf left the
// page; keyrate made its moves INSIDE the frame — and put both in the preset: 0 px in every
// deterministic state, and together within the A/A spread or better in every scenario
// (Home L1 frames > 32 ms 5–7 → 0, p99 31 → 25; Movies grid p90 22 → 19, frames > 32 ms
// 63–68 → 39; Shows grid p99 65–85 → 44; under load L1 23 → 3, G1 70 → 50).
//
// THE PRESET IS THE RELEASE DEFAULT (releaseDefault below): a box the server says nothing to
// runs it; the server's `tvRender` is the emergency lever to turn it, or one switch, off.
//
// Two places can say what a box runs with: the server (GET /api/tv/tuning → `tvRender`,
// from config.json — see src/lib/tvtuning.js) and the hidden developer setting
// (Settings → the version line, seven presses). Both are partial: a key either names a
// switch (true / false) or `recommended` (the preset). For each switch the developer
// setting wins over the server, an explicit switch wins over a preset, and anything
// nobody named follows the release default. Native reads the result ONCE at startup (AuroraRender.kt), so a
// change applies at the next launch.

export const COMPONENTS = ['focusable', 'card', 'row', 'hero', 'rail'] as const;
export const FIXES = ['cardlayer', 'cull', 'shadowcache', 'unstuff', 'unstuffq', 'pool', 'keyrate', 'cardtext', 'ringshare', 'herotext'] as const;
export type RenderComponent = (typeof COMPONENTS)[number];
export type RenderFix = (typeof FIXES)[number];
export type RenderKey = RenderComponent | RenderFix;
export const KEYS: readonly RenderKey[] = [...COMPONENTS, ...FIXES];

/** What the Mi TV measured best: all five components, cardlayer + cull + shadowcache +
 *  unstuff ("ccsu", lab 6-followup), the shelf pool (lab 7-card-recycling), ringshare and
 *  herotext (the 2026-10-17 device pass), keyrate and cardtext (the 2026-10-19/20 pass,
 *  docs/qa/tv-smooth/REPORT.md).
 *  In step with AuroraRender.kt RECOMMENDED (render-rules.test.ts reads that file). */
export const RECOMMENDED: readonly RenderKey[] = [
  'focusable',
  'card',
  'row',
  'hero',
  'rail',
  'cardlayer',
  'cull',
  'shadowcache',
  'unstuff',
  'pool',
  'keyrate',
  'cardtext',
  'ringshare',
  'herotext',
];

/** One source's say: any subset of the switches, and/or the preset. */
export type RenderSay = Partial<Record<RenderKey | 'recommended', boolean>>;

const isKey = (k: string): k is RenderKey => (KEYS as readonly string[]).includes(k);

/** PURE: whatever arrived (the server's JSON, a stored string) → a clean say. Unknown
 *  keys and non-boolean values are dropped; a non-object is "nothing said". */
export function sanitizeSay(raw: unknown): RenderSay {
  const out: RenderSay = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'boolean') continue;
    if (k === 'recommended' || isKey(k)) out[k] = v;
  }
  return out;
}

/** THE RELEASE DEFAULT (the Mi TV device pass, 2026-10-17: docs/qa/release-next/PASS-REPORT.md):
 *  what a box runs when neither the server nor the developer setting names a switch — the
 *  preset. The server stays the emergency lever: `"tvRender": {"recommended": false}` turns
 *  every switch off, `{"pool": false}` one of them (per model too).
 *  On a panel whose logical canvas is SCALED (src/canvas.tsx: not 960 dp wide) the two
 *  layer fixes are left out: a hardware layer there is drawn at the logical size and
 *  stretched (soft text on a resting card) and no such TV has been looked at yet
 *  (docs/qa/native-port/DEVICE-PLAN.md §5). A server that names them for a model wins. */
export function releaseDefault(canvasOneToOne: boolean): RenderSay {
  return canvasOneToOne ? {recommended: true} : {recommended: true, cardlayer: false, shadowcache: false};
}

/** PURE: the switches that are on, given the server's say and the developer's, over the
 *  release default (`base`, lowest precedence; {} = everything off, as before). */
export function resolveRender(server: RenderSay, local: RenderSay, base: RenderSay = {}): Set<RenderKey> {
  const preset = local.recommended ?? server.recommended ?? base.recommended ?? false;
  const on = new Set<RenderKey>();
  for (const k of KEYS) {
    const v = local[k] ?? server[k] ?? base[k] ?? (preset && RECOMMENDED.includes(k));
    if (v) on.add(k);
  }
  return on;
}

/** `focusable,card,cull` in KEYS order ('' when nothing is on) — what AuroraRender.kt stores. */
export const encodeRender = (on: Set<RenderKey>): string => KEYS.filter(k => on.has(k)).join(',');

/** The inverse of encodeRender (unknown words dropped). */
export const decodeRender = (s: string | null | undefined): Set<RenderKey> =>
  new Set(
    String(s || '')
      .split(',')
      .map(w => w.trim())
      .filter(isKey),
  );

/** Does `next` change anything a say holds? (so a server answering the same thing writes nothing) */
export const sameSay = (a: RenderSay, b: RenderSay): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k as keyof RenderSay] === b[k as keyof RenderSay]);
};

/** The developer setting's three positions for one switch: follow the server, on, off. */
export type Tri = 'server' | 'on' | 'off';
export const triOf = (say: RenderSay, k: RenderKey | 'recommended'): Tri =>
  say[k] === true ? 'on' : say[k] === false ? 'off' : 'server';
/** The next position (server → on → off → server), applied to a copy of `say`. */
export function cycleTri(say: RenderSay, k: RenderKey | 'recommended'): RenderSay {
  const next = {...say};
  const t = triOf(say, k);
  if (t === 'server') next[k] = true;
  else if (t === 'on') next[k] = false;
  else delete next[k];
  return next;
}

/** A switch that is on but cannot act because what it works through is off — said in the
 *  developer setting, never enforced (each one is simply inert then). */
export function inertBecause(on: Set<RenderKey>, k: RenderKey): string | null {
  if (!on.has(k)) return null;
  // (a card is recognised by its native picture view: AuroraFocusableView.onViewAdded)
  if (k === 'cardlayer' && !(on.has('focusable') && on.has('card'))) return 'needs focusable and card';
  if (k === 'shadowcache' && !on.has('focusable')) return 'needs focusable';
  if (k === 'cull' && !on.has('row') && !on.has('hero')) return 'needs row or hero';
  if (k === 'pool' && !(on.has('row') && on.has('card'))) return 'needs row and card';
  if ((k === 'unstuff' || k === 'unstuffq') && !COMPONENTS.some(c => on.has(c))) return 'needs a native component';
  if (k === 'cardtext' && !on.has('card')) return 'needs card';
  if (k === 'ringshare' && !on.has('focusable')) return 'needs focusable';
  return null;
}
