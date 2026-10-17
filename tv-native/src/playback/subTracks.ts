// Subtitle and audio tracks as the player shows and picks them. PURE apart
// from lang.ts (itself pure) — the logic tests run it as it is.
//
//   buildTracks   the server's subtitle list → the menu's tracks (unique key,
//                 a readable label)
//   autoPick      which subtitle track switches on by itself, and which
//                 language a later-arriving track should still switch it to
//   audioName     a dub's name for the menu
import {bestTrackIndex, langCode, langOf, Lang, normPick, SubPick} from '../lang';

// ------------------------------------------------------------- languages
// ISO 639-1 and both 639-2 forms (bibliographic / terminology), plus the old
// "iw" for Hebrew. What is not here is shown as its code, in capitals.
const NAMES: Record<string, string> = {
  en: 'English', eng: 'English', he: 'Hebrew', heb: 'Hebrew', iw: 'Hebrew', fr: 'French', fre: 'French', fra: 'French',
  de: 'German', ger: 'German', deu: 'German', es: 'Spanish', spa: 'Spanish', it: 'Italian', ita: 'Italian',
  ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean', ru: 'Russian', rus: 'Russian',
  pt: 'Portuguese', por: 'Portuguese', zh: 'Chinese', chi: 'Chinese', zho: 'Chinese', hi: 'Hindi', hin: 'Hindi',
  ar: 'Arabic', ara: 'Arabic', tr: 'Turkish', tur: 'Turkish', pl: 'Polish', pol: 'Polish', nl: 'Dutch',
  dut: 'Dutch', nld: 'Dutch', sv: 'Swedish', swe: 'Swedish', no: 'Norwegian', nor: 'Norwegian', nb: 'Norwegian',
  nob: 'Norwegian', nn: 'Norwegian', nno: 'Norwegian', da: 'Danish',
  dan: 'Danish', fi: 'Finnish', fin: 'Finnish', cs: 'Czech', cze: 'Czech', ces: 'Czech', hu: 'Hungarian',
  hun: 'Hungarian', el: 'Greek', gre: 'Greek', ell: 'Greek', th: 'Thai', tha: 'Thai', uk: 'Ukrainian',
  ukr: 'Ukrainian', ro: 'Romanian', rum: 'Romanian', ron: 'Romanian', fa: 'Persian', per: 'Persian', fas: 'Persian',
  id: 'Indonesian', ind: 'Indonesian', vi: 'Vietnamese', vie: 'Vietnamese', ta: 'Tamil', tam: 'Tamil',
  te: 'Telugu', tel: 'Telugu', ms: 'Malay', may: 'Malay', msa: 'Malay', tl: 'Filipino', fil: 'Filipino', tgl: 'Filipino',
  bg: 'Bulgarian', bul: 'Bulgarian', hr: 'Croatian', hrv: 'Croatian', sr: 'Serbian', srp: 'Serbian',
  sk: 'Slovak', slo: 'Slovak', slk: 'Slovak', sl: 'Slovenian', slv: 'Slovenian', et: 'Estonian', est: 'Estonian',
  lv: 'Latvian', lav: 'Latvian', lt: 'Lithuanian', lit: 'Lithuanian', is: 'Icelandic', ice: 'Icelandic', isl: 'Icelandic',
  ca: 'Catalan', cat: 'Catalan', eu: 'Basque', baq: 'Basque', eus: 'Basque', gl: 'Galician', glg: 'Galician',
  be: 'Belarusian', bel: 'Belarusian', ka: 'Georgian', geo: 'Georgian', kat: 'Georgian', hy: 'Armenian', arm: 'Armenian', hye: 'Armenian',
  bn: 'Bengali', ben: 'Bengali', ur: 'Urdu', urd: 'Urdu', yi: 'Yiddish', yid: 'Yiddish', am: 'Amharic', amh: 'Amharic',
  sq: 'Albanian', alb: 'Albanian', sqi: 'Albanian', mk: 'Macedonian', mac: 'Macedonian', mkd: 'Macedonian',
  bs: 'Bosnian', bos: 'Bosnian', kk: 'Kazakh', kaz: 'Kazakh', az: 'Azerbaijani', aze: 'Azerbaijani',
  uz: 'Uzbek', uzb: 'Uzbek', lat: 'Latin', la: 'Latin', cy: 'Welsh', wel: 'Welsh', cym: 'Welsh', ga: 'Irish', gle: 'Irish',
};
const NO_LANGUAGE = /^(und|mis|zxx|mul|unk|unknown|none|qaa)$/i;
// (a fixed table, not state: an array, so profile-scope.test.ts does not ask whose it is)
const KNOWN_NAMES: readonly string[] = Object.values(NAMES).map(n => n.toLowerCase());

