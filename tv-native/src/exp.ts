// LAB ONLY — the rendering experiments (docs/qa/native-bench/RENDER.md), each behind its
// own switch, all OFF by default so the lab app stays the reference picture.
//
// Read ONCE at startup from the AuroraImpl module's constants (android/.../ui/AuroraExp.kt
// reads SharedPreferences "aurora_exp"; flipped by the com.auroratv.QA broadcast,
// `cmd exp arg "cull=1,taglayer=0"` / `exp none`). Like `impl`, a change takes effect on the
// next launch. The keys are AuroraExp.KEYS: the fixes, and the `x_…` removals that exist
// only to attribute render-thread time to one thing on screen.
import {NativeModules} from 'react-native';

type Constants = {exp?: Record<string, boolean>; expTag?: string};

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
const on: Record<string, boolean> = c.exp || {};

/** Is this experiment on for this launch? */
export const exp = (key: string): boolean => on[key] === true;

/** "cull+cardlayer", "-" when nothing is on — the perf event's `exp` field. */
export const expTag: string = typeof c.expTag === 'string' ? c.expTag : '-';

/** `{opacity: 0}` when the removal `key` is on: HWUI does not replay a node at alpha 0. */
export const gone = (key: string): {opacity: number} | null => (exp(key) ? {opacity: 0} : null);
