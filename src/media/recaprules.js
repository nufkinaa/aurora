// When a "Skip recap" may be shown at all — the rules that need no sound.
// A Skip recap where there is no recap skips part of the episode (elia, on
// Avatar: The Last Airbender), so a recap is shown only when it is likely to
// be one; a missed recap costs a few seconds of "Previously on…".
//
// introdetect.js first checks a library episode's recap against its sound
// (is it the episode before, heard again?) and decides by that when it can;
// these rules are for everything else — a streamed episode, a library one
// whose episode before is not on disk:
//   - never in the first episode of a show (there is nothing to recap);
//   - a recap opens an episode: it starts within the first four minutes;
//   - it is not the intro under another name (half of it or more inside the
//     intro), nor something a minute or more after the intro;
//   - and both databases named it, within a few seconds of each other
//     (skipsegments.merge `agreed.recap`) — a single crowd entry is not
//     enough on its own.
"use strict";

const RECAP_MAX_START_S = 240;
const AFTER_INTRO_S = 60;

const valid = (x) => !!x && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start;

// recap, { season, episode, intro, agreed } -> boolean
const plausibleRecap = (recap, { season = null, episode = null, intro = null } = {}) => {
  if (!valid(recap)) return false;
  if (Number(season) === 1 && Number(episode) === 1) return false;
  if (recap.start > RECAP_MAX_START_S) return false;
  if (valid(intro)) {
    const overlap = Math.min(recap.end, intro.end) - Math.max(recap.start, intro.start);
    if (overlap > 0.5 * Math.min(recap.end - recap.start, intro.end - intro.start)) return false;
    if (recap.start >= intro.end + AFTER_INTRO_S) return false;
  }
  return true;
};
const trustRecap = (recap, o = {}) => plausibleRecap(recap, o) && !!o.agreed;

module.exports = { plausibleRecap, trustRecap, RECAP_MAX_START_S };
