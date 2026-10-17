// Which native components and render fixes THIS LAUNCH draws with (renderRules.ts has
// what each one is and how the sources combine).
//
// Read ONCE, at startup, from the AuroraRender native module's constants
// (android/.../ui/AuroraRender.kt). Swapping an implementation while it is mounted
// would move focus, so anything that changes the switches — the server's `tvRender`
// answer, the developer setting, the QA harness — is stored for the NEXT launch.
// Without the module (an older APK running this bundle, the logic tests) everything is
// off: the JS reference.
import {NativeModules} from 'react-native';
import {
  COMPONENTS,
  decodeRender,
  encodeRender,
  FIXES,
  RenderComponent,
  RenderFix,
  RenderKey,
  RenderSay,
  resolveRender,
  sameSay,
  sanitizeSay,
} from './renderRules';

type Constants = {
  on?: Partial<Record<RenderKey, boolean>>;
  letters?: string;
  fixTag?: string;
  source?: string;
  nextQa?: boolean;
  nextQaSet?: string;
  server?: string;
  local?: string;
  versionCode?: number;
};
type RenderNative = Constants & {
  getConstants?: () => Constants;
  save: (resolved: string, server: string, local: string) => void;
  jsRingClaimed: () => void;
};
const native = NativeModules.AuroraRender as RenderNative | undefined;

const read = (): Constants => {
  try {
    if (!native) return {};
    return (native.getConstants ? native.getConstants() : native) || {};
  } catch {
    return {};
  }
};
const c = read();

/** This launch's native components: `nativeOn.card` etc. */
export const nativeOn: Record<RenderComponent, boolean> = COMPONENTS.reduce((acc, k) => {
  acc[k] = c.on?.[k] === true;
  return acc;
}, {} as Record<RenderComponent, boolean>);
/** This launch's render fixes. */
export const fixOn: Record<RenderFix, boolean> = FIXES.reduce((acc, k) => {
  acc[k] = c.on?.[k] === true;
  return acc;
}, {} as Record<RenderFix, boolean>);

/** Is `key` on for this launch? */
export const renderOn = (key: RenderKey): boolean => c.on?.[key] === true;

/** "FCRHN" — the native components' letters, "-" when none (the perf event's `impl`). */
export const renderLetters: string = typeof c.letters === 'string' ? c.letters : '-';
/** "cardlayer+cull", "-" when no fix is on (the perf event's `exp`). */
export const renderFixTag: string = typeof c.fixTag === 'string' ? c.fixTag : '-';
/** The fixes as one letter each — cardlayer l, cull c, shadowcache s, unstuff u, unstuffq q,
 *  pool p — '' when none: the perf event's `exp`, short enough for a telemetry flag. */
export const renderFixCode: string = (() => {
  const L: Record<RenderFix, string> = {cardlayer: 'l', cull: 'c', shadowcache: 's', unstuff: 'u', unstuffq: 'q', pool: 'p'};
  return FIXES.filter(k => c.on?.[k] === true)
    .map(k => L[k])
    .join('');
})();
/** Where this launch's set came from: "qa" (the harness), "saved" (server / developer
 *  setting, stored last time), "build" (the APK's default). */
export const renderSource: string = typeof c.source === 'string' ? c.source : 'build';
/** The APK's versionCode, for the perf events. 0 if unknown. */
export const versionCode: number = typeof c.versionCode === 'number' ? c.versionCode : 0;

/** The JS ring registry lit a ring while native rings exist (Focusable.tsx). */
export const tellRingClaimed = () => {
  try {
    native?.jsRingClaimed();
  } catch {}
};

// ---- what the next launch runs with ------------------------------------------------

const parse = (s: string | undefined): RenderSay => {
  try {
    return sanitizeSay(s ? JSON.parse(s) : {});
  } catch {
    return {};
  }
};
const stored = {server: parse(c.server), local: parse(c.local)};

const persist = () => {
  try {
    native?.save(encodeRender(resolveRender(stored.server, stored.local)), JSON.stringify(stored.server), JSON.stringify(stored.local));
  } catch {}
};

/** The server's `tvRender` (GET /api/tv/tuning, playback/tuning.ts hands it here). An
 *  answer without the section — an older server, or an admin who set nothing — means
 *  "nothing said": every switch it does not name is off. Stored for the next launch. */
export function applyServerRender(raw: unknown) {
  const next = sanitizeSay(raw);
  if (sameSay(next, stored.server)) return;
  stored.server = next;
  persist();
}

/** The developer setting's say (Settings, hidden). Stored for the next launch. */
export const localRender = (): RenderSay => ({...stored.local});
export function setLocalRender(next: RenderSay) {
  stored.local = sanitizeSay(next);
  persist();
}
export const serverRender = (): RenderSay => ({...stored.server});

/** What the next launch will run with, and whether the QA harness's override decides it. */
export function nextRender(): {on: Set<RenderKey>; qa: boolean} {
  if (c.nextQa) return {on: decodeRender(c.nextQaSet), qa: true};
  return {on: resolveRender(stored.server, stored.local), qa: false};
}
/** What this launch runs with. */
export const activeRender = (): Set<RenderKey> => new Set([...COMPONENTS, ...FIXES].filter(k => c.on?.[k] === true));
