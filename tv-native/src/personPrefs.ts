// SETTINGS THAT FOLLOW THE PERSON — the rules, and nothing else.
// PURE: no imports, so the logic tests run it as it is (personSync.ts does
// the reading, writing and remembering around it).
//
// Until 2026-10-10 every choice under Settings was kept on the BOX
// (`aurora.prefs` in AsyncStorage): whoever watched on this TV got whatever
// the last person set, a choice made on the website never arrived here, and a
// person who had switched usage stats off on the website was still reported
// from the TV. Now each setting has one of two homes:
//
//   PERSON — stored on the profile (the server's `prefs`, src/profiles.js
//   update), the same on the website and on every TV:
//     autoplayNext    play the next episode by itself          default on
//     subsDefault     subtitles on by themselves               default on
//     subLang         subtitle language: any | he | en | ru    default any
//     usageStats      usage stats (the server also refuses a
//                     batch from a profile that said no)       default on
//     smartDownloads  get the next episode ready               default on
//     smartCleanup    tidy up after watching                   default on
//   (the liked genres, the last subtitle pick and the last dub were already
//   on the profile, through their own calls)
//
//   DEVICE — stays in `aurora.prefs` on this box, because it is about this
//   screen and not about the person:
//     cueSize, cueBackground   how subtitles are drawn at this distance
//     heroTrailers             trailers on Home's billboard (a weak box)
//     downloadNotices          this TV's notifications
//
// A key the profile does not carry means "the default".

export type SubLang = 'any' | 'he' | 'en' | 'ru';
export type PersonPrefs = {
  autoplayNext: boolean;
  subsDefault: boolean;
  subLang: SubLang;
  usageStats: boolean;
  smartDownloads: boolean;
  smartCleanup: boolean;
};
export type PersonKey = keyof PersonPrefs;

export const PERSON_DEFAULTS: PersonPrefs = {
  autoplayNext: true,
  subsDefault: true,
  subLang: 'any',
  usageStats: true,
  smartDownloads: true,
  smartCleanup: true,
};
export const PERSON_KEYS = Object.keys(PERSON_DEFAULTS) as PersonKey[];
export const DEVICE_KEYS = ['cueSize', 'cueBackground', 'heroTrailers', 'downloadNotices'] as const;
export const SUB_LANGS: SubLang[] = ['any', 'he', 'en', 'ru'];

const valid = (key: PersonKey, value: unknown): boolean =>
  key === 'subLang' ? SUB_LANGS.includes(value as SubLang) : typeof value === 'boolean';

/** The person-level keys out of anything (the server's `prefs`, a stored
 *  blob), keeping only values of the right kind. */
export const readPerson = (from: unknown): Partial<PersonPrefs> => {
  const out: Partial<PersonPrefs> = {};
  if (!from || typeof from !== 'object') return out;
  const src = from as Record<string, unknown>;
  for (const k of PERSON_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k) && valid(k, src[k])) (out as Record<string, unknown>)[k] = src[k];
  }
  return out;
};

// What this box remembers of one person: the values it knows, and which of
// them were changed HERE and have not reached the server yet.
export type PersonRecord = {v: Partial<PersonPrefs>; dirty: PersonKey[]};
export const emptyRecord = (): PersonRecord => ({v: {}, dirty: []});
export const readRecord = (raw: unknown): PersonRecord | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {v?: unknown; dirty?: unknown};
  const v = readPerson(r.v);
  const dirty = Array.isArray(r.dirty) ? PERSON_KEYS.filter(k => (r.dirty as unknown[]).includes(k) && k in v) : [];
  return {v, dirty};
};

/** THE ONE-TIME MOVE. The first time a person is seen on a box that used to
 *  keep these choices for everyone, the box's value becomes that person's —
 *  only where it is a real choice (not the default), and, by `resolve` below,
 *  only if their profile says nothing about it. */
export const seedFromBox = (box: unknown): PersonRecord => {
  const had = readPerson(box);
  const v: Partial<PersonPrefs> = {};
  for (const k of PERSON_KEYS) {
    if (k in had && had[k] !== PERSON_DEFAULTS[k]) (v as Record<string, unknown>)[k] = had[k];
  }
  return {v, dirty: []};
};

export type Resolved = {
  /** what applies right now */
  effective: PersonPrefs;
  /** what to send to the profile (empty when there is nothing to send) */
  push: Partial<PersonPrefs>;
  /** what the box remembers afterwards */
  rec: PersonRecord;
};

/** What applies, given what the profile says (`server`: its person-level
 *  keys, or NULL when the server could not be asked) and what this box
 *  remembers. Per key, in this order:
 *    1. changed on this TV and not yet delivered  → that value, sent again
 *    2. the profile says                          → the profile's value
 *    3. the box remembers one (the one-time move, or a server too old to
 *       store the key)                            → it, and it is offered
 *                                                   to the profile when it is
 *                                                   not just the default
 *    4. nothing anywhere                          → the default
 *  With no server (offline) nothing is sent and the remembered values hold. */
export const resolvePerson = (server: Partial<PersonPrefs> | null, rec: PersonRecord): Resolved => {
  const effective = {...PERSON_DEFAULTS} as Record<string, unknown>;
  const push: Record<string, unknown> = {};
  const v = {...rec.v} as Record<string, unknown>;
  for (const k of PERSON_KEYS) {
    const mine = Object.prototype.hasOwnProperty.call(rec.v, k);
    if (mine && rec.dirty.includes(k)) {
      effective[k] = rec.v[k];
      if (server) push[k] = rec.v[k];
    } else if (server && Object.prototype.hasOwnProperty.call(server, k)) {
      effective[k] = server[k];
      v[k] = server[k];
    } else if (mine) {
      effective[k] = rec.v[k];
      if (server && rec.v[k] !== PERSON_DEFAULTS[k]) push[k] = rec.v[k];
    }
  }
  return {
    effective: effective as PersonPrefs,
    push: push as Partial<PersonPrefs>,
    rec: {v: v as Partial<PersonPrefs>, dirty: rec.dirty.filter(k => k in v)},
  };
};

/** A choice made on this TV: remembered at once, and owed to the profile. */
export const changePerson = <K extends PersonKey>(rec: PersonRecord, key: K, value: PersonPrefs[K]): PersonRecord => ({
  v: {...rec.v, [key]: value},
  dirty: rec.dirty.includes(key) ? rec.dirty : [...rec.dirty, key],
});

/** The profile answered a write of `sent` with `answer` (its person-level
 *  keys now). What was sent is no longer owed — unless it changed again here
 *  while the write was on its way. A server too old to store a key answers
 *  without it: the box keeps its own value for that key (rule 3 above). */
export const afterPush = (rec: PersonRecord, sent: Partial<PersonPrefs>, answer: Partial<PersonPrefs>): PersonRecord => {
  const v = {...rec.v} as Record<string, unknown>;
  const settled: PersonKey[] = [];
  for (const k of PERSON_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(sent, k)) continue;
    if (rec.v[k] !== sent[k]) continue; // changed again meanwhile: still owed
    settled.push(k);
    if (Object.prototype.hasOwnProperty.call(answer, k)) v[k] = answer[k];
  }
  return {v: v as Partial<PersonPrefs>, dirty: rec.dirty.filter(k => !settled.includes(k))};
};

// ---- the subtitle language, in words ----
export const SUB_LANG_LABEL: Record<SubLang, string> = {
  any: 'First available',
  he: 'Hebrew',
  en: 'English',
  ru: 'Russian',
};
