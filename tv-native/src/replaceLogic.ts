// "Problem with this copy? → Get another version" — the words and the small
// decisions, PURE (no React, no network — its one import, releaseWords.ts, is
// pure too, as is voiceLogic.ts): components/ReplaceSheet.tsx draws them, the
// player, the title page and My downloads ask them, and the logic test runs
// this file as it is. The rules themselves are the server's
// (src/media/replace.js); the words are the website's, letter for letter.

import {isEarly, pickable, sourceBadge} from './releaseWords';
import {voiceActive, voiceMessage, VoiceState} from './voiceLogic';

export type ReplaceReason = {id: string; label: string};

/** The five reasons, as the server lists them (badreleases.REASONS) — used
 *  until the server's own list has arrived, so the sheet opens on them at once. */
export const REASONS: ReplaceReason[] = [
  {id: 'burned', label: 'Burned-in subtitles'},
  {id: 'picture', label: 'Bad picture'},
  {id: 'sound', label: 'Bad sound'},
  {id: 'language', label: 'Wrong language'},
  {id: 'other', label: 'Other'},
];

export const WORDS = {
  entry: 'Problem with this copy?',
  entrySub: 'Get another version',
  step1: "What's wrong with this copy?",
  // (nothing downloads on step 1: a reason leads to the list — Other first asks what is
  // wrong — and only a version picked there starts one: Jesse's report, 2026-11-08)
  step1Body: 'Pick one. Nothing downloads until you pick another version — your place, My List and ratings stay.',
  step2: 'Get another version',
  step2Body: 'Pick one and it starts downloading now. Your copy stays playable until the new one is in.',
  best: '★ BEST',
  none: 'No other versions found.',
  noProvider: "Couldn't reach the source provider.",
  started: "Getting another version — your copy stays playable until it's in.",
  activeHeading: 'Another version is on its way',
  cancel: 'Cancel — keep this copy',
  cancelled: 'Cancelled — your copy stays as it was.',
  // the question before Cancel: a stray OK on a TV remote must not end it
  cancelAsk: 'Cancel this version?',
  cancelAskBody: 'Your copy stays as it was. What has come down so far is thrown away.',
  keepGoing: 'Keep going',
  // the last try ended without replacing anything: what now
  endedHeading: "That version didn't come through",
  endedNext: 'Pick the next one, or keep this copy.',
  pickNext: 'Pick another version',
  otherReason: 'Something else is wrong',
  keepCopy: 'Keep this copy',
  waitingJob: 'Ready — waiting for nobody to be playing the old copy',
  // "Other" (Jesse's report, 2026-11-08: Other went straight on to a list of versions
  // and gave no way to say what was wrong): a few words first, then a CHOICE
  otherHeading: "What's wrong with it?",
  otherBody: 'A few words, so the admin knows what you saw or heard. Nothing downloads yet.',
  otherPlaceholder: 'What is wrong with this copy?',
  otherNext: 'Next',
  otherEmpty: "Say what's wrong first — a few words is enough.",
  askHeading: 'Get another version?',
  askBody: "Your words go to the admin either way. Another version downloads now and replaces this copy once it's in — or keep this copy and just send them.",
  askYes: 'Yes — pick another version',
  askNo: 'No — just send it',
  sent: 'Sent — thank you. Your copy stays as it was.',
  sayIt: 'Say it',
  listening: 'Listening… say what is wrong',
  stopListening: 'Stop',
} as const;

/** The reasons that ask for the person's own words before anything else. */
export const asksForNote = (reason: string | null | undefined): boolean => reason === 'other';

/** The longest note the server keeps (src/media/replace.js request: 300). */
export const COPY_NOTE_MAX = 300;
/** What the field holds: line breaks folded to spaces, cut at COPY_NOTE_MAX. */
export const copyNote = (v: string | null | undefined): string =>
  // eslint-disable-next-line no-control-regex
  Array.from(String(v || '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')).slice(0, COPY_NOTE_MAX).join('');
/** Words the microphone heard, added to what is typed already. */
export const addHeard = (note: string, heard: string): string => {
  const h = String(heard || '').trim();
  if (!h) return note;
  const n = String(note || '').replace(/\s+$/, '');
  return copyNote(n ? `${n} ${h}` : h);
};

/** The microphone button's word and the line under the field (useVoiceNote.ts). */
export const voiceNoteWords = (s: VoiceState): {label: string; line: string} => {
  if (voiceActive(s)) return {label: WORDS.stopListening, line: s.interim ? `“${s.interim}”` : s.phase === 'starting' ? voiceMessage(s, 'tv') : WORDS.listening};
  if (s.phase === 'error' && s.error !== 'cancelled') return {label: WORDS.sayIt, line: voiceMessage(s, 'tv')};
  return {label: WORDS.sayIt, line: ''};
};

