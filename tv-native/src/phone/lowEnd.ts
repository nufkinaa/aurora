// A WEAK PHONE (elia, 2026-10-29: "make sure it works well even on older weak
// devices"). Decided once at start, from what the phone says about itself
// (perfTier.ts: Android's own low-RAM flag, total memory, the app's heap
// class): a phone with under 3.5 GB, or one Android calls low-RAM, gets the
// lighter settings below. Nothing on screen looks different — fewer things are
// kept alive off screen, pictures do not cross-fade in, fewer shelves and
// cards are mounted ahead, hidden tabs are let go.
import {Platform} from 'react-native';
import {deviceInfo, isLowRam} from '../perfTier';

const GB = 1024 * 1024 * 1024;
export const LOW_END_TOTAL_BYTES = 3.5 * GB;

/** The rule, pure (tested in __tests__/logic/phone-rules.test.ts): Android's
 *  low-RAM flag or perfTier's (memory under 2.5 GB, a heap class of 192 MB or
 *  less), under 3.5 GB of memory, or Android 8.1 and older. */
export function isWeakPhone(lowRam: boolean, totalMem: number | undefined, sdk: number | string): boolean {
  return lowRam || (!!totalMem && totalMem > 0 && totalMem < LOW_END_TOTAL_BYTES) || (typeof sdk === 'number' && sdk < 28);
}

export const LOW_END: boolean = isWeakPhone(isLowRam(), deviceInfo()?.totalMem, Platform.Version);

/** How much each list keeps mounted around what is on screen. */
export const LISTS = LOW_END
  ? {homeWindow: 4, homeInitial: 3, homeBatch: 2, shelfWindow: 3, shelfInitial: 3, gridWindow: 4, gridRows: 3}
  : {homeWindow: 7, homeInitial: 5, homeBatch: 3, shelfWindow: 5, shelfInitial: 4, gridWindow: 7, gridRows: 4};

/** A picture's fade-in (ms): none on a weak phone (each fade is frames of blending). */
export const FADE_MS = LOW_END ? 0 : 150;
