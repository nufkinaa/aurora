// WHICH APP IS RUNNING: the TV app or the phone app (docs/android-phone/PLAN.md).
// Both are built from this one codebase. The phone app's entry
// (index.phone.js) imports src/phone/mark.ts before anything else, which sets
// the flag below; the TV app never does, so on the TV `isPhone()` is false
// and every shared module runs its TV path — the code it always ran.
//
// A function, not a constant: a module evaluated before the flag was set
// (none should be) still gets the right answer when it asks.
declare const globalThis: {__AURORA_PHONE__?: boolean};

export const isPhone = (): boolean => globalThis.__AURORA_PHONE__ === true;
export const markPhone = () => {
  globalThis.__AURORA_PHONE__ = true;
};
