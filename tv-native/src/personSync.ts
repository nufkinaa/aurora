// Settings that follow the person, kept in step with their profile.
// personPrefs.ts has the rules (which keys, what wins); this file does the
// reading, the writing and the remembering:
//
//   enterPerson(id)   a profile became active. What the box remembers of them
//                     applies at once (storage only), then the profile is
//                     asked and its values win. The first time a person is
//                     seen on this box, the box's old per-TV choices are
//                     offered to their profile (the one-time move).
//   setPersonPref     a change made here: applied and remembered at once,
//                     then written to the profile. If that fails it stays
//                     owed and goes with the next refresh.
//   refreshPerson()   ask the profile again — the server said it changed
//                     (`profile_updated`), the app came back to the front, or
//                     Settings was opened.
//   leavePerson()     the profile was left.
//
// Offline, or against a server too old to store a key, the remembered value
// keeps applying: nothing here can make a setting stop working.
import {api} from './api';
import {
  afterPush,
  changePerson,
  PersonKey,
  PersonPrefs,
  PersonRecord,
  readPerson,
  resolvePerson,
  seedFromBox,
} from './personPrefs';
import {registerProfileCache} from './profileScope';
import {loadBoxPrefs, loadPersonRecord, savePersonRecord, setPersonOverlay} from './storage';

let active: {id: string; rec: PersonRecord; effective: PersonPrefs} | null = null;
// what was already offered to a profile this run (a server too old to store a
// key would otherwise be sent it again on every refresh)
const offered = new Set<string>();
const subs = new Set<(p: PersonPrefs) => void>();
// the profile record as the server last gave it, for whoever keeps a copy
// (navSection's cache) — set by SessionWiring, so this file needs no screen code
let onProfileRead: ((id: string, prefs: Record<string, unknown>) => void) | null = null;
export const setProfileReadSink = (fn: typeof onProfileRead) => {
  onProfileRead = fn;
};

/** Called with the person's settings whenever they change (from here or from
 *  another device). */
export const onPersonPrefs = (fn: (p: PersonPrefs) => void) => {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
};
/** The active person's settings as known right now (null: nobody is in, or
 *  the box has not been read yet). */
export const personNow = (): PersonPrefs | null => (active ? active.effective : null);

const same = (a: PersonPrefs, b: PersonPrefs) => (Object.keys(a) as PersonKey[]).every(k => a[k] === b[k]);
const apply = (id: string, rec: PersonRecord, effective: PersonPrefs) => {
  const changed = !active || active.id !== id || !same(active.effective, effective);
  active = {id, rec, effective};
  setPersonOverlay(effective);
  savePersonRecord(id, rec);
  if (changed) for (const fn of subs) fn(effective);
};

const push = async (id: string, values: Partial<PersonPrefs>) => {
  if (!Object.keys(values).length) return;
  try {
    const answer = await api.updateProfile(id, {prefs: values as Record<string, string | boolean | null>});
    const said = (answer && (answer.prefs as Record<string, unknown>)) || {};
    onProfileRead?.(id, said);
    if (!active || active.id !== id) return;
    const rec = afterPush(active.rec, values, readPerson(said));
    apply(id, rec, resolvePerson(readPerson(said), rec).effective);
  } catch {
    // still owed: the next refresh sends it again
  }
};

let asking: Promise<void> | null = null;
export const refreshPerson = (): Promise<void> => {
  if (!active) return Promise.resolve();
  if (asking) return asking;
  const id = active.id;
  const mine = (asking = (async () => {
    let server: Partial<PersonPrefs> | null = null;
    try {
      const list = await api.profiles();
      const me = list.find(p => p.id === id);
      if (me) {
        const said = (me.prefs as Record<string, unknown>) || {};
        server = readPerson(said);
        onProfileRead?.(id, said);
      }
    } catch {
      // not reachable: what the box remembers holds
    }
    if (!active || active.id !== id) return;
    const r = resolvePerson(server, active.rec);
    apply(id, r.rec, r.effective);
    const owed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.push)) {
      // a choice made here is always sent; one merely remembered is offered once a run
      const tag = `${id}|${k}|${String(v)}`;
      if (!r.rec.dirty.includes(k as PersonKey) && offered.has(tag)) continue;
      offered.add(tag);
      owed[k] = v;
    }
    await push(id, owed as Partial<PersonPrefs>);
  })().finally(() => {
    if (asking === mine) asking = null;
  }));
  return mine;
};

export const enterPerson = (id: string) => {
  if (active && active.id === id) return;
  active = null;
  asking = null;
  let stale = false;
  const ready = (async () => {
    let rec = await loadPersonRecord(id);
    // never seen on this box: its old per-TV choices become this person's
    // (where their profile has none — resolvePerson, rule 3)
    if (!rec) rec = seedFromBox(await loadBoxPrefs());
    if (stale) return;
    const r = resolvePerson(null, rec);
    active = {id, rec: r.rec, effective: r.effective};
    setPersonOverlay(r.effective);
    savePersonRecord(id, r.rec);
    for (const fn of subs) fn(r.effective);
  })();
  entering = () => {
    stale = true;
  };
  // nothing of the last person's shows through while the box is read
  setPersonOverlay(null, ready);
  ready
    .then(() => {
      if (!stale) refreshPerson();
    })
    .catch(() => {});
};
// withdraws an enterPerson whose storage read has not come back yet
let entering: (() => void) | null = null;

export const leavePerson = () => {
  entering?.();
  entering = null;
  active = null;
  asking = null;
  setPersonOverlay(null);
};

/** A choice made on this TV. */
export const setPersonPref = <K extends PersonKey>(key: K, value: PersonPrefs[K]) => {
  if (!active) return;
  const id = active.id;
  const rec = changePerson(active.rec, key, value);
  apply(id, rec, resolvePerson(null, rec).effective);
  push(id, {[key]: value} as Partial<PersonPrefs>);
};

// Leaving a profile leaves its settings too (App.tsx → clearProfileCaches).
registerProfileCache('personSync', leavePerson);

/** Test-only. */
export const _personInternals = {
  reset: () => {
    leavePerson();
    offered.clear();
    subs.clear();
    onProfileRead = null;
  },
  record: (): PersonRecord | null => (active ? active.rec : null),
};
