// "Has the remote come to rest?" — answered once, for everything that waits
// for it.
//
// SETTLE, THEN ENRICH. A focus move has to cost what the move itself needs —
// the slide, the ring, the one card the window mounts — and nothing else.
// Everything that makes the place focus landed on RICHER (the title page's
// data, the next pictures, the billboard's trailer, a heavier layer of the
// hero) can wait until the viewer has stopped, and should not happen at all
// if they did not. Each of those used to keep its own timer, restarted from
// its own focus handler; a move that went through a different handler (a hero
// button, the rail) did not restart them, and each handler paid a clearTimeout
// + setTimeout per press.
//
// One clock now. focus.ts tells it about every focus move (`noteMove` — a
// timestamp, nothing else: no timer is touched on a press). Work that wants
// rest asks with `whenSettled(fn, ms)`: fn runs once, when no focus move has
// happened for `ms` — counted from the later of the last move and the ask —
// and the returned function withdraws it. A move in the meantime pushes it
// back; nothing runs during a run of presses, however long.
//
// The timer is lazy: it is set for the earliest moment something COULD be
// due, and when it fires it runs what is due and re-arms for the rest. During
// a held key that is one timer every `ms`, instead of several per press.
//
// `onMove` is for work that has already started and can still be dropped (a
// queue of fetches not yet sent).

/** The default rest: long enough that a held key (a move every 50–110 ms) and
 *  a deliberate walk (a press every ~200 ms) never trigger it, short enough
 *  that it is over before the eye has finished reading where it landed. */
export const SETTLE_MS = 300;

type Entry = {fn: () => void; ms: number; at: number};
const waiting = new Set<Entry>();
const moveFns = new Set<() => void>();
let lastMove = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerDue = 0;

const dueAt = (e: Entry) => Math.max(lastMove, e.at) + e.ms;

const arm = () => {
  if (!waiting.size) return;
  let next = Infinity;
  for (const e of waiting) next = Math.min(next, dueAt(e));
  if (timer && timerDue <= next) return; // fires early enough; it re-arms itself
  if (timer) clearTimeout(timer);
  timerDue = next;
  timer = setTimeout(tick, Math.max(0, next - Date.now()));
};

function tick() {
  timer = null;
  const now = Date.now();
  // (a copy: an fn may ask again, or withdraw another)
  for (const e of [...waiting]) {
    if (!waiting.has(e) || dueAt(e) > now) continue;
    waiting.delete(e);
    try {
      e.fn();
    } catch {}
  }
  arm();
}

/** A focus move happened (focus.ts). Cheap by construction: called on every
 *  press of a held key. */
export function noteMove() {
  lastMove = Date.now();
  if (moveFns.size) for (const fn of moveFns) fn();
}

/** True when no focus move has happened for `ms`. */
export const isSettled = (ms = SETTLE_MS) => Date.now() - lastMove >= ms;

/** Run `fn` once, when focus has been at rest for `ms` (counted from now or
 *  from the last move, whichever is later). Returns the way to withdraw it. */
export function whenSettled(fn: () => void, ms = SETTLE_MS): () => void {
  const e: Entry = {fn, ms, at: Date.now()};
  waiting.add(e);
  arm();
  return () => {
    waiting.delete(e);
  };
}

/** Hear every focus move — for dropping work that had not started. Keep it
 *  to a line: this runs on the input path. */
export function onMove(fn: () => void): () => void {
  moveFns.add(fn);
  return () => {
    moveFns.delete(fn);
  };
}

/** Test-only. */
export const _settleInternals = {
  reset: () => {
    if (timer) clearTimeout(timer);
    timer = null;
    timerDue = 0;
    lastMove = 0;
    waiting.clear();
  },
  waiting: () => waiting.size,
  armed: () => !!timer,
};
