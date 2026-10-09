// Which rendering implementation each component uses this launch: JS (today's
// reference) or native (docs/native-rewrite/01-architecture.md §4).
//
// Read ONCE, at startup, from the AuroraImpl native module's constants
// (android/.../ui/AuroraImpl.kt reads SharedPreferences "aurora_impl"; flipped
// by the com.auroratv.QA broadcast, tools/tv-pixel-diff/PROTOCOL.md). Swapping
// an implementation while mounted would move focus, so a change only takes
// effect on the next launch — by design.
import {NativeModules} from 'react-native';

export type ImplKey = 'focusable' | 'card' | 'row' | 'hero' | 'rail' | 'grid';
export type ImplFlags = Record<ImplKey, boolean>;

const KEYS: ImplKey[] = ['focusable', 'card', 'row', 'hero', 'rail', 'grid'];
const LETTER: Record<ImplKey, string> = {focusable: 'F', card: 'C', row: 'R', hero: 'H', rail: 'N', grid: 'G'};

type Constants = {impl?: Partial<Record<ImplKey, boolean>>; letters?: string; versionCode?: number};

const read = (): Constants => {
  try {
    const m = NativeModules.AuroraImpl as (Constants & {getConstants?: () => Constants}) | undefined;
    if (!m) return {};
    return (m.getConstants ? m.getConstants() : m) || {};
  } catch {
    return {};
  }
};
const c = read();

export const impl: ImplFlags = KEYS.reduce((acc, k) => {
  acc[k] = c.impl?.[k] === true;
  return acc;
}, {} as ImplFlags);

/** Initial letters of the native components ("FCR"), "-" when everything is JS. */
export const implLetters: string = (() => {
  const s = KEYS.filter(k => impl[k])
    .map(k => LETTER[k])
    .join('');
  return s || '-';
})();

/** The APK's versionCode (BuildConfig), for the perf events. 0 if unknown. */
export const versionCode: number = typeof c.versionCode === 'number' ? c.versionCode : 0;