/** A language tag as a name: "heb" / "he" / "iw" / "he-IL" → "Hebrew", an
 *  unknown 2-3 letter code → that code in capitals, a name written out
 *  ("english") → "English", nothing / "und" → ''. */
export const langName = (tag: unknown): string => {
  if (typeof tag !== 'string') return '';
  const raw = tag.trim();
  if (!raw || NO_LANGUAGE.test(raw)) return '';
  const code = raw.toLowerCase().split(/[-_]/)[0];
  if (Object.prototype.hasOwnProperty.call(NAMES, code)) return NAMES[code];
  if (/^[a-z]{2,3}$/.test(code)) return NO_LANGUAGE.test(code) ? '' : code.toUpperCase();
  if (KNOWN_NAMES.includes(raw.toLowerCase())) return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return '';
};

// ------------------------------------------------------------- audio names
// Words an audio stream's TITLE is often made of that say nothing a viewer
// needs: the codec, the channel layout, "Track 1". (The menu's tag already
// shows the codec and the channels.)
const TECH = /^(?:stereo|mono|surround|dual|\d(?:\.\d)?(?:ch)?|\d+ch|ch|channels?|aac(?:-?lc)?|he-?aac|ac-?3|e-?ac-?3|ddp?\+?(?:\d(?:\.\d)?)?|dolby|digital|plus|dts(?:-?hd)?|hd|ma|hra|es|x|truehd|true|atmos|flac|pcm|lpcm|opus|vorbis|mp[23]|lossless|\d+\s*kbps|kbps|\d+k|audio|track|sound|stream|default|main|#?\d+)$/i;
// All-capital short words that DO mean something (audio description, Russian
// voice-over kinds, a dub).
const KEEP_CAPS = /^(?:AD|SDH|MVO|DVO|AVO|VO|DUB|DUBBED|ORIGINAL)$/;
const allTech = (s: string) => {
  const words = s.split(/[\s,/|·:;()[\]{}_]+/).filter(Boolean);
  // "DTS-HD" and "E-AC-3" are one word to TECH; "AC3-5.1" is two
  const techWord = (w: string) => TECH.test(w) || (w.includes('-') && w.split('-').every(p => !p || TECH.test(p)));
  return words.length > 0 && words.every(techWord);
};
// A release group or a scene tag: one word, no spaces, made of dotted /
// dashed parts ("YTS.MX", "x264-SPARKS"), bracketed ("[RARBG]"), or a
// short all-capitals tag ("FGT").
const releaseTag = (s: string) => {
  if (/\s/.test(s)) return false;
  if (/^[[(].*[\])]$/.test(s)) return true;
  if (/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)+$/.test(s) && !/^\d+(?:\.\d+)?$/.test(s)) return true;
  return /^[A-Z0-9]{2,10}$/.test(s) && !KEEP_CAPS.test(s) && /[A-Z]/.test(s);
};

/** What an audio stream's own title adds to its language, or '' when it adds
 *  nothing ("Track 1", "Stereo", "5.1", "AC3 5.1", "English", "FGT"). */
