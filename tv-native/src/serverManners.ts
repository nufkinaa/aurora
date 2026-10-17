// HOW THIS APP BEHAVES TOWARDS A SERVER THAT MANY DEVICES SHARE — the rules of
// docs/operations.md, "What a client should do", as plain functions. Nothing
// here touches the network, a timer of its own or React: the callers (api.ts,
// realtime.ts, the player) hand in what they have, and
// __tests__/logic/server-manners.test.ts checks every rule.
//
//   - the library changed: read again after a RANDOM wait (so a hundred
//     devices do not ask in the same millisecond) — a blink when Home is on
//     the screen, half a second to five otherwise; one read however many
//     messages came; none while a film plays or the app is not looked at;
//   - 429: wait Retry-After plus a random 0–1.5 s, ask again, twice at most;
//   - the socket: a doubling wait with jitter (half to all of it); after the
//     server said it is restarting, its `retryInMs` plus a random 0–3 s;
//   - 503 on a stream (the encoder budget is full): wait Retry-After (5 s at
//     most) and ask again, three times at most.
//
// No imports: every module may import this one.

type Rnd = () => number;

/** PURE: a Retry-After header (seconds) as milliseconds, within [0, capMs];
 *  `fallbackMs` when it is missing or not a number of seconds. */
export const retryAfterMs = (header: string | null | undefined, fallbackMs: number, capMs: number): number => {
  const n = header == null || String(header).trim() === '' ? NaN : Number(header);
  const ms = isFinite(n) && n >= 0 ? n * 1000 : fallbackMs;
  return Math.max(0, Math.min(capMs, Math.round(ms)));
};

// ---- 429: too many requests at once --------------------------------------
export const TOO_MANY_RETRIES = 2;
/** The longest Retry-After worth waiting out inside a request. A sign-in
 *  limiter's "try again in ten minutes" is an answer, not a pause. */
export const TOO_MANY_MAX_WAIT_S = 10;

/** PURE: how long to wait before asking again after a 429 — or null: the 429
 *  is the answer. Only a READ is asked again (a write may have been a person's
 *  sign-in attempt, and its 429 is the limiter saying no), only when the
 *  server said when (Retry-After), and twice at most. */
export const tooManyWait = (
  method: string | undefined,
  retriesSoFar: number,
  retryAfter: string | null | undefined,
  rnd: Rnd = Math.random,
): number | null => {
  if (String(method || 'GET').toUpperCase() !== 'GET') return null;
  if (retriesSoFar >= TOO_MANY_RETRIES) return null;
  const s = retryAfter == null || String(retryAfter).trim() === '' ? NaN : Number(retryAfter);
  if (!isFinite(s) || s < 0 || s > TOO_MANY_MAX_WAIT_S) return null;
  return Math.round(s * 1000 + rnd() * 1500);
};

// ---- the library changed --------------------------------------------------
/** PURE: the wait before the one re-read. */
export const libraryRefreshDelay = (homeOnScreen: boolean, rnd: Rnd = Math.random): number =>
  Math.round(homeOnScreen ? rnd() * 300 : 500 + rnd() * 4500);

type Timer = ReturnType<typeof setTimeout>;
export type RefresherDeps = {
  setTimeout: (fn: () => void, ms: number) => Timer;
  clearTimeout: (t: Timer) => void;
  rnd: Rnd;
  /** Is Home the screen being looked at? */
  homeOnScreen: () => boolean;
  /** Is a film playing, or the app not in front? Then nothing is read now. */
  held: () => boolean;
  /** Tell the screens (once). */
  deliver: () => void;
};

/** One pending refresh, whatever arrives. `changed()` on every
 *  library_updated; `release()` when what held it is over (the player was
 *  left, the app is in front again); `cancel()` when the session ends. */
export const createRefresher = (d: RefresherDeps) => {
  let timer: Timer | null = null;
  let stale = false; // a change arrived while held: owed one refresh
  const fire = () => {
    timer = null;
    if (d.held()) {
      stale = true;
      return;
    }
    d.deliver();
  };
  const changed = () => {
    if (d.held()) {
      stale = true;
      return;
    }
    if (timer) return;
    timer = d.setTimeout(fire, libraryRefreshDelay(d.homeOnScreen(), d.rnd));
  };
  return {
    changed,
    release: () => {
      if (!stale || d.held()) return;
      stale = false;
      changed();
    },
    cancel: () => {
      if (timer) d.clearTimeout(timer);
      timer = null;
      stale = false;
    },
    /** Test-only. */
    state: () => ({pending: !!timer, stale}),
  };
};

