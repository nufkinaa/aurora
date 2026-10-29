// Which server this run talks to — the order, the waits, the one second look.
//
// THE LIST'S ORDER IS THE PRIORITY, ALWAYS (api.ts SERVER_CANDIDATES): the
// first address that answers is the server, and a later address is asked only
// once every address before it has been given up on. Nothing remembered
// reorders it (api.ts resolveServer says what that cost once).
//
// SERIAL, NOT "HAPPY EYEBALLS". Starting the second address a moment after the
// first and taking whichever is ready was considered and left out: the second
// may only be USED once the first has failed, so an early start cannot bring
// the app up one millisecond sooner when the first answers, and when the first
// does not, the second (the house server, on the LAN) answers in ~20 ms
// anyway — the early start would save that, and nothing else. What it would
// cost is a second request on every launch and two answers arriving in either
// order.
//
// HOW LONG AN ADDRESS IS WAITED FOR.
//  • An internet address (https, or a name): 3 s. The ping is a DNS lookup,
//    a TCP and a TLS handshake and one small GET — 4 to 5 round trips, so
//    ~0.3 s on a home line and ~1.5 s on a poor one (300 ms a trip); one lost
//    SYN is retransmitted after 1 s. 3 s covers the poor line WITH the lost
//    packet; 2 s (the LAN's figure) did not.
//  • A LAN address (http to a private IP): 2 s, as before — it answers in
//    milliseconds or not at all.
//
// ONE SECOND LOOK AT THE FIRST ADDRESS, inside a fixed budget. Measured on the
// Mi TV (2026-10-06): the first launch after the box woke failed its first
// ping while the Wi-Fi came out of power-save, for a server that was healthy a
// second later. So the first address is asked once more — but its two tries
// together never take more than FIRST_BUDGET_MS, and a try that failed at
// once (no route yet) is not repeated before RETRY_NOT_BEFORE_MS, so the
// second look is not spent in the same dead moment.
//
// WHAT THAT MEANS ON THE SOFA (release order: nufurora.com, then the house):
//  • nufurora.com answers (any TV with the internet up): the app is up as soon
//    as it does. The house server is never asked.
//  • At home, the internet down: a router that refuses at once (no DNS, no
//    route) → the house server is asked after ~0.6 s; an internet that
//    swallows packets silently → after 4.5 s at the latest. Either way the
//    house server is reached. (Before, a TV away from home waited 4 s for the
//    house address on every launch; now the wait falls on the rare case.)
//  • Neither answers: the offline screen, after at most 4.5 s + 2 s.
//
// Pure — the ping and the clock are handed in — so the order is tested with a
// made-up clock (__tests__/logic/server-pick.test.ts).

export const INTERNET_PING_MS = 3000;
export const LAN_PING_MS = 2000;
/** The first address's two tries together. */
export const FIRST_BUDGET_MS = 4500;
/** The second look does not start earlier than this after the first began. */
export const RETRY_NOT_BEFORE_MS = 600;
/** …and is not worth starting with less than this left of the budget. */
export const RETRY_MIN_MS = 1000;

/** http to a private or loopback IPv4 address: the house server, a QA PC. */
export const isLanUrl = (url: string) =>
  /^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|localhost[:/]?)/i.test(url);

export const pingBudget = (url: string) => (isLanUrl(url) ? LAN_PING_MS : INTERNET_PING_MS);

export type PickDeps = {
  /** True when `url` answered inside `timeoutMs`. Never rejects, never takes
   *  longer than `timeoutMs` (api.ts pingUrl guarantees both). */
  ping: (url: string, timeoutMs: number) => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** [android-phone] every wait times this (default 1: the TV's). A phone on mobile data
   *  can take seconds for its first TLS handshake; the phone app passes 2. */
  scale?: number;
};

/** The first address, in list order, that answers — or null. */
export async function pickServer(candidates: readonly string[], d: PickDeps): Promise<string | null> {
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i].replace(/\/+$/, '');
    const k = d.scale && d.scale > 0 ? d.scale : 1;
    const wait = pingBudget(url) * k;
    const t0 = d.now();
    if (await d.ping(url, wait)) return url;
    if (i !== 0) continue;
    // the first address's second look
    const pause = RETRY_NOT_BEFORE_MS * k - (d.now() - t0);
    if (pause > 0) await d.sleep(pause);
    const left = Math.min(wait, FIRST_BUDGET_MS * k - (d.now() - t0));
    if (left >= RETRY_MIN_MS && (await d.ping(url, left))) return url;
  }
  return null;
}

// ---- [android-phone] THE FIRST LAUNCH'S PATIENCE ----------------------------
// Measured on the Pixel 9 emulator (2026-10-29): straight after the phone
// boots, and on the first launch after an install, the app's sockets go
// nowhere for several seconds — both pings to a healthy server hung their
// full 4 s and the app showed "Can't reach Aurora", while a shell on the
// same phone reached the same address at once and "Try again" worked a moment
// later. The network was still coming up for the app, not down.
//
// So the phone does not give up on the first round: while the whole start has
// taken less than PATIENCE_MS it waits a little (BACKOFF_MS, growing) and walks
// the list again, saying so on the loading screen. Only after that is it the
// offline screen. The TV asks the same way since the Mi TV regression pass of
// 2026-10-29 (its waits unscaled): a box opened while its Wi-Fi was still
// joining showed the offline screen after 0.7 s and stayed on it.
//
// The further rounds ask with SHORTER pings (RETRY_SCALE of the TV's waits): a
// ping sent while the app's network was still asleep stays dead after it wakes
// (its connection attempt went nowhere), so the way to notice the wake-up soon
// is a fresh ping often, not a long one.
export const PATIENCE_MS = 15000;
export const BACKOFF_MS = [500, 1000, 1500, 2000];
export const RETRY_SCALE = 0.75;

export type PatientDeps = PickDeps & {
  /** told before each further round: the round about to start (2, 3, …) and the time spent so far */
  onWait?: (round: number, spentMs: number) => void;
};

/** pickServer, again and again with a growing pause, for up to `patienceMs` in all. */
export async function pickServerPatiently(candidates: readonly string[], d: PatientDeps, patienceMs = PATIENCE_MS): Promise<string | null> {
  const t0 = d.now();
  for (let round = 1; ; round++) {
    const url = await pickServer(candidates, round === 1 ? d : {...d, scale: RETRY_SCALE});
    if (url) return url;
    const spent = d.now() - t0;
    const pause = BACKOFF_MS[Math.min(round - 1, BACKOFF_MS.length - 1)];
    // a further round only when it can still start inside the patience
    if (spent + pause >= patienceMs) return null;
    d.onWait?.(round + 1, spent);
    await d.sleep(pause);
  }
}
