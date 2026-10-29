// The phone's update, the pure part (tested in __tests__/logic/phone-update.test.ts and
// phone-rules.test.ts). The server announces the published phone build at
// /phone-version.json — read out of public/aurora-phone.apk itself, with its size and
// SHA-256 — and the app decides here whether to offer it, what each step says, and what
// each failure means in plain words. Android's own installer asks the person to confirm:
// the phone never installs anything by itself. "Later" holds that version back for a day.

export const SNOOZE_MS = 24 * 3600 * 1000;
/** The first look after start-up waits this long (Home first, then the question). */
export const FIRST_CHECK_MS = 6000;
/** Coming back to the app asks again, at most this often. */
export const RETURN_CHECK_MS = 30 * 60 * 1000;
/** "Update" pressed, then Android's settings (the install permission): a run of the app
 *  that starts this soon after goes on with the update by itself. */
export const RESUME_MS = 30 * 60 * 1000;

export type Snooze = {version: string; until: number} | null;

/** Should the sheet come up for this version now? */
export const shouldOffer = (version: string | null | undefined, snooze: Snooze, now: number): boolean =>
  !!version && !(snooze && snooze.version === version && now < snooze.until);

export const cmpVersion = (a: string, b: string) => {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
};

/** What /phone-version.json says (server.js, lib/tvapp.js phone.announcement). */
export type Announced = {versionName?: string | null; versionCode?: number | null; sizeBytes?: number | null; sha256?: string | null; notes?: string | null};
export type Running = {versionName: string; versionCode: number};

/**
 * The one decision: is the announced build an update for this phone?
 *   offer      newer — ask (unless Later holds it back: `snoozed`)
 *   same       this very version: nothing to say, ever (no prompt loop)
 *   downgrade  older than this one: refused, never offered
 *   badcode    a newer NAME with a build number that did not go up — Android would refuse
 *              to install it ("App not installed"), so it is not offered (the admin's
 *              Server page says why); offering it would only loop
 *   none       nothing published / nothing readable
 */
export type Decision = 'offer' | 'snoozed' | 'same' | 'downgrade' | 'badcode' | 'none';
export function decide(a: Announced | null | undefined, run: Running, snooze: Snooze, now: number): Decision {
  const v = a && typeof a.versionName === 'string' ? a.versionName.trim() : '';
  if (!v || !/^\d+(\.\d+)*$/.test(v)) return 'none';
  const c = cmpVersion(v, run.versionName);
  if (c === 0) return 'same';
  if (c < 0) return 'downgrade';
  if (a && typeof a.versionCode === 'number' && a.versionCode > 0 && run.versionCode > 0 && a.versionCode <= run.versionCode) return 'badcode';
  return shouldOffer(v, snooze, now) ? 'offer' : 'snoozed';
}

/** Coming back to the app: ask the server again? (Never while the sheet is busy.) */
export const checkOnReturn = (lastCheckAt: number, now: number, sheetUp: boolean) => !sheetUp && now - lastCheckAt >= RETURN_CHECK_MS;

/** "Update" was pressed this long ago (then Android's settings): carry on by itself? */
export const resumeWanted = (wanted: {version: string; at: number} | null, announced: string | null | undefined, now: number) =>
  !!wanted && !!announced && wanted.version === announced && now - wanted.at >= 0 && now - wanted.at < RESUME_MS;

/** Room for it: the file, Android's copy of it while installing, and some to spare.
 *  An unknown size or unknown free space never blocks (Android then says so itself). */
export const SPARE_BYTES = 50 * 1024 ** 2;
export const roomNeeded = (size: number | null | undefined) => (size && size > 0 ? Math.ceil(size * 2.5) + SPARE_BYTES : 0);
export const hasRoom = (size: number | null | undefined, free: number | null | undefined) =>
  !(size && size > 0) || free == null || free < 0 || free >= roomNeeded(size);

const mb = (b: number) => `${(b / 1024 ** 2).toFixed(b >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
export const spaceLine = (size: number, free: number) =>
  `There isn't room on this phone for the update: it needs about ${mb(roomNeeded(size))} free, and ${mb(Math.max(0, free))} is. Free some space (Settings → Storage), then try again.`;

/** The progress line under the bar while the new build comes down. */
export const progressLine = (received: number, total: number): string => {
  if (!total || total <= 0) return received > 0 ? `Downloading… ${mb(received)}` : 'Downloading…';
  const pct = Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
  return `Downloading… ${pct}% of ${mb(total)}`;
};

