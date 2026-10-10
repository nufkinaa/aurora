// Pictures, before the cards that draw them exist.
//
// A shelf mounts a card a press or two before it can be seen (rowWindow.ts),
// which is enough for a picture the box already has and not always enough for
// one it has to fetch. So while the remote is at rest, the pictures of the
// cards just BEYOND what is mounted — further along the focused shelf, the
// first cards of the shelves below the mounted ones, the next rows of a grid —
// are fetched and decoded into the image pipeline's memory cache. A card that
// then mounts finds its picture there and draws it in its first frame.
//
//  • SAME ADDRESS, SAME HEADERS as the card (cardArt.ts prefetchable → the
//    ImgSource the card's <Image> is given). The caches are keyed by address,
//    so a different `?w=` would warm nothing; without the session headers a
//    sign-in-required server answers 401. React Native's Image.prefetch takes
//    no headers and stops at the disk cache — hence the native module
//    (android ArtPrefetchModule.kt, which also says why the keys match).
//  • AT REST ONLY. The wait is the app's one "at rest" clock (settle.ts):
//    IDLE_MS with no focus move anywhere; a held key never starts a fetch,
//    and ANY move drops whatever had not started yet.
//  • BOUNDED. A few pictures per rest, a few requests at a time, fewer on a
//    slow or low-memory box (limits()). These are ~15–25 KB each at card
//    size, so even the full plan is well under a megabyte of line.
import {NativeModules} from 'react-native';
import type {ImgSource} from './api';
import {markDrawn, wasDrawn} from './blur';
import {isLite, isLowRam} from './perfTier';
import {onMove, whenSettled} from './settle';

type Native = {prefetch: (uri: string, headers: Record<string, string> | null) => Promise<'hit' | 'ok' | 'fail'>};
let native: Native | undefined = (NativeModules as {AuroraArt?: Native}).AuroraArt;

/** No focus move for this long = the remote is at rest. (The Detail warm
 *  waits 450 ms; this is shorter because it is cheaper and a pause between
 *  two bursts along a shelf is exactly when it pays.) */
export const IDLE_MS = 300;

export type ArtLimits = {
  /** Cards beyond the mounted window, along the focused shelf. */
  row: number;
  /** Shelves below the mounted ones whose first cards are fetched. */
  shelves: number;
  /** Grid rows beyond the ones the list has rendered. */
  gridRows: number;
  /** Pictures per rest, all told. */
  total: number;
  /** Requests at once. */
  flying: number;
};
// Decoded, a poster is ~0.4 MB at 1080p (256 × 384 × 4) and a Continue
// Watching picture ~0.9 MB: the full plan is at most ~8 MB of evictable cache.
export const LIMITS: ArtLimits = {row: 6, shelves: 2, gridRows: 2, total: 20, flying: 4};
// A slow box (lite): the decodes share its cores with the UI — fewer, two at a time.
export const LIMITS_LITE: ArtLimits = {row: 4, shelves: 1, gridRows: 1, total: 10, flying: 2};
// Short of memory: the next few cards of this shelf only.
export const LIMITS_LOW: ArtLimits = {row: 2, shelves: 0, gridRows: 0, total: 4, flying: 1};
export const limits = (): ArtLimits => (isLowRam() ? LIMITS_LOW : isLite() ? LIMITS_LITE : LIMITS);

/** What to fetch: in order, each address once, nothing this run already has,
 *  at most `max`. Pure. */
export function planPrefetch(
  sources: (ImgSource | null | undefined)[],
  known: (uri: string) => boolean,
  max: number,
): ImgSource[] {
  const out: ImgSource[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    if (out.length >= max) break;
    if (!s || !s.uri || seen.has(s.uri) || known(s.uri)) continue;
    seen.add(s.uri);
    out.push(s);
  }
  return out;
}

// One wish per place that has one (the focused shelf, Home's shelves below,
// a grid); each is a function, so nothing is computed until the rest comes.
const wants = new Map<string, () => (ImgSource | null | undefined)[]>();
// (the way to withdraw the pending rest, settle.ts)
let timer: (() => void) | null = null;
let queue: ImgSource[] = [];
let flying = 0;
// Asked for and not failed (so a rest does not ask twice while one is in flight).
const asked = new Set<string>();
let batch = {n: 0, hit: 0, ok: 0, fail: 0, t0: 0};

const pump = () => {
  const max = limits().flying;
  while (native && flying < max && queue.length) {
    const s = queue.shift()!;
    flying++;
    const b = batch;
    native
      .prefetch(s.uri, s.headers || null)
      .then(
        r => r,
        () => 'fail' as const,
      )
      .then(r => {
        flying--;
        b[r === 'hit' || r === 'ok' ? r : 'fail']++;
        // In the cache: a card that mounts now draws it at once, so it skips
        // the blur-up placeholder (blur.ts wasDrawn), as for any picture this
        // run has drawn before.
        if (r === 'fail') asked.delete(s.uri);
        else markDrawn(s.uri);
        if (b.hit + b.ok + b.fail === b.n) {
          // One quiet line per rest (adb logcat -s ReactNativeJS | grep "\[art\]").
          console.log(`[art] prefetch n=${b.n} hit=${b.hit} ok=${b.ok} fail=${b.fail} ms=${Date.now() - b.t0}`);
        }
        pump();
      });
  }
};

const fire = () => {
  timer = null;
  if (!native) return;
  const all: (ImgSource | null | undefined)[] = [];
  for (const f of wants.values()) {
    try {
      all.push(...f());
    } catch {}
  }
  if (asked.size > 3000) asked.clear();
  const plan = planPrefetch(all, u => asked.has(u) || wasDrawn(u), limits().total);
  if (!plan.length) return;
  for (const s of plan) asked.add(s.uri);
  // (what an interrupted rest left unstarted was un-asked in artIdle)
  queue = plan;
  batch = {n: plan.length, hit: 0, ok: 0, fail: 0, t0: Date.now()};
  pump();
};

// What a rest had queued and not started is dropped by the next move.
const dropQueued = () => {
  if (!queue.length) return;
  for (const s of queue) asked.delete(s.uri);
  batch.n -= queue.length;
  queue = [];
};
// Any focus move — also one that did not come through artIdle (a hero button,
// the rail): a fetch that has not started does not start during a move. (The
// few already in flight finish: at most `flying` small pictures.)
onMove(dropQueued);

/** Focus moved. `slot` now wants these pictures when the remote next rests;
 *  whatever an earlier rest had queued and not started is dropped. */
export function artIdle(slot: string, sources: () => (ImgSource | null | undefined)[]) {
  if (!native) return;
  wants.set(slot, sources);
  dropQueued();
  // (two shelves' handlers call this for one press: the second finds the
  // rest already asked for at this very moment and leaves it)
  const now = Date.now();
  if (timer && askedAt === now) return;
  timer?.();
  askedAt = now;
  timer = whenSettled(fire, IDLE_MS);
}
let askedAt = 0;

/** A place stops wishing (its screen went away). */
export function artForget(slot: string) {
  wants.delete(slot);
}

export const _artInternals = {
  setNative: (n: Native | undefined) => {
    native = n;
  },
  reset: () => {
    timer?.();
    timer = null;
    askedAt = 0;
    wants.clear();
    queue = [];
    flying = 0;
    asked.clear();
  },
  flying: () => flying,
  queued: () => queue.length,
};