// ---- the socket -------------------------------------------------------------
export const RECONNECT_FIRST_MS = 1000;
export const RECONNECT_MAX_MS = 30000;
/** PURE: the wait before a reconnect — a random part of the step, between
 *  half of it and all of it. */
export const reconnectWait = (stepMs: number, rnd: Rnd = Math.random): number =>
  Math.round(stepMs * (0.5 + 0.5 * rnd()));
/** PURE: the next step (doubling, 30 s at most). */
export const nextReconnectStep = (stepMs: number): number => Math.min(stepMs * 2, RECONNECT_MAX_MS);
/** PURE: the wait before the FIRST try after the server said it is restarting
 *  (`server_restarting`, then close code 1012): what it asked for — within
 *  reason — plus a random 0–3 s. */
export const restartWait = (retryInMs: unknown, rnd: Rnd = Math.random): number => {
  const asked = typeof retryInMs === 'number' && isFinite(retryInMs) && retryInMs >= 0 ? Math.min(retryInMs, 60000) : 2000;
  return Math.round(asked + rnd() * 3000);
};
/** After an announced restart, this many failed tries are the restart itself
 *  and not an outage: nothing is reported, nobody is told. */
export const RESTART_QUIET_TRIES = 4;

// ---- 503 on a stream: the encoder budget is full -------------------------
export const BUSY_TRIES = 3;
export const BUSY_MAX_WAIT_MS = 5000;
export const SERVER_BUSY = 'The server is busy with other streams right now. Try again in a moment.';

export type BusyAnswer = {status: number; retryAfter?: string | null};
export type BusyOutcome =
  /** the server took the request (or answered something that is not "busy" — the caller's usual handling applies) */
  | {kind: 'answered'; status: number; waited: number}
  /** still busy after every try */
  | {kind: 'busy'; waited: number}
  /** the request itself failed (the line, a timeout): not a busy server */
  | {kind: 'failed'; waited: number}
  /** the viewer left, or asked for something else, while waiting */
  | {kind: 'gone'; waited: number};

/** PURE: must a start hear the server's answer BEFORE the player is handed
 *  the source? For an ENCODE that has not played yet: yes. ExoPlayer reads a
 *  refused playlist again by itself (react-native-video's load-error policy,
 *  minLoadRetryCount 50, a second or so apart) and reports only "Source
 *  error", so with both asking at once it was a race whether the app's wait
 *  (whenRoom) or ExoPlayer's own retries met the refusal — the busy path was
 *  never seen working on a TV. The claim going first makes it one answer,
 *  read here, every time. A COPY is never refused (the budget counts only
 *  encoders), so it keeps the quicker start: both at once. Once something has
 *  played, a source change keeps the old rule too (nothing to hold back: the
 *  picture that was playing stays until the new one is up). */
export const claimFirst = (v: string, everPlayed: boolean): boolean => v !== 'copy' && !everPlayed;
/** PURE: what a start that asked first does with the answer — hand the
 *  player its source ('play': room, or an answer that is not "busy", or a
 *  claim that failed on the line, where the player's own read is the next
 *  best judge), say so ('busy': no room after every try), or nothing ('gone':
 *  the viewer left or asked for something else meanwhile). */
export const afterClaim = (o: BusyOutcome): 'play' | 'busy' | 'none' =>
  o.kind === 'gone' ? 'none' : o.kind === 'busy' ? 'busy' : 'play';

/** Ask; while the answer is 503, wait what the server says (5 s at most) and
 *  ask again — BUSY_TRIES more times, then stop. Never loops: at most
 *  1 + BUSY_TRIES requests and BUSY_TRIES waits. `waited` counts the waits
 *  (0 = the first answer was not "busy"). */
export const whenRoom = async (
  ask: () => Promise<BusyAnswer>,
  o: {sleep: (ms: number) => Promise<void>; alive: () => boolean; onWait?: (ms: number, n: number) => void},
): Promise<BusyOutcome> => {
  let waited = 0;
  for (;;) {
    let a: BusyAnswer;
    try {
      a = await ask();
    } catch {
      return o.alive() ? {kind: 'failed', waited} : {kind: 'gone', waited};
    }
    if (!o.alive()) return {kind: 'gone', waited};
    if (a.status !== 503) return {kind: 'answered', status: a.status, waited};
    if (waited >= BUSY_TRIES) return {kind: 'busy', waited};
    const ms = retryAfterMs(a.retryAfter, BUSY_MAX_WAIT_MS, BUSY_MAX_WAIT_MS);
    waited += 1;
    o.onWait?.(ms, waited);
    await o.sleep(ms);
    if (!o.alive()) return {kind: 'gone', waited};
  }
};
