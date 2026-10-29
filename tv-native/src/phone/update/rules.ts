// The phone's update offer, the pure part (tested in __tests__/logic/phone-rules.test.ts).
// The server announces the published phone build at /phone-version.json (from
// public/aurora-phone.apk); the app offers it, and Android's own installer asks
// the person to confirm. Never silent. "Later" holds that version back for a day.

export const SNOOZE_MS = 24 * 3600 * 1000;
/** The first look after start-up waits this long (Home first, then the question). */
export const FIRST_CHECK_MS = 6000;

export type Snooze = {version: string; until: number} | null;

/** Should the sheet come up for this version now? */
export const shouldOffer = (version: string | null | undefined, snooze: Snooze, now: number): boolean =>
  !!version && !(snooze && snooze.version === version && now < snooze.until);

/** The progress line under the bar while the new build comes down. */
export const progressLine = (received: number, total: number): string => {
  const mb = (b: number) => `${(b / 1024 ** 2).toFixed(b >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  if (!total || total <= 0) return received > 0 ? `Downloading… ${mb(received)}` : 'Downloading…';
  const pct = Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
  return `Downloading… ${pct}% of ${mb(total)}`;
};
