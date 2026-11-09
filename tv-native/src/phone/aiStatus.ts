// Does this server (for this profile) have the AI recommender? — the website's
// rule for its AI tab (main.js: `GET /api/ai/status` → `enabled`), for the
// phone: whether More lists "AI" (docs/android-phone/NAV.md) and whether
// the AI pick page shows its form.
//
// Asked once per profile and kept: the answer is the profile's (a kids
// profile is always told `enabled: false`, src/lib/kids.js), so it is dropped
// when the profile is left (profileScope.ts). A failed ask is silent — it
// reads as "no AI" — and is NOT kept, so the next look asks again.
import {useEffect, useState} from 'react';
import {api} from '../api';
import {registerProfileCache} from '../profileScope';

// the answer for the profile that is in (null: not asked yet, or the ask failed)
let known: boolean | null = null;
// the ask on its way, shared by everyone who wants the answer meanwhile
let asking: Promise<boolean> | null = null;

registerProfileCache('phone/aiStatus', () => {
  known = null;
  asking = null;
});

/** The answer: kept after the first ask that came back, false (and not kept) when it failed. */
export function aiEnabled(): Promise<boolean> {
  if (known != null) return Promise.resolve(known);
  if (asking) return asking;
  const ask: Promise<boolean> = api.aiStatus().then(
    s => {
      const on = !!(s && s.enabled);
      // (an answer that lands after the profile was left is not the next profile's)
      if (asking === ask) known = on;
      return on;
    },
    () => false,
  );
  asking = ask;
  ask.finally(() => {
    if (asking === ask) asking = null;
  }).catch(() => {});
  return ask;
}

/** What is known without asking (null: nobody has asked yet for this profile). */
export const aiKnown = (): boolean | null => known;

/** For a list that names "AI pick": false until the server says yes. */
export function useAiEnabled(): boolean {
  const [on, setOn] = useState(known === true);
  useEffect(() => {
    let live = true;
    aiEnabled().then(v => live && setOn(v));
    return () => {
      live = false;
    };
  }, []);
  return on;
}
