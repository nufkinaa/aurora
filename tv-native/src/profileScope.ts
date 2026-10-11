// WHAT BELONGS TO ONE PROFILE AND IS HELD IN MEMORY — and the one call that
// empties all of it.
//
// A module keeps things between screens: the last answer to a request, a
// warmed list, a prepared trailer, the AI page's last picks. Each of those was
// fetched AS a profile, and the server filters by profile (a kids profile's
// library list is a different list). The request cache was keyed by path alone
// and nothing emptied it on a switch, so a kids profile entered within a
// minute of a grown-up could be shown the grown-up's lists (audit X7); the AI
// page showed the last person's picks (X8).
//
// So: a module that holds per-profile state REGISTERS a function that drops
// it, here, at module scope — and App.tsx calls `clearProfileCaches()` on
// every profile change and sign-out, before the next profile's first request.
// __tests__/logic/profile-scope.test.ts reads the source and fails when a
// module-scope variable appears that is neither registered here nor listed
// there as not belonging to a profile.
//
// No imports: every module may import this one.
const clearers = new Map<string, () => void>();

/** `name` is the module's file name (one registration per module). */
export const registerProfileCache = (name: string, clear: () => void) => {
  clearers.set(name, clear);
};

export const clearProfileCaches = () => {
  for (const [name, clear] of clearers) {
    try {
      clear();
    } catch (e) {
      console.log('[profile] could not clear', name, (e as Error)?.message);
    }
  }
};

/** Test-only. */
export const registeredProfileCaches = () => [...clearers.keys()];