// Android's DownloadManager: its states and its reasons (DownloadManager.PAUSED_* / ERROR_*).
export type DmStatus = {status: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'gone'; bytes?: number; total?: number; reason?: number};
const PAUSED_WAITING_TO_RETRY = 1;
const PAUSED_WAITING_FOR_NETWORK = 2;
const PAUSED_QUEUED_FOR_WIFI = 3;

/** The line while it comes down: progress, or why it waits. */
export function dmLine(s: DmStatus, sizeHint = 0): string {
  const total = s.total && s.total > 0 ? s.total : sizeHint;
  if (s.status === 'pending') return 'Starting the download…';
  if (s.status === 'paused') {
    if (s.reason === PAUSED_WAITING_FOR_NETWORK || s.reason === PAUSED_QUEUED_FOR_WIFI) return 'Waiting for a connection — it carries on by itself.';
    if (s.reason === PAUSED_WAITING_TO_RETRY) return "The server didn't answer — trying again in a moment.";
    return 'Paused — it carries on by itself.';
  }
  return progressLine(s.bytes || 0, total);
}

/** How far along (0..1) for the bar. */
export const dmFraction = (s: DmStatus, sizeHint = 0) => {
  const total = s.total && s.total > 0 ? s.total : sizeHint;
  return total > 0 ? Math.max(0, Math.min(1, (s.bytes || 0) / total)) : 0;
};

/** A download that stopped for good, in plain words. */
export function dmFailure(reason: number | undefined): string {
  switch (reason) {
    case 1006: // ERROR_INSUFFICIENT_SPACE
      return "There isn't enough free space on this phone for the update. Free some space, then try again.";
    case 1007: // ERROR_DEVICE_NOT_FOUND
      return "This phone's storage isn't available right now.";
    case 1001: // ERROR_FILE_ERROR
    case 1009: // ERROR_FILE_ALREADY_EXISTS
      return "The update couldn't be saved on this phone — try again.";
    case 1008: // ERROR_CANNOT_RESUME
    case 1004: // ERROR_HTTP_DATA_ERROR
      return 'The download broke off — try again.';
    case 1002: // ERROR_UNHANDLED_HTTP_CODE
    case 1005: // ERROR_TOO_MANY_REDIRECTS
      return "The server didn't hand the update over — try again in a while.";
    case 404:
      return 'The update is no longer on the server — it may have just been replaced. Try again.';
    default:
      if (reason && reason >= 400 && reason < 600) return `The server answered ${reason} — try again in a while.`;
      return 'The download stopped — try again.';
  }
}

/** The check of the downloaded file (PhoneUpdaterModule.verify), in plain words. */
export function verifyFailure(reason: string | undefined): string {
  switch (reason) {
    case 'size':
    case 'sha256':
    case 'missing':
    case 'unreadable':
      return 'The download arrived damaged, so it was thrown away. Try again.';
    case 'package':
      return "That file isn't Aurora for Android, so it was not installed.";
    case 'older':
      return 'That file is not newer than the Aurora on this phone, so it was not installed.';
    case 'signer':
      return "That file wasn't signed by Aurora, so it was not installed.";
    default:
      return "The update couldn't be checked — try again.";
  }
}

/** A failed check that a fresh download may fix (the file was replaced on the server, or
 *  the line broke): asked again once, by itself. */
export const retryable = (reason: string | undefined) => reason === 'size' || reason === 'sha256' || reason === 'missing' || reason === 'unreadable';

/** Android's installer said no. */
export function installFailure(status: string, message?: string | null): string {
  if (status === 'aborted') return "The update wasn't installed. It's ready whenever you are.";
  if (status === 'storage') return "There isn't enough free space on this phone to install the update. Free some space, then try again.";
  const m = String(message || '').trim();
  if (/INCOMPATIBLE|SIGNATURE|conflict/i.test(m)) return "Android refused the update: it doesn't match the Aurora on this phone.";
  if (/DOWNGRADE|version/i.test(m)) return 'Android refused the update: it is not newer than this one.';
  return m ? `Android didn't install it (${m.slice(0, 120)}).` : "Android didn't install it — try again.";
}

/** After an update: this run is a newer version than the last one — say what's new, once. */
export const justUpdated = (lastRun: string | null | undefined, running: string) => !!lastRun && cmpVersion(lastRun, running) < 0;
