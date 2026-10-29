// The phone app's self-update — Aurora is on no app store, so this is how every phone gets
// every new version. The decisions are rules.ts's (tested); the native half is
// PhoneUpdaterModule.kt ("AuroraPhoneUpdater", phone build only).
//
//   when it looks   a few seconds after start, on coming back to the app (at most every
//                   30 minutes), and from Settings → Check for updates (which says what it
//                   found — up to date, or that the server could not be reached)
//   the offer       "Update ready" with the version's notes (sheets/UpdateSheet.tsx);
//                   Later holds that version back for a day
//   the permission  Android's "Install unknown apps" for Aurora, once: the sheet opens that
//                   switch, and back in the app the update goes on by itself — also when
//                   Android restarted the app meanwhile (`wanted`, below)
//   the room        free space for the file and Android's copy of it, asked first
//   the download    Android's DownloadManager: it carries on with the app in the background
//                   or closed, waits for a lost connection and picks up again; coming back
//                   (or a new run) finds it again and goes on from where it is
//   the check       size + SHA-256 against the announcement, and the APK itself: Aurora's
//                   package, a higher build number, the same signing key. A damaged file is
//                   thrown away and fetched once more by itself
//   the install     Android asks "Do you want to update this app?"; Cancel there is heard
//                   (the sheet offers it again, the file kept); a yes ends this run and
//                   Android opens the new version
//   after           the new version says what's new, once, and the old file is cleaned up
//
// Never: an older or the same version offered, a prompt that comes back by itself after
// Later, or anything installed without the person's yes.
import {AppState, NativeEventEmitter, NativeModules} from 'react-native';
import {useSyncExternalStore} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {getBaseUrl, getSession} from '../../api';
import {PHONE_APP_VERSION} from '../../update';
import {cleanExit, reportError, tmValue, updateOffered} from '../../telemetry';
import {
  Announced,
  checkOnReturn,
  decide,
  dmFailure,
  dmFraction,
  dmLine,
  DmStatus,
  FIRST_CHECK_MS,
  hasRoom,
  installFailure,
  justUpdated,
  progressLine,
  resumeWanted,
  retryable,
  Running,
  Snooze,
  SNOOZE_MS,
  spaceLine,
  verifyFailure,
} from './rules';

export type Phase =
  | 'hidden'
  | 'offer' // "Update ready" — Update / Later
  | 'permission' // Android must allow installing apps first
  | 'downloading'
  | 'verifying'
  | 'installing' // handing the file to Android
  | 'confirm' // Android's own question is up
  | 'notInstalled' // Cancel in Android's question: offered again, the file kept
  | 'failed'
  | 'updated'; // this run is the new version: what's new, once
export type UpdateInfo = {version: string; notes?: string | null; sizeBytes?: number | null; sha256?: string | null; versionCode?: number | null};
export type UpdateState = {phase: Phase; info: UpdateInfo | null; line: string; pct: number; error: string};

type Native = {
  getConstants?: () => {versionName: string; versionCode: number};
  versionName?: string;
  versionCode?: number;
  space(): Promise<number>;
  canInstall(): Promise<boolean>;
  openInstallSettings(): Promise<boolean>;
  start(url: string, headers: Record<string, string>, version: string, title: string): Promise<{id: number; file: string}>;
  current(): Promise<{id: number; version: string; file: string} | null>;
  status(id: number): Promise<DmStatus>;
  cancel(): Promise<boolean>;
  cleanup(): Promise<boolean>;
  verify(path: string, sha256: string, size: number): Promise<{ok: boolean; reason?: string; versionName?: string; versionCode?: number}>;
  install(path: string): Promise<'session' | 'viewer'>;
};
const N = (NativeModules as {AuroraPhoneUpdater?: Native}).AuroraPhoneUpdater;
export const updaterAvailable = () => !!N;

/** What is running: the installed package's own version (the truth), else the constant. */
export const running = (): Running => {
  let c: {versionName?: string; versionCode?: number} | undefined;
  try {
    c = N?.getConstants ? N.getConstants() : N;
  } catch {}
  return {versionName: (c && c.versionName) || PHONE_APP_VERSION, versionCode: (c && Number(c.versionCode)) || 0};
};

