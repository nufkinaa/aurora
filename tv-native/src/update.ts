// Self-update. The server publishes tv-version.json next to the APK
// ({versionName, notes}); when it names a newer build than this one, Home
// offers it and UpdaterModule.kt fetches and installs it on the TV itself —
// no computer, no sideloading tool. Silent no-op when the file is absent.
import {AppState, NativeEventEmitter, NativeModules} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {getBaseUrl, getSession} from './api';

// Keep in lockstep with android/app/build.gradle versionName on each release.
export const APP_VERSION = '5.1.28';

const cmp = (a: string, b: string) => {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
};

export type UpdateInfo = {version: string; url: string; notes?: string};

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const base = getBaseUrl();
  if (!base) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    // Cache-busted: the device's HTTP cache served a stale copy under a long
    // max-age (measured on the Streamer).
    const res = await fetch(`${base}/tv-version.json?t=${Date.now()}`, {signal: ctrl.signal});
    clearTimeout(t);
    if (!res.ok) return null;
    const j = (await res.json()) as {versionName?: string; notes?: string};
    if (j.versionName && cmp(APP_VERSION, j.versionName) < 0) {
      return {version: j.versionName, url: `${base}/download`, notes: j.notes};
    }
  } catch {
    clearTimeout(t);
  }
  return null;
}

// ---- the native half (UpdaterModule.kt) ----
type Native = {
  download: (url: string, session: string | null, ) => Promise<string>;
  cancel: () => void;
  canInstall: () => Promise<boolean>;
  openInstallSettings: () => Promise<boolean>;
  install: (path: string) => Promise<boolean>;
  versionName: () => Promise<string>;
};
const native = NativeModules.AuroraUpdater as Native | undefined;
export const updaterAvailable = () => !!native;

export type Progress = {received: number; total: number};

// Fetch the APK into the app's cache. `onProgress` fires a few times a second.
export const downloadUpdate = async (url: string, onProgress: (p: Progress) => void): Promise<string> => {
  if (!native) throw new Error('This build cannot update itself');
  const emitter = new NativeEventEmitter(NativeModules.AuroraUpdater);
  const sub = emitter.addListener('AuroraUpdaterProgress', (p: Progress) => onProgress(p));
  try {
    return await native.download(url, getSession());
  } finally {
    sub.remove();
  }
};
export const cancelDownload = () => native?.cancel();
export const canInstall = () => (native ? native.canInstall() : Promise.resolve(false));
export const openInstallSettings = () => (native ? native.openInstallSettings() : Promise.resolve(false));
export const installUpdate = (path: string) => {
  if (!native) throw new Error('This build cannot update itself');
  return native.install(path);
};

// ---- the quiet update ----
// On Android 12+ the app may install its own update with no confirmation
// dialog (UpdaterModule.installQuietly). So on those TVs a new build is not
// announced at once: the APK is fetched in the background while the viewer
// browses, and installed the moment the app goes to the BACKGROUND — the
// viewer pressed Home, opened something else, or the TV went to sleep. The
// next time Aurora is opened it is simply the new version.
//
// The ordinary prompt is the fallback, never removed: it is held back for at
// most a day per version, and comes back at once if the quiet install was
// refused or failed (the native side writes that down), or on any TV that
// cannot do this (Android 11 and older, or a build without the native half).
const QUIET_KEY = 'aurora.quietUpdate';
const HOLD_MS = 24 * 3600 * 1000;
type QuietNative = {
  quietStatus?: () => Promise<{supported: boolean; status: number; at: number}>;
  installQuietly?: (path: string) => Promise<string>;
  armRelaunch?: () => Promise<boolean>;
  canRelaunch?: () => Promise<boolean>;
  openRelaunchSettings?: () => Promise<boolean>;
};
const quiet = NativeModules.AuroraUpdater as (Native & QuietNative) | undefined;

let quietPath: string | null = null; // the downloaded APK, waiting for the app to leave the screen
let quietFor: string | null = null; // the version it is
let quietFetching = false;
let quietArmed = false;

const prepareQuiet = (info: UpdateInfo) => {
  if (!quiet || !quiet.installQuietly) return;
  if (!quietArmed) {
    quietArmed = true;
    AppState.addEventListener('change', s => {
      if (s !== 'background' || !quietPath || !quiet || !quiet.installQuietly) return;
      const p = quietPath;
      quietPath = null; // one attempt per download
      quiet.installQuietly(p).catch(() => {});
    });
  }
  if (quietFetching || quietFor === info.version) return;
  quietFetching = true;
  quiet
    .download(info.url, getSession())
    .then(p => {
      quietPath = p;
      quietFor = info.version;
      // The build is on the TV. A streamer that never leaves Aurora would
      // wait for it indefinitely (elia, 2026-10-08), so say it is ready and
      // offer to restart now; "Later" keeps the install-on-leaving behaviour.
      readyInfo = info;
      readyHandler?.(info);
    })
    .catch(() => {})
    .then(() => {
      quietFetching = false;
    });
};

// ---- "the update is ready: restart now or later" ----
let readyInfo: UpdateInfo | null = null;
let readyHandler: ((info: UpdateInfo) => void) | null = null;
/** Called when a quietly-fetched build is ready to install. */
export const onUpdateReady = (fn: ((info: UpdateInfo) => void) | null) => {
  readyHandler = fn;
};
/** The fetched build still waiting to be installed, if any. */
export const updateReady = () => (quietPath ? readyInfo : null);
/** May Aurora open itself again after the update? (Android's "display over
 *  other apps" permission — without it the TV returns to its home screen.) */
export const canRelaunch = async () => {
  try {
    return !!(quiet && quiet.canRelaunch && (await quiet.canRelaunch()));
  } catch {
    return false;
  }
};
export const openRelaunchSettings = async () => {
  try {
    return !!(quiet && quiet.openRelaunchSettings && (await quiet.openRelaunchSettings()));
  } catch {
    return false;
  }
};
/** Install the fetched build now and come back as the new version. */
export const restartIntoUpdate = async (): Promise<void> => {
  if (!quiet || !quiet.installQuietly || !quietPath) throw new Error('The update is no longer waiting');
  const p = quietPath;
  try {
    await quiet.armRelaunch?.();
  } catch {}
  const r = await quiet.installQuietly(p);
  if (r !== 'committed') throw new Error('This TV cannot install it by itself');
  quietPath = null;
};

/** True when this TV is going to try the update quietly, so the prompt should
 *  wait. Starts the background download as a side effect. Never throws. */
export async function holdPromptFor(info: UpdateInfo): Promise<boolean> {
  try {
    if (!quiet || !quiet.quietStatus || !quiet.installQuietly) return false;
    const st = await quiet.quietStatus();
    if (!st || !st.supported) return false;
    // A TV that has not yet allowed Aurora to install apps cannot install
    // quietly either: holding the prompt here is what left those TVs with a
    // silent failure and no way to the permission screen (elia, 2026-10-07).
    // The ordinary sheet shows at once and asks for the permission first.
    if (!(await canInstall())) return false;
    const raw = await AsyncStorage.getItem(QUIET_KEY);
    let seen: {version: string; at: number} | null = raw ? JSON.parse(raw) : null;
    if (!seen || seen.version !== info.version) {
      seen = {version: info.version, at: Date.now()};
      await AsyncStorage.setItem(QUIET_KEY, JSON.stringify(seen));
    }
    if (Date.now() - seen.at > HOLD_MS) return false; // a day has passed: just ask
    if (st.at > seen.at && st.status !== 0) return false; // tried quietly, refused or failed: ask
    prepareQuiet(info);
    return true;
  } catch {
    return false;
  }
}
