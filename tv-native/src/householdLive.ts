// [household] The live half of household recommendations on the TV.
//
// THE PING. When someone recommends a title to this profile, the server sends
// the profile's open apps `{type: "household_recs", profile}` over the live
// socket — content-free on purpose (no title, no name). This TV then asks its
// own gated route (GET /api/profiles/:id/household?slim=1) and says what is
// new in a toast — "Dana recommended Dune" / "3 new recommendations from your
// household" (householdRecs.ts arrivalToast) — and Home's row is read again.
//
// THE SAME ARRIVAL IS NEVER TOASTED TWICE: `newest` is the newest
// recommendation time (the SERVER's clock — the two clocks never meet) this
// TV has already shown, from Home's row or an earlier ping; only what is newer
// is news. A repeat send (it only changes the note) moves no time, so it
// toasts nothing.
//
// THE TOAST HAS NO "Show" BUTTON on the TV: toasts here never take focus (a
// toast that grabbed the D-pad mid-browse would move what the viewer is on).
// The closest equivalent: the row on Home is up to date the moment the toast
// shows, and Show all is at the end of it.
//
// householdChanged() / onHouseholdChanged(): anything that changes what the
// row holds (a ping, Not for me, a send) tells Home, which reads its rows
// again the way it does on library_updated.
import {api} from './api';
import {arrivalToast, ltr, newestAt, HhCard} from './householdRecs';
import {registerProfileCache} from './profileScope';
import {onMessage} from './realtime';
import {showToast} from './toast';
import {track} from './usage';

let profile: string | null = null;
let newest = 0;
let asking = false;
const changeFns = new Set<() => void>();

/** Home (and the Show all page) re-read when this fires. Returns the unsubscribe. */
export const onHouseholdChanged = (fn: () => void) => {
  changeFns.add(fn);
  return () => {
    changeFns.delete(fn);
  };
};
export const householdChanged = () => {
  for (const fn of [...changeFns]) {
    try {
      fn();
    } catch {}
  }
};

/** What this TV has already shown (Home's household row, the Show all page): no toast for it. */
export const noteShown = (items: HhCard[] | null | undefined) => {
  newest = Math.max(newest, newestAt(items));
};

const check = async () => {
  const me = profile;
  if (!me || asking) return;
  asking = true;
  try {
    const r = await api.household(me);
    if (profile !== me) return;
    const items = (r.items || []) as HhCard[];
    const text = arrivalToast(items, newest);
    noteShown(items);
    if (text) {
      // (a line that starts with a Hebrew name still reads left to right: householdRecs.ts ltr)
      showToast(ltr(text), '💌');
      track('feat', {f: 'hhrec-toast'});
    }
  } catch {
    // no toast; the row is still read again below
  } finally {
    asking = false;
  }
  householdChanged();
};

/** SessionWiring: listen for the ping as `profileId`. Returns the unsubscribe. */
export const startHouseholdLive = (profileId: string) => {
  profile = profileId;
  const off = onMessage('household_recs', d => {
    if (String(d.profile || '') !== profile) return;
    check();
  });
  return () => {
    off();
    if (profile === profileId) profile = null;
  };
};

registerProfileCache('householdLive', () => {
  profile = null;
  newest = 0;
  asking = false;
});

/** Test-only. */
export const _householdLive = {check, state: () => ({profile, newest, asking})};