const K_SNOOZE = 'aurora.phone.updateSnooze';
const K_WANTED = 'aurora.phone.updateWanted'; // {version, at}: Update was pressed
const K_LASTRUN = 'aurora.phone.lastRunVersion';
const K_NOTES = 'aurora.phone.updateNotes'; // {version, notes}: shown after the update

let state: UpdateState = {phase: 'hidden', info: null, line: '', pct: 0, error: ''};
const subs = new Set<() => void>();
const set = (p: Partial<UpdateState>) => {
  state = {...state, ...p};
  subs.forEach(f => f());
};
export const updateState = () => state;
export const useUpdate = () =>
  useSyncExternalStore(
    f => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );

const readJson = async <T>(k: string): Promise<T | null> => {
  try {
    const raw = await AsyncStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
const writeJson = (k: string, v: unknown) => AsyncStorage.setItem(k, JSON.stringify(v)).catch(() => {});
const drop = (k: string) => AsyncStorage.removeItem(k).catch(() => {});

// ---------------------------------------------------------------- the check
export type CheckResult = {kind: 'update'; info: UpdateInfo} | {kind: 'latest'} | {kind: 'none'} | {kind: 'refused'; why: 'downgrade' | 'badcode'} | {kind: 'error'; why: 'offline' | 'server'};

/** Ask the server what is published, and decide (snoozes aside: `ignoreSnooze`). */
export async function check(ignoreSnooze = false): Promise<CheckResult> {
  const base = getBaseUrl();
  if (!base) return {kind: 'error', why: 'server'};
  const askedAt = Date.now();
  let a: Announced | null = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    // cache-busted: a device HTTP cache once held a stale copy (the TV's lesson)
    const res = await fetch(`${base}/phone-version.json?t=${Date.now()}`, {signal: ctrl.signal, headers: {'Cache-Control': 'no-cache'}}).finally(() => clearTimeout(t));
    if (res.status === 404) return {kind: 'none'};
    if (!res.ok) return {kind: 'error', why: 'server'};
    a = (await res.json()) as Announced;
    tmValue('update_check', Date.now() - askedAt); // [analytics]
  } catch {
    return {kind: 'error', why: (await online()) ? 'server' : 'offline'};
  }
  const d = decide(a, running(), ignoreSnooze ? null : await readJson<Snooze>(K_SNOOZE), Date.now());
  if (d === 'same') return {kind: 'latest'};
  if (d === 'none') return {kind: 'none'};
  if (d === 'downgrade' || d === 'badcode') return {kind: 'refused', why: d};
  const info: UpdateInfo = {version: String(a!.versionName), notes: a!.notes || null, sizeBytes: a!.sizeBytes || null, sha256: a!.sha256 || null, versionCode: a!.versionCode || null};
  if (d === 'snoozed') return {kind: 'latest'}; // held back by Later: not now (Settings asks with ignoreSnooze)
  updateOffered(info.version); // [analytics] offered → running it, across the restart
  return {kind: 'update', info};
}

const online = async () => {
  try {
    const off = (NativeModules as {AuroraOffline?: {network(): Promise<string>}}).AuroraOffline;
    return off ? (await off.network()) !== 'none' : true;
  } catch {
    return true;
  }
};

const busy = () => state.phase !== 'hidden' && state.phase !== 'updated';
const offer = (info: UpdateInfo) => set({phase: 'offer', info, error: '', line: '', pct: 0});

let lastCheckAt = 0;
let started = false;
let watching = false;

/** Once per run, a few seconds after the app is up — and from then on, on every return. */
export const checkOnStart = () => {
  if (started || !N) return;
  started = true;
  setTimeout(boot, FIRST_CHECK_MS);
  if (!watching) {
    watching = true;
    AppState.addEventListener('change', s => {
      if (s !== 'active') return;
      // a download in hand: where it is now (it went on while the app was away)
      if (state.phase === 'downloading' || dlId != null) return void follow();
      if (checkOnReturn(lastCheckAt, Date.now(), busy())) void quietCheck();
    });
  }
};

async function quietCheck() {
  lastCheckAt = Date.now();
  const r = await check();
  if (r.kind === 'update' && !busy()) offer(r.info);
}

async function boot() {
  const run = running();
  // ---- this run is a new version: what's new, once; the old file goes
  const last = await readJson<string>(K_LASTRUN);
  writeJson(K_LASTRUN, run.versionName);
  if (justUpdated(last, run.versionName)) {
    N?.cleanup().catch(() => {});
    drop(K_WANTED);
    const saved = await readJson<{version: string; notes?: string | null}>(K_NOTES);
    drop(K_NOTES);
    set({phase: 'updated', info: {version: run.versionName, notes: saved && saved.version === run.versionName ? saved.notes || null : null}, error: ''});
    lastCheckAt = Date.now();
    return;
  }
  // ---- a download this phone already has in hand (the app was closed meanwhile)
  let cur: {id: number; version: string; file: string} | null = null;
  try {
    cur = N ? await N.current() : null;
  } catch {}
  lastCheckAt = Date.now();
  const r = await check();
  if (r.kind !== 'update') {
    // nothing newer any more: whatever was in hand is not wanted
    if (cur) N?.cleanup().catch(() => {});
    return;
  }
  if (cur && cur.version === r.info.version) {
    set({phase: 'downloading', info: r.info, line: 'Picking up where it left off…', pct: 0, error: ''});
    dlId = cur.id;
    dlFile = cur.file;
    return void follow();
  }
  if (cur) N?.cleanup().catch(() => {});
  // Update was pressed, then Android's settings, and the app was restarted meanwhile
  const wanted = await readJson<{version: string; at: number}>(K_WANTED);
  if (resumeWanted(wanted, r.info.version, Date.now())) {
    set({info: r.info});
    return void updateNow();
  }
  if (!busy()) offer(r.info);
}

/** Settings → Check for updates: what it found, said by Settings unless the sheet comes up. */
export const checkNow = async (): Promise<'offered' | 'latest' | 'none' | 'offline' | 'server' | 'refused'> => {
  if (busy()) return 'offered'; // the sheet is up already
  lastCheckAt = Date.now();
  const r = await check(true);
  if (r.kind === 'update') {
    offer(r.info);
    return 'offered';
  }
  if (r.kind === 'error') return r.why;
  if (r.kind === 'refused') return 'refused';
  return r.kind;
};

// ---------------------------------------------------------------- the steps
/** Later (or Cancel while it comes down): that version waits a day. */
export const later = () => {
  const v = state.info?.version;
  const was = state.phase;
  stopFollowing();
  if (was === 'downloading' || was === 'verifying') N?.cancel().catch(() => {});
  dlId = null;
  dlFile = null;
  set({phase: 'hidden'});
  drop(K_WANTED);
  if (v && was !== 'updated') writeJson(K_SNOOZE, {version: v, until: Date.now() + SNOOZE_MS});
};

let dlId: number | null = null;
let dlFile: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let retried = false;
const stopFollowing = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

/** Update: the permission first (once), then room, then the download. */
export const updateNow = async () => {
  const info = state.info;
  if (!info || !N) return;
  // a file already fetched and kept (after Cancel in Android's question): straight to the check
  if (state.phase === 'notInstalled' && dlFile) return void verifyAndInstall();
  writeJson(K_WANTED, {version: info.version, at: Date.now()});
  writeJson(K_NOTES, {version: info.version, notes: info.notes || null});
  let allowed = false;
  try {
    allowed = await N.canInstall();
  } catch {}
  if (!allowed) return void set({phase: 'permission', error: ''});
  let free = -1;
  try {
    free = await N.space();
  } catch {}
  if (!hasRoom(info.sizeBytes, free)) return void set({phase: 'failed', error: spaceLine(info.sizeBytes || 0, free)});
  set({phase: 'downloading', pct: 0, line: 'Starting the download…', error: ''});
  try {
    const r = await N.start(`${getBaseUrl()}/download/phone`, getSession() ? {'X-Session': getSession() as string} : {}, info.version, 'Aurora update');
    dlId = r.id;
    dlFile = r.file;
    follow();
  } catch (e) {
    fail(`The download couldn't start (${String((e as Error)?.message || e)}).`);
  }
};

function fail(error: string) {
  stopFollowing();
  reportError('update', 'the update did not download'); // [analytics]
  set({phase: 'failed', error});
}

/** Where the download is: asked now and every moment while the app is on screen. */
function follow() {
  stopFollowing();
  if (dlId == null || !N) return;
  const tick = async () => {
    if (dlId == null || !N) return stopFollowing();
    if (AppState.currentState !== 'active') return; // asked again on return
    let s: DmStatus;
    try {
      s = await N.status(dlId);
    } catch {
      return;
    }
    if (state.phase !== 'downloading') return stopFollowing();
    const size = state.info?.sizeBytes || 0;
    if (s.status === 'done') {
      stopFollowing();
      set({pct: 1, line: progressLine(size, size)});
      return void verifyAndInstall();
    }
    if (s.status === 'failed' || s.status === 'gone') {
      dlId = null;
      N.cancel().catch(() => {});
      return fail(s.status === 'gone' ? 'The download was stopped.' : dmFailure(s.reason));
    }
    set({pct: dmFraction(s, size), line: dmLine(s, size)});
  };
  tick();
  timer = setInterval(tick, 700);
}

async function verifyAndInstall() {
  const info = state.info;
  if (!info || !N || !dlFile) return;
  set({phase: 'verifying', line: 'Checking the download…', error: ''});
  let v: {ok: boolean; reason?: string};
  try {
    v = await N.verify(dlFile, info.sha256 || '', info.sizeBytes || 0);
  } catch {
    v = {ok: false, reason: 'unreadable'};
  }
  if (!v.ok) {
    N.cancel().catch(() => {});
    dlId = null;
    dlFile = null;
    // replaced on the server meanwhile, or a broken line: asked again once, by itself
    if (retryable(v.reason) && !retried) {
      retried = true;
      const r = await check(true);
      if (r.kind === 'update') {
        set({info: r.info});
        return void updateNow();
      }
    }
    return fail(verifyFailure(v.reason));
  }
  retried = false;
  set({phase: 'installing', line: 'Android will ask you to confirm the update.'});
  try {
    cleanExit(); // [analytics] being replaced on purpose is not a run that ended badly
    const how = await N.install(dlFile);
    // the viewer fallback has no answer to wait for: the installer is up
    set({phase: how === 'viewer' ? 'confirm' : 'installing'});
  } catch (e) {
    fail(installFailure('failed', String((e as Error)?.message || e)));
  }
}

// Android's answers (PhoneUpdaterModule.onStatusIntent)
try {
  if (N) {
    new NativeEventEmitter(NativeModules.AuroraPhoneUpdater).addListener('AuroraPhoneUpdate', (e: {status: string; message?: string}) => {
      if (!e || !state.info) return;
      if (e.status === 'confirm') return void set({phase: 'confirm', line: 'Android is asking you to confirm the update.'});
      if (e.status === 'installed') return; // this process is about to be replaced
      if (e.status === 'aborted') return void set({phase: 'notInstalled', error: installFailure('aborted')});
      set({phase: 'failed', error: installFailure(e.status, e.message)});
    });
  }
} catch {}

/** "Allow in Settings": Android's install-apps switch for Aurora; back here, go on. */
let waitingForSettings = false;
export const allowInstalls = async () => {
  if (!N) return;
  try {
    await N.openInstallSettings();
  } catch {}
  if (waitingForSettings) return;
  waitingForSettings = true;
  const sub = AppState.addEventListener('change', async s => {
    if (s !== 'active') return;
    sub.remove();
    waitingForSettings = false;
    let ok = false;
    try {
      ok = await N.canInstall();
    } catch {}
    if (state.phase !== 'permission') return;
    if (ok) updateNow();
    else set({error: "Aurora isn't allowed to install apps yet — turn on “Allow from this source” for Aurora, then come back."});
  });
};

/** Done with "what's new": the sheet goes. */
export const dismissUpdated = () => set({phase: 'hidden'});

// (tests) the state machine, from the start
export const __reset = () => {
  stopFollowing();
  state = {phase: 'hidden', info: null, line: '', pct: 0, error: ''};
  dlId = null;
  dlFile = null;
  retried = false;
  started = false;
  lastCheckAt = 0;
};