/** The report for "Problem with this copy → Other → No, just send it": the first line
 *  is the server's own for a replacement ("Problem with this copy: Other — …",
 *  src/media/replace.js), so the admin reads both the same way; the context carries
 *  the words too (`note`). The website's replaceCopy.js says the same. */
export const copyReport = (o: {reasonLabel?: string | null; note: string}): string =>
  `Problem with this copy: ${o.reasonLabel || 'Other'} — ${String(o.note || '').replace(/\s+/g, ' ').trim()}\nNo other version asked for — the copy stays.`;

/** A replacement on its way, as GET /api/replace/:id says (publicOf). */
export type ReplacementLike = {
  status?: string | null;
  phase?: string | null;
  progress?: number | null;
  waiting?: boolean | null;
  reasonLabel?: string | null;
  mine?: boolean | null;
  by?: string | null;
};

/** The status line of a replacement — the website's replaceStatusText
 *  (public/js/replaceCopy.js), word for word. */
export const replaceStatusText = (r: ReplacementLike | null | undefined): string => {
  if (!r) return '';
  if (r.waiting) return 'Ready — it takes over once nobody is playing this copy.';
  if (r.status === 'done') return 'The new version is in.';
  if (r.status === 'pending') return 'Waiting for approval';
  if (r.status === 'approved') return 'Queued to download';
  if (r.status === 'downloading') {
    if (r.phase === 'copying') return 'Almost there…';
    const pct = Math.round((r.progress || 0) * 100);
    return pct > 0 ? `Downloading · ${pct}%` : 'Starting download…';
  }
  if (r.status === 'error') return 'The download failed — your copy stays as it was.';
  if (r.status === 'canceled' || r.status === 'declined') return 'Cancelled — your copy stays as it was.';
  return '';
};

/** "Reason: Burned-in subtitles". */
export const replaceReasonText = (r: ReplacementLike | null | undefined): string =>
  r && r.reasonLabel ? `Reason: ${r.reasonLabel}` : '';

/** The line under the status: a Cancel button for the one who asked, else who did. */
export const replaceWho = (r: ReplacementLike | null | undefined): {cancel: boolean; line: string | null} => {
  if (!r) return {cancel: false, line: null};
  if (r.mine) return {cancel: true, line: null};
  const by = typeof r.by === 'string' ? r.by.trim() : '';
  return {cancel: false, line: by ? `Asked for by ${by}` : null};
};

/** How the last try for this copy ended (src/media/replace.js lastOf): `line` is
 *  the server's sentence, printed as it is on all three clients. */
export type LastTry = {
  status: string;
  reason?: string | null;
  reasonLabel?: string | null;
  release?: string | null;
  quality?: string | null;
  line: string;
};

export type ReplaceView = {
  can?: boolean;
  why?: string | null;
  code?: string | null;
  active?: ReplacementLike | null;
  last?: LastTry | null;
  reasons?: ReplaceReason[] | null;
};

/** Which face the sheet shows for what GET /api/replace/:id answered:
 *  'active' (a replacement on its way), 'refused' (the server says no, and why),
 *  'ended' (the last try was cancelled or failed: what happened and what next),
 *  'reasons' (step 1). Before the answer arrives: 'reasons' (it opens on them).
 *  `skipEnded`: the person has moved on from that face. */
export const replaceFace = (v: ReplaceView | null | undefined, skipEnded = false): 'active' | 'refused' | 'ended' | 'reasons' => {
  if (!v) return 'reasons';
  if (v.active) return 'active';
  if (v.can === false) return 'refused';
  if (v.last && !skipEnded) return 'ended';
  return 'reasons';
};

/** What the person is told when a replacement of theirs ended without them: a
 *  failure, or the admin taking it back. Null when there is nothing to say (it
 *  landed, it is not theirs, or they cancelled it themselves and were told). */
export const replaceEndedToast = (j: {
  mine?: boolean;
  status?: string;
  title?: string | null;
  error?: string | null;
  canceledBy?: string | null;
  replaces?: unknown;
}): string | null => {
  if (!j.replaces || !j.mine) return null;
  const name = `“${j.title || 'that title'}”`;
  if (j.status === 'error') return `The other version of ${name} failed — your copy stays. Open “${WORDS.entry}” to pick the next one.`;
  if (j.status === 'declined') return `The admin said no to the other version of ${name} — your copy stays.`;
  if (j.status === 'canceled' && j.canceledBy === 'admin') return `The admin cancelled the other version of ${name} — your copy stays.`;
  return null;
};

