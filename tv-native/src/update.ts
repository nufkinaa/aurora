// Self-update. The server publishes tv-version.json next to the APK
// ({versionName, notes}); when it names a newer build than this one, Home
// offers it and UpdaterModule.kt fetches and installs it on the TV itself —
// no computer, no sideloading tool. Silent no-op when the file is absent.
import {NativeEventEmitter, NativeModules} from 'react-native';
import {getBaseUrl, getSession} from './api';

// Keep in lockstep with android/app/build.gradle versionName on each release.
export const APP_VERSION = '5.0.0';

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
