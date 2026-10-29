// The phone app's self-update (docs/android-phone/PLAN.md, release prep):
// asked once a few seconds after start and from Settings → Check for updates.
// A newer build than this one (update.ts PHONE_APP_VERSION) brings up the
// "Update ready" sheet (sheets/UpdateSheet.tsx): Update downloads it from
// /download/phone and hands it to Android's package installer, which asks the
// person to confirm — the phone never installs anything by itself. Android
// asks once for "install unknown apps" (REQUEST_INSTALL_PACKAGES); the sheet
// says so and opens that setting, and goes on when the person comes back.
import {AppState} from 'react-native';
import {useSyncExternalStore} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {canInstall, cancelDownload, checkForUpdate, downloadUpdate, installUpdate, openInstallSettings, UpdateInfo, updaterAvailable} from '../../update';
import {FIRST_CHECK_MS, progressLine, shouldOffer, Snooze, SNOOZE_MS} from './rules';

export type Phase = 'hidden' | 'offer' | 'permission' | 'downloading' | 'installing' | 'failed';
export type UpdateState = {phase: Phase; info: UpdateInfo | null; line: string; pct: number; error: string};

const KEY = 'aurora.phone.updateSnooze';
let state: UpdateState = {phase: 'hidden', info: null, line: '', pct: 0, error: ''};
const subs = new Set<() => void>();
const set = (p: Partial<UpdateState>) => {
  state = {...state, ...p};
  subs.forEach(f => f());
};
export const useUpdate = () =>
  useSyncExternalStore(
    f => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );

const readSnooze = async (): Promise<Snooze> => {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Snooze) : null;
  } catch {
    return null;
  }
};

let started = false;
/** Once per run, a few seconds after the app is up. */
export const checkOnStart = () => {
  if (started || !updaterAvailable()) return;
  started = true;
  setTimeout(async () => {
    const info = await checkForUpdate();
    if (info && shouldOffer(info.version, await readSnooze(), Date.now())) set({phase: 'offer', info, error: ''});
  }, FIRST_CHECK_MS);
};

/** Settings → Check for updates: 'latest' | 'offered' (the sheet is up). */
export const checkNow = async (): Promise<'latest' | 'offered'> => {
  const info = await checkForUpdate();
  if (!info) return 'latest';
  set({phase: 'offer', info, error: ''});
  return 'offered';
};

export const later = () => {
  const v = state.info?.version;
  if (state.phase === 'downloading') cancelDownload();
  set({phase: 'hidden'});
  if (v) AsyncStorage.setItem(KEY, JSON.stringify({version: v, until: Date.now() + SNOOZE_MS})).catch(() => {});
};

let waitingForSettings = false;
/** Update: the permission first (once), then download and Android's installer. */
export const updateNow = async () => {
  const info = state.info;
  if (!info) return;
  let allowed = false;
  try {
    allowed = await canInstall();
  } catch {}
  if (!allowed) {
    set({phase: 'permission', error: ''});
    return;
  }
  set({phase: 'downloading', pct: 0, line: progressLine(0, 0), error: ''});
  try {
    const path = await downloadUpdate(info.url, p => set({pct: p.total > 0 ? p.received / p.total : 0, line: progressLine(p.received, p.total)}));
    if (state.phase !== 'downloading') return; // Later was pressed meanwhile
    set({phase: 'installing', line: 'Android will ask you to confirm the update.'});
    await installUpdate(path);
  } catch (e) {
    if (state.phase === 'hidden') return;
    set({phase: 'failed', error: String((e as Error)?.message || e) || 'The update did not download.'});
  }
};

/** "Allow in Settings": Android's install-apps switch for Aurora; back here, go on. */
export const allowInstalls = async () => {
  try {
    await openInstallSettings();
  } catch {}
  if (waitingForSettings) return;
  waitingForSettings = true;
  const sub = AppState.addEventListener('change', async s => {
    if (s !== 'active') return;
    sub.remove();
    waitingForSettings = false;
    let ok = false;
    try {
      ok = await canInstall();
    } catch {}
    if (ok && state.phase === 'permission') updateNow();
  });
};
