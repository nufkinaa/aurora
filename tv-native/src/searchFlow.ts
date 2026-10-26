// One search, step by step. PURE — no imports.
// public/js/searchflow.js is this file without the types; the root test
// test/search-flow.test.js runs both through the same assertions. Change one,
// change both.
//
//   1. what the server has in memory, at once (the library, the cached
//      catalogue) — painted
//   2. when the server says more is coming (`pending`): the waiting ask, for
//      the live catalogue. The local cards stay on screen with "Searching
//      the catalogue…", which becomes "Still searching…" when it takes long.
//   3. when the catalogue could not answer (`catalogFailed` — it was slow or
//      down; media/search.js) or the ask itself failed: "Still searching…",
//      a short pause, and ONE more ask. The catalogue's late answer is kept
//      on the server (lib/upstream.js), so this is usually the one that finds
//      it.
//   4. settled: the cards, or what to say — and a failure is said as a
//      failure ("Couldn't reach the catalogue — try again", with a button),
//      never as "No results" (2026-10-26: "La Cocina" said "not found" until
//      Search was left and opened again).

export const RETRY_AFTER_MS = 1500; // the pause before the one retry
export const STILL_AFTER_MS = 3000; // "Searching the catalogue…" → "Still searching…"

export const SEARCH_TEXT = {
  searching: 'Searching…',
  catalogue: 'Searching the catalogue…',
  still: 'Still searching…',
  unreachable: "Couldn't reach the catalogue — try again",
  partial: "Couldn't reach the catalogue — there may be more.",
  offline: "Couldn't reach the server — check the connection and try again.",
  retry: 'Try again',
};
export const noResultsText = (q: string) => `No results for “${q}”`;
export const shortText = (q: string) => `Nothing in the library for “${q}”.`;

export type FlowAnswer = {
  results?: Array<{key?: string}>;
  related?: unknown[];
  pending?: boolean;
  catalogFailed?: boolean;
};
export type SettleNote = null | 'offline' | 'unreachable' | 'partial' | 'short' | 'none';

const hits = (r: FlowAnswer | null) => !!r && ((r.results || []).length > 0 || (r.related || []).length > 0);

// What the screen says once a search has settled:
//   null           the cards say it all
//   "offline"      the server itself did not answer
//   "unreachable"  nothing found, and the catalogue could not be asked
//   "partial"      cards, but the catalogue could not be asked: there may be more
//   "short"        nothing in the library, and the catalogue is not asked yet
//                  for so few letters while typing
//   "none"         a real "No results"
export const settleNote = ({
  answer,
  failed = false,
  offline = false,
  committed = false,
  q = '',
  minLen = 3,
}: {
  answer: FlowAnswer | null;
  failed?: boolean;
  offline?: boolean;
  committed?: boolean;
  q?: string;
  minLen?: number;
}): SettleNote => {
  if (offline || !answer) return 'offline';
  if (failed) return hits(answer) ? 'partial' : 'unreachable';
  if (hits(answer)) return null;
  return !committed && String(q).length < minLen ? 'short' : 'none';
};

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// runSearch(steps) → { answer, note, failed } once settled, or null when the
// search is no longer the one on screen (`live()` false) — then nothing more
// is painted or said.
//   ask({ wait, pin })   the server's search; throws when the request fails
//   paint(answer, step)  step: "local" | "catalogue"
//   busy(text | null)    the line under the cards
//   live()               still this search?
export const runSearch = async <A extends FlowAnswer>({
  ask,
  paint,
  busy,
  live,
  committed = false,
  q = '',
  minLen = 3,
  retryAfterMs = RETRY_AFTER_MS,
  stillAfterMs = STILL_AFTER_MS,
  sleep = pause,
}: {
  ask: (o: {wait: boolean; pin: string | null}) => Promise<A>;
  paint: (answer: A, step: 'local' | 'catalogue') => void;
  busy: (text: string | null) => void;
  live: () => boolean;
  committed?: boolean;
  q?: string;
  minLen?: number;
  retryAfterMs?: number;
  stillAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{answer: A | null; note: SettleNote; failed: boolean} | null> => {
  busy(SEARCH_TEXT.searching);
  let r: A | null = null;
  try {
    r = await ask({wait: false, pin: null});
  } catch {
    if (!live()) return null;
    busy(null);
    return {answer: null, note: 'offline', failed: true};
  }
  if (!live()) return null;
  paint(r, 'local');
  let failed = false;
  if (r && r.pending) {
    busy(hits(r) ? SEARCH_TEXT.catalogue : SEARCH_TEXT.searching);
    const still = setTimeout(() => {
      if (live()) busy(SEARCH_TEXT.still);
    }, stillAfterMs);
    try {
      for (let attempt = 0; ; attempt++) {
        let bad = false;
        let next: A | null = null;
        const cur: A = r;
        const pin = cur.results && cur.results[0] ? cur.results[0].key || null : null;
        try {
          next = await ask({wait: true, pin});
        } catch {
          bad = true;
        }
        if (!live()) return null;
        if (next) {
          r = next;
          paint(next, 'catalogue');
          bad = !!next.catalogFailed;
        }
        if (!bad || attempt >= 1) {
          failed = bad;
          break;
        }
        busy(SEARCH_TEXT.still);
        await sleep(retryAfterMs);
        if (!live()) return null;
      }
    } finally {
      clearTimeout(still);
    }
  }
  busy(null);
  return {answer: r, note: settleNote({answer: r, failed, committed, q, minLen}), failed};
};
