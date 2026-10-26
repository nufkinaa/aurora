// "Is this a good copy?" — the website's words for a copy made before the
// film is out at home (CAM, TS, TC, screener, HC — the server reads them off
// the release name, src/media/releasekind.js, and sends `cam`, `prerelease`,
// `hardsub`, `badge` and `warning` per source). Shared by the title page's
// source list (screens/discover-detail.js) and "Get another version"
// (replaceCopy.js). The TV app has the same words to the letter
// (tv-native/src/releaseWords.ts; __tests__/logic/release-words.test.ts reads
// this file).
import { confirmSheet } from "./ui.js";

export const EARLY_CONFIRM = {
  title: "This is not the real release",
  text: (s) => `${s.warning || "A cinema recording"}. Picture and sound are usually poor — a good copy normally follows once the film is out to stream or buy.`,
  download: "Download it anyway",
  play: "Play it anyway",
};

// A copy made before the film is out at home.
export const isEarly = (s) => !!s && (!!s.cam || !!s.prerelease);

// The row's warning badge ("CAM", "TS", "HC", "BURNED-IN SUBS"), or null.
export const sourceBadge = (s) => (s && (isEarly(s) || s.hardsub) ? s.badge || (isEarly(s) ? "Cam" : null) : null);

// Asked before a pre-release copy is downloaded or played; anything else goes
// straight through. → true when it may go ahead.
export const earlyOk = async (s, what) => {
  if (!isEarly(s)) return true;
  return confirmSheet({ title: EARLY_CONFIRM.title, text: EARLY_CONFIRM.text(s), ok: EARLY_CONFIRM[what], icon: "⚠️" });
};