export const audioTitleExtra = (title: unknown, lang: string, tag?: unknown): string => {
  const t = typeof title === 'string' ? title.trim() : '';
  if (!t || allTech(t) || releaseTag(t)) return '';
  // the language said again, alone or with technical words ("English 5.1")
  let rest = t;
  const names = [lang, typeof tag === 'string' ? tag.trim() : ''].filter(Boolean);
  for (const n of names) rest = rest.replace(new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-z]|$)`, 'gi'), '$1');
  rest = rest.replace(/^[\s\-–—·:,|/()[\]]+|[\s\-–—·:,|/()[\]]+$/g, '');
  if (!rest || allTech(rest)) return '';
  return t;
};

export type AudioLike = {index: number; language?: string | null; title?: string | null; label?: string | null};

/** The fallback name of a dub (a server that sends no `label`): the language,
 *  the track's own title when it adds something ("English · Commentary"),
 *  else "Track N". */
export const audioLabel = (t: AudioLike): string => {
  const lang = langName(t.language);
  const extra = audioTitleExtra(t.title, lang, t.language);
  if (lang && extra) return extra.toLowerCase().includes(lang.toLowerCase()) ? extra : `${lang} · ${extra}`;
  return lang || extra || `Track ${t.index + 1}`;
};
/** A dub's name for the menu: the server's `label` (final and unique) when it
 *  sends one, else audioLabel. */
export const audioName = (t: AudioLike): string => {
  const l = typeof t.label === 'string' ? t.label.trim() : '';
  return l || audioLabel(t);
};

// ------------------------------------------------------------- subtitle tracks
export type SubLike = {
  label: string;
  url: string;
  lang?: string;
  embedded?: boolean;
  forced?: boolean;
  sdh?: boolean;
  // the server's ★ — "Matches this release" (lang.ts bestTrackIndex prefers it)
  star?: boolean;
};
export type Track<T extends SubLike = SubLike> = T & {key: string};

// A label that names no language: an older server's "Track 4" for an
// untagged embedded stream, the scanner's "Subtitles" for a sidecar with the
// video's own name.
const GENERIC_LABEL = /^(?:track\s*\d*|subtitles?|subs?|text\s*\d*|\d+)$/i;

/** The label a track is shown with: the server's, except where it names no
 *  language and the track's `lang` does ("Track 4" + lang "fr" → "French";
 *  with the forced / sdh flags, "French (Forced)"). */
export const subLabel = (t: SubLike, i: number): string => {
  const label = typeof t.label === 'string' ? t.label.trim() : '';
  if (label && !GENERIC_LABEL.test(label)) return label;
  const name = langName(t.lang);
  if (name) return `${name}${t.forced ? ' (Forced)' : t.sdh ? ' (SDH)' : ''}`;
  return label || `Track ${i + 1}`;
};

/** The menu's tracks: one per file (the same url twice is noise), each with a
 *  stable unique `key`. Two tracks that would read the same are numbered —
 *  "English", "English (2)" — on screen as well as in the key, so the menu
 *  never shows two identical rows. Appending tracks never changes the keys of
 *  the ones already there (the current selection is a key). */
export const buildTracks = <T extends SubLike>(subs: T[]): Track<T>[] => {
  const seen = new Map<string, number>();
  const out: Track<T>[] = [];
  const urls = new Set<string>();
  for (const [i, t] of subs.entries()) {
    if (!t || !t.url || urls.has(t.url)) continue;
    urls.add(t.url);
    const base = subLabel(t, i);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const shown = n > 1 ? `${base} (${n})` : base;
    out.push({...t, label: shown, key: shown});
  }
  return out;
};

// ------------------------------------------------------------- the auto pick
// The person's settings and this box's memory of a hand pick (storage.ts
// Prefs has these fields).
export type PickPrefs = {
  subsDefault: boolean;
  subLang: string;
  lastSubSet: boolean;
  lastSubLang: string | null;
  lastSubLabel: string | null;
  lastSubProfile: string | null;
};

/** The last subtitle choice made BY HAND, as a language — "off", "he", "en",
 *  "ru" — or null for nothing remembered.
 *  The profile's own memory first (`subPick` on the server: every pick, here,
 *  on the website or on another TV, lands there). This box's copy (lastSub*)
 *  only when the profile says nothing — AND only when it was made by the
 *  person who is watching: it is one copy for the whole box, so without that
 *  check whoever last pressed "Off" on this TV switched subtitles off for
 *  everyone whose profile had no pick of its own (Dor, 2026-10-17: "on Android
 *  TV subtitles are not working", default language set). A copy from a build
 *  before `lastSubProfile` existed names nobody, and is not used. */
export const rememberedPick = (prefs: PickPrefs, profileId: string | null | undefined, profileSub?: string | null): SubPick | null => {
  const fromProfile = normPick(profileSub);
  if (fromProfile) return fromProfile;
  if (!prefs.lastSubSet || !profileId || prefs.lastSubProfile !== profileId) return null;
  if (!prefs.lastSubLang && !prefs.lastSubLabel) return 'off';
  return langOf({lang: prefs.lastSubLang, label: prefs.lastSubLabel});
};

export type AutoPick = {
  /** the track to switch on, -1 for none */
  index: number;
  /** a language this title has no track in YET that would win if one
   *  arrived (a remembered pick, else the Settings language) — tracks keep
   *  arriving after the start (OpenSubtitles, a torrent's own files, the
   *  server's fetch), and the pick follows them until the viewer picks by
   *  hand. null: nothing better can come. */
  upgradeTo: Lang | null;
  why: 'off' | 'remembered' | 'setting' | 'first' | 'none' | 'subs-off';
};

/** Which subtitle track switches on by itself — the website's
 *  autoTrackIndex (public/js/screens/player.js), same precedence:
 *   1. the last pick made BY HAND (rememberedPick): "off" stays off; a
 *      language finds its best track again (lang.ts bestTrackIndex: a full
 *      track before SDH before forced, among equals the first listed);
 *   2. the title has nothing in that language, or nothing was ever picked:
 *      Settings — "subtitles on by themselves" (subsDefault) in the chosen
 *      language (subLang), and with "First available" or a title that has
 *      nothing in that language, the first track. */
export const autoPick = (
  tracks: SubLike[],
  prefs: PickPrefs,
  profileId: string | null | undefined,
  profileSub?: string | null,
): AutoPick => {
  const last = rememberedPick(prefs, profileId, profileSub);
  if (last === 'off') return {index: -1, upgradeTo: null, why: 'off'};
  let upgradeTo: Lang | null = null;
  if (last) {
    const i = bestTrackIndex(tracks, last);
    if (i >= 0) return {index: i, upgradeTo: null, why: 'remembered'};
    upgradeTo = last;
  }
  if (!prefs.subsDefault) return {index: -1, upgradeTo, why: 'subs-off'};
  const want = langCode(prefs.subLang);
  if (want) {
    const i = bestTrackIndex(tracks, want);
    if (i >= 0) return {index: i, upgradeTo, why: 'setting'};
    upgradeTo = upgradeTo || want;
  }
  if (!tracks.length) return {index: -1, upgradeTo, why: 'none'};
  return {index: 0, upgradeTo, why: 'first'};
};

/** What the player does with a fresh autoPick, given what is on now
 *  (`cur`: the track key on screen, null for none; `curUsable`: it is still
 *  in the list and has not failed to load).
 *    first decision → exactly the pick, off included;
 *    afterwards     → only ever ON, or to a different track (the language
 *                     the pick was waiting for, or past a track that failed);
 *                     never off by itself, except away from a failed track.
 *  `announce`: say "… found — switched on" (not after a failure, which said
 *  its own thing already). */
export const followPick = (o: {first: boolean; cur: string | null; curUsable: boolean; pickKey: string | null}): {
  change: boolean;
  key: string | null;
  announce: boolean;
} => {
  if (o.first) return {change: true, key: o.pickKey, announce: false};
  if (o.pickKey === o.cur) return {change: false, key: o.cur, announce: false};
  const curBad = !!o.cur && !o.curUsable;
  if (!o.pickKey) return curBad ? {change: true, key: null, announce: false} : {change: false, key: o.cur, announce: false};
  return {change: true, key: o.pickKey, announce: !curBad};
};

/** Whether the file already has a track in `lang` (the auto-fetch asks the
 *  server for one only when it does not). */
export const hasLang = (tracks: SubLike[] | null | undefined, lang: string | null | undefined): boolean =>
  bestTrackIndex(tracks || [], lang) >= 0;