/** The server's reasons when it sent a usable list, else the five above. */
export const reasonsOf = (v: ReplaceView | null | undefined): ReplaceReason[] => {
  const list = v && Array.isArray(v.reasons) ? v.reasons.filter(r => r && typeof r.id === 'string' && typeof r.label === 'string') : [];
  return list.length ? list : REASONS;
};

const fmtSize = (b?: number | null): string | null => {
  if (!b || b <= 0) return null;
  const gb = b / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
};

export type ReplaceStreamLike = {
  quality?: string | null;
  qualityLabel?: string | null;
  sizeString?: string | null;
  sizeBytes?: number | null;
  seeders?: number | null;
  release?: string | null;
  filename?: string | null;
  recommended?: boolean | null;
  cam?: boolean | null;
  prerelease?: string | null;
  hardsub?: boolean | null;
  badge?: string | null;
  warning?: string | null;
  dubbed?: boolean | null;
  badHere?: {reason?: string; label?: string | null} | null;
  // "Wrong language" (src/media/copylang.js): how this source fits, and its language
  langFit?: string | null;
  langLabel?: string | null;
  // the source the last try was for
  tried?: {status?: string; label?: string | null} | null;
};

/** One source row: quality, size, seeders, the release name; ★ BEST; the
 *  server's mark for what kind of copy it is ("CAM", "TS", "BURNED-IN SUBS"
 *  as a tag, "CAM — filmed in a cinema" as the `early` line — the title
 *  page's words, releaseWords.ts); a "Reported here" warning for a release
 *  somebody here already replaced. `reason` is the one picked on step 1: a
 *  person replacing a copy BECAUSE of burned-in subtitles is never pointed at
 *  another copy with burned-in subtitles as the ★ (there is no clean one
 *  left then, so no ★ at all). */
export const replaceRowText = (
  s: ReplaceStreamLike,
  reason?: string | null,
): {quality: string; name: string; meta: string; best: string | null; warn: string | null; early: string | null; tags: string[]} => {
  const quality = s.quality || s.qualityLabel || 'SD';
  const size = s.sizeString || fmtSize(s.sizeBytes);
  const seeds = typeof s.seeders === 'number' ? `${s.seeders} seeder${s.seeders === 1 ? '' : 's'}` : null;
  const tags = [s.langLabel || null, sourceBadge(s), s.dubbed ? 'Dub' : null].filter(Boolean) as string[];
  const best = !!s.recommended && pickable(s) && !(reason === 'burned' && s.hardsub);
  return {
    quality,
    name: s.release || s.filename || '',
    meta: [quality, size, seeds].filter(Boolean).join(' · '),
    best: best ? WORDS.best : null,
    warn: s.badHere ? `Reported here: ${s.badHere.label || 'a problem'}` : s.tried ? s.tried.label || null : null,
    early: isEarly(s) || s.hardsub ? s.warning || null : null,
    tags,
  };
};

/** Picking a copy made before the film is out at home is asked about first —
 *  the title page's words (releaseWords.ts EARLY_CONFIRM, "Download it
 *  anyway": a replacement is a download). */
export const replaceAsksFirst = (s: ReplaceStreamLike | null | undefined): boolean => isEarly(s);

/** The failure line of the source list: the server's own words, else the fallback. */
export const sourcesError = (e: unknown): string => {
  const m = e && typeof e === 'object' && typeof (e as {message?: unknown}).message === 'string' ? (e as {message: string}).message : '';
  // a bare status line ("502 /api/replace/…") is not words for a person
  return m && !/^\d{3} \//.test(m) ? m : WORDS.noProvider;
};

/** Where the entry is offered — the website's rule: only on a copy that IS
 *  in the library (never a stream from a torrent, never a title or an episode
 *  that is not on disk), never to a kids profile (the profile's `kids` set),
 *  and not while the admin has torrents switched off. The server still
 *  decides who may; the sheet shows its "why not" if it refuses anyway. */
export const replaceOffered = (o: {
  libraryId?: string | null;
  isTorrent?: boolean;
  kids?: {maxAge?: number} | boolean | null;
  torrentsOff?: boolean;
}): boolean =>
  !!o.libraryId && !o.isTorrent && !String(o.libraryId).startsWith('torrent|') && !o.kids && !o.torrentsOff;

/** A download that is a replacement, finished and waiting for the old copy to
 *  be free: its line on My downloads instead of the usual phase text. */
export const replaceJobLine = (j: {status?: string; replaceWait?: boolean | null}): string | null =>
  j.replaceWait && !['done', 'error', 'declined', 'canceled', 'removed'].includes(j.status || '') ? WORDS.waitingJob : null;
