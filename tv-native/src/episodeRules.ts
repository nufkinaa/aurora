// The small rules about a show's episodes that the website and the TV must
// agree on. PURE — no imports (the logic tests run it as it is). Each rule
// names the website's lines it mirrors; change one side, change the other.

/** Position past which a title "resumes" rather than "plays" (both clients,
 *  everywhere: the film's Resume, the show's Continue, the player's resume). */
export const RESUME_AFTER_SEC = 10;
/** …and how close to the end is "finished, start again" (player.js :1526). */
export const RESUME_BEFORE_END_SEC = 20;
/** Where a resume starts: this many seconds BEFORE where it was left, so the
 *  viewer hears the line they stopped in (player.js :1533 — the website's
 *  later decision; the TV used to resume on the exact second). */
export const RESUME_REWIND_SEC = 4;

/** Where to start, given the saved position (null: from the beginning). */
export const resumePoint = (
  saved: {position: number; finished?: boolean} | null | undefined,
  duration: number | null | undefined,
): number | null => {
  if (!saved || saved.finished) return null;
  if (!(saved.position > RESUME_AFTER_SEC)) return null;
  if (duration && saved.position >= duration - RESUME_BEFORE_END_SEC) return null;
  return Math.max(0, Math.floor(saved.position) - RESUME_REWIND_SEC);
};

/** The skip steps on repeated presses (player.js :59). The TV's last step was
 *  300 under a comment that said "ported verbatim". */
export const SKIP_STEPS = [10, 10, 10, 30, 60, 60, 120, 180];

// ---------------------------------------------------------------- Play on a show
// WHICH EPISODE A SHOW'S PLAY BUTTON STANDS FOR — the website's `nextUp`
// (public/js/screens/discover-detail.js :1219-1234), over the episodes that
// are ON DISK, in order:
//   - the one you TOUCHED LAST (its progress row carries the newest stamp);
//     if that one is finished, the next one on disk after it;
//   - nothing touched: the first one on disk.
// It is the same episode Continue Watching shows. The TV used to take the
// EARLIEST episode with any progress — with E2 abandoned half-way last month
// and E7 stopped last night, Play went back to E2 (audit C-3).
export type RuleEp = {
  owned?: boolean;
  watched?: boolean; // its progress row says finished
  position?: number; // seconds, from its progress row
  touchedAt?: number | null; // the row's stamp; null/undefined = no row at all
};

export const pickUp = <T extends RuleEp>(
  episodes: T[],
): {ep: T; /** chosen because of what was watched (the label says Continue) */ resumed: boolean; /** part-way through: the label carries the clock */ mid: boolean} | null => {
  const flat = episodes.filter(e => e.owned);
  if (!flat.length) return null;
  let lastTouch = -1;
  let next: T | null = null;
  let touched = false;
  flat.forEach((row, i) => {
    if (row.touchedAt == null) return;
    if (row.touchedAt > lastTouch) {
      lastTouch = row.touchedAt;
      touched = true;
      next = row.watched ? flat[i + 1] || null : row;
    }
  });
  // (The website falls back to the first episode here and still labels it
  // "Continue S1 E1" after the LAST episode on disk was finished — the label
  // is the one thing not copied: with nothing left to continue, it is Play.)
  const resumed = touched && !!next;
  const ep = (next as T | null) || flat[0];
  const mid = resumed && !ep.watched && (ep.position || 0) > RESUME_AFTER_SEC;
  return {ep, resumed, mid};
};

// WHICH SEASON A SHOW'S PAGE OPENS ON (discover-detail.js :1984-1991): the one
// picked by hand last time for this show, else the season of the episode Play
// stands for, else the first. The TV always opened season 1 (audit C-13).
export const startSeason = (
  seasons: number[],
  picked: number | null | undefined,
  nextUpSeason: number | null | undefined,
  loaded: number | null | undefined,
): number | null => {
  const has = (n: number | null | undefined): n is number => n != null && seasons.includes(n);
  if (has(picked)) return picked;
  if (has(nextUpSeason)) return nextUpSeason;
  if (has(loaded)) return loaded;
  return seasons.length ? seasons[0] : null;
};
