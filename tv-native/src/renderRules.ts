// The rendering switches' rules — pure, no React Native (render.ts is the glue).
//
// The native lab (docs/qa/native-lab/) rebuilt five of the TV's drawing components
// natively and found a handful of render fixes; each one is a switch here, and
// EVERY ONE IS OFF unless something turns it on, so a box that never hears of
// them draws exactly what the JS reference draws.
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
//
// The "deeper" switches (docs/qa/native-deep/DEVICE-PLAN.md) were built offline after the
// lab and are NOT in the preset: none of them has run on a TV yet.
//
// Two places can say what a box runs with: the server (GET /api/tv/tuning → `tvRender`,
// from config.json — see src/lib/tvtuning.js) and the hidden developer setting
// (Settings → the version line, seven presses). Both are partial: a key either names a
// switch (true / false) or `recommended` (the preset). For each switch the developer
// setting wins over the server, an explicit switch wins over a preset, and anything
// nobody named is off. Native reads the result ONCE at startup (AuroraRender.kt), so a
// change applies at the next launch.

export const COMPONENTS = ['focusable', 'card', 'row', 'hero', 'rail'] as const;
export const FIXES = ['cardlayer', 'cull', 'shadowcache', 'unstuff', 'unstuffq', 'pool', 'keyrate'] as const;
export type RenderComponent = (typeof COMPONENTS)[number];
export type RenderFix = (typeof FIXES)[number];
export type RenderKey = RenderComponent | RenderFix;
export const KEYS: readonly RenderKey[] = [...COMPONENTS, ...FIXES];

/** What the lab measured best on the Mi TV: all five components, cardlayer + cull +
 *  shadowcache + unstuff ("ccsu", 6-followup) and the shelf pool (7-card-recycling).
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

/** PURE: the switches that are on, given the server's say and the developer's. */
export function resolveRender(server: RenderSay, local: RenderSay): Set<RenderKey> {
  const preset = local.recommended ?? server.recommended ?? false;
  const on = new Set<RenderKey>();
  for (const k of KEYS) {
    const v = local[k] ?? server[k] ?? (preset && RECOMMENDED.includes(k));
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
  return null;
}
