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
};

/** The first address, in list order, that answers — or null. */
export async function pickServer(candidates: readonly string[], d: PickDeps): Promise<string | null> {
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i].replace(/\/+$/, '');
    const wait = pingBudget(url);
    const t0 = d.now();
    if (await d.ping(url, wait)) return url;
    if (i !== 0) continue;
    // the first address's second look
    const pause = RETRY_NOT_BEFORE_MS - (d.now() - t0);
    if (pause > 0) await d.sleep(pause);
    const left = Math.min(wait, FIRST_BUDGET_MS - (d.now() - t0));
    if (left >= RETRY_MIN_MS && (await d.ping(url, left))) return url;
  }
  return null;
}
