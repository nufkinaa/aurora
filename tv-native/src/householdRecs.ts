// Household recommendations on the TV — the PURE half: every word the TV
// prints, the rules of the person picker, the key of a title and what a send
// carries. The website says the same words (docs/qa/household-recs/DESIGN.md,
// "Words"); the server's own word functions are src/media/household.js
// `names` / `fromLine`, and __tests__/logic/household-recs.test.ts holds the
// two to the letter. No React Native, no network: the screens, the sheet and
// householdLive.ts (the live-socket half) call into this.

export const NOTE_MAX = 140;
export const ROW_MAX = 15;

// ---------- the words (the table, to the letter) ----------
export const WORDS = {
  rowTitle: 'Recommended by your household',
  showAll: 'Show all recommended',
  pageTitle: 'Recommended by your household',
  tabForYou: 'For you',
  tabSent: 'You sent',
  everyone: 'Everyone',
  emptyForYou: 'Nothing recommended to you yet. When someone in your household recommends a film or a show, it shows up here.',
  emptySent: "You haven't recommended anything yet. Press Recommend on any film or show.",
  recommend: 'Recommend',
  pickerLine: 'Pick who should see it',
  notePlaceholder: 'Add a note (optional)',
  send: 'Send',
  addToList: 'Add to My List',
  inList: 'In My List',
  notForMe: 'Not for me',
  undo: 'Undo',
  hidden: 'Hidden from your recommendations',
  settingsSection: 'Recommendations',
  settingsSwitch: 'Recommendations from the household',
  settingsSwitchNote: 'People on this server can recommend films and shows to you. They show on Home.',
  muteLine: "Mute someone and their recommendations stop reaching you. They aren't told.",
  mute: 'Mute',
  muted: 'Muted',
} as const;

/** "Dana" · "Dana and Avi" · "Dana and 2 others" (server: household.js `names`). */
export const names = (list: (string | null | undefined)[]): string => {
  const n = list.filter(Boolean) as string[];
  if (n.length === 0) return '';
  if (n.length === 1) return n[0];
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  return `${n[0]} and ${n.length - 1} others`;
};
/** A card's line: "From Dana and Avi" (server: household.js `fromLine`). */
export const fromLine = (list: (string | null | undefined)[]): string => (list.length ? `From ${names(list)}` : '');
/** The row's quiet line while some are unseen: "1 new" / "3 new". */
export const newLine = (unseen: number): string => (unseen > 0 ? `${unseen} new` : '');
/** The title page / peek banner: "Recommended by Dana and Avi". */
export const bannerLine = (from: {name: string}[]): string =>
  from.length ? `Recommended by ${names([...new Set(from.map(f => f.name))])}` : '';
/** One note under the banner: “note” — Dana. */
export const noteLine = (note: string, by: string): string => `“${note}” — ${by}`;
/** The notes worth a line, newest first (the server sends them newest first). */
export const notesOf = (from: {name: string; note?: string | null}[]): string[] =>
  from.filter(f => f.note && String(f.note).trim()).map(f => noteLine(String(f.note).trim(), f.name));
/** noteLine as drawn: a Hebrew note or name keeps its own direction, the line reads left to right. */
export const noteLineShown = (note: string, by: string): string => ltr(`“${iso(note)}” — ${iso(by)}`);
/** notesOf as drawn. */
export const notesShown = (from: {name: string; note?: string | null}[]): string[] =>
  from.filter(f => f.note && String(f.note).trim()).map(f => noteLineShown(String(f.note).trim(), f.name));
/** "<name> · <word>" (a mute chip, a You sent status) as drawn. */
export const nameWord = (name: string, word: string): string => ltr(`${iso(name)} · ${word}`);
// ---------- right-to-left names in a left-to-right app ----------
// Android sets a line's direction from its FIRST strong letter: "נועם recommended Dune" became a
// right-to-left line, its English words drawn on the wrong side of the name ("recommended Dune
// נועם", Mi TV), and "נועם · Mute" read "Mute · נועם". Lines that may START with a person's name, a
// note or a title are given an invisible left-to-right mark first, and each name / note is
// fenced off with marks so its own letters still run right to left. The WORDS stay exactly the table's — the
// marks are not letters (a test strips them and compares).
const LRM = '‎';
/** A line that reads left to right whatever its first word is. */
export const ltr = (s: string): string => (s ? LRM + s : s);
/** One name / note / title kept whole inside a left-to-right line: a mark on each side closes its
 *  right-to-left run, so the quote marks, the dash and the words after it stay where they are
 *  written. (The Unicode isolates FSI…PDI are the textbook way; the Mi TV's text stack ignored
 *  them, and a Hebrew note came out as "name — ”note“".) A Latin name is left as it is. */
export const iso = (s: string): string => (s && /[֐-ࣿיִ-﷿ﹰ-ﻼ]/.test(s) ? LRM + s + LRM : s);
/** Drops the marks again (the tests; anything that compares words). */
export const plain = (s: string): string => String(s || '').replace(/[‎‏⁦-⁩]/g, '');

/**
 * The card's "From …" line in two pieces, each drawn on ONE line of its own (Card.tsx): the first
 * sender, then the rest. Left to Android, "From Maximiliana Rosenthal" broke after "From" and
 * "From Dana and Avi" broke wherever the width ran out, so the cards of one row had their words
 * at three different heights. Split at the names the server put in (hh.from, newest first — the
 * order household.js `names` uses), so a name with "and" in it stays whole; without them, at the
 * first " and ". Together the two pieces are the server's line, word for word.
 *   "From Dana"                → ["From Dana", ""]
 *   "From Dana and Avi"        → ["From Dana", "and Avi"]
 *   "From Dana and 10 others"  → ["From Dana", "and 10 others"]
 */
export const cardLines = (meta: string | null | undefined, from?: {name?: string | null}[] | null): [string, string] => {
  const m = String(meta || '').trim();
  if (!m) return ['', ''];
  const first = from && from[0] && from[0].name ? `From ${from[0].name}` : '';
  if (first && m.startsWith(first)) {
    const rest = m.slice(first.length).trim();
    if (!rest) return [m, ''];
    if (rest.startsWith('and ')) return [first, rest];
  }
  const at = m.indexOf(' and ', 'From '.length);
  return at > 0 ? [m.slice(0, at), m.slice(at + 1)] : [m, ''];
};
/** The two card lines as drawn: names isolated (a Hebrew name never flips the line). */
export const cardLinesShown = (meta: string | null | undefined, from?: {name?: string | null}[] | null): [string, string] => {
  const [a, b] = cardLines(meta, from);
  const names = (from || []).map(f => String(f.name || '')).filter(n => iso(n) !== n);
  const mark = (s: string) => {
    let out = s;
    for (const n of names) out = out.split(n).join(iso(n));
    return ltr(out);
  };
  return [mark(a), mark(b)];
};

/** The picker's title: Recommend “Dune”. */
export const pickerTitle = (title: string): string => `Recommend “${title}”`;
/** The send button: "Send" (nobody picked — and then it does nothing) · "Send to N". */
export const sendLabel = (picked: number): string => (picked > 0 ? `Send to ${picked}` : WORDS.send);

// ---------- the note ----------
/** As the server keeps it: one line, no control characters, at most NOTE_MAX code points. */
export const cleanNote = (v: unknown): string => {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const one = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(one).slice(0, NOTE_MAX).join('');
};
// ---- the note field and the D-pad (RecommendSheet.tsx) ----
// JS hears a D-pad press only when its key comes UP, after the focus engine moved on the
// key-DOWN — later by however long the key was held — and a focus event can also reach JS
// a moment after its own key event (an injected key). So which press a key event is, is
// read from the ORDER of events, with slack for the late focus event: on the Mi TV a focus
// event reached JS more than 80 ms after its own (injected) key event, and the next press
// was then read as one made in the field (DOWN from the faces jumped to Send).
export const NOTE_SAME_PRESS_MS = 300;
/** A key event while the picker is up: 'arrived' (this press brought focus to the field —
 *  done), 'elsewhere' (not the field's press), or 'field' (made in the field: the sheet
 *  sends DOWN to Send and UP to the faces itself, Android's search from the cursor being
 *  wrong for a long note). */
export const notePress = (o: {inField: boolean; gotAt: number; leftAt: number; prevKeyAt: number}): 'arrived' | 'elsewhere' | 'field' => {
  const before = o.prevKeyAt + NOTE_SAME_PRESS_MS;
  if (o.inField) return o.gotAt > before ? 'arrived' : 'field';
  return o.leftAt > before ? 'field' : 'elsewhere';
};
/** What the field holds while typing: line breaks folded, cut at NOTE_MAX code points (spaces kept). */
export const typedNote = (v: string): string =>
  // eslint-disable-next-line no-control-regex
  Array.from(String(v || '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')).slice(0, NOTE_MAX).join('');
/** The counter beside the field: "12/140". */
export const noteCounter = (v: string): string => `${Array.from(String(v || '')).length}/${NOTE_MAX}`;

// ---------- the person picker ----------
export type PickState = 'ok' | 'sent' | 'seen' | 'kids' | 'off' | 'limit';
export type PickPerson = {
  id: string;
  name: string;
  avatar?: string | null;
  avatarImage?: string | null;
  color?: string | null;
  kids?: boolean;
  state: PickState | string;
  line?: string;
  waitMin?: number;
  note?: string;
};
/** Can this face be picked? ok, or "Already has it from you" (sending again updates the note). */
export const pickable = (p: Pick<PickPerson, 'state'>): boolean => p.state === 'ok' || p.state === 'sent';
/** OK on a face: picked ↔ not picked — a greyed one never changes. */
export const togglePick = (picked: ReadonlySet<string>, p: PickPerson): Set<string> => {
  const next = new Set(picked);
  if (!pickable(p)) return next;
  if (next.has(p.id)) next.delete(p.id);
  else next.add(p.id);
  return next;
};
/** What goes out: only people who can still be picked (the list may have been re-read). */
export const toSend = (picked: ReadonlySet<string>, people: PickPerson[]): string[] =>
  people.filter(p => picked.has(p.id) && pickable(p)).map(p => p.id);

// ---------- after a send ----------
export type SendAnswer = {
  sent?: {to: string; name: string; updated?: boolean}[];
  refused?: {to: string; name: string; reason: string; line: string; waitMin?: number}[];
  line?: string;
  key?: string;
};
/**
 * Something went: the sheet closes and ONE toast says it — the server's line, then each
 * refusal's line, joined with " · " (the website's recommend.js, to the letter). '' when
 * nothing went (then sendStatus is the sheet's own line and the sheet stays up).
 */
export const sendToast = (a: SendAnswer | null | undefined): string => {
  if (!a || !(a.sent || []).length) return '';
  const refused = (a.refused || []).map(r => r.line).filter(Boolean);
  return [a.line, ...refused].filter(Boolean).join(' · ');
};
/** Nothing went: what the sheet says under its buttons (and the faces are read again). */
export const sendStatus = (a: SendAnswer | null | undefined): string => {
  const refused = ((a && a.refused) || []).map(r => r.line).filter(Boolean);
  return refused.join(' · ') || (a && a.line) || 'Nothing was sent';
};
/** After a refusal the faces are read again: who can no longer be picked is let go. */
export const keepPickable = (picked: ReadonlySet<string>, people: PickPerson[]): Set<string> =>
  new Set(people.filter(p => picked.has(p.id) && pickable(p)).map(p => p.id));
/** The note a person already has from you, offered back to edit (the website's sheet). */
export const offeredNote = (people: PickPerson[] | null | undefined): string => {
  const mine = (people || []).find(p => p.state === 'sent' && p.note);
  return mine && mine.note ? mine.note : '';
};

// ---------- the sender's list ----------
export const STATUS_WORDS: Record<string, string> = {
  sent: 'Sent',
  seen: 'Seen',
  added: 'In their list',
  watching: 'Watching',
  watched: 'Watched',
};
export const statusWord = (s: string): string => STATUS_WORDS[s] || STATUS_WORDS.sent;
/** One line per title: "Dana · Seen   Avi · Watched". */
export const sentLine = (to: {name: string; status: string}[]): string => to.map(t => `${t.name} · ${statusWord(t.status)}`).join('   ');

// ---------- the filter of the Show all page ----------
export const filterOptions = (people: {id: string; name: string}[] | null | undefined): {id: string; label: string}[] => [
  {id: '', label: WORDS.everyone},
  ...(people || []).map(p => ({id: p.id, label: p.name})),
];

// ---------- a title: its key and what a send carries ----------
export type TitleLike = {
  id?: string | null;
  imdbId?: string | null;
  showId?: string | null;
  type?: string | null;
  source?: string | null;
  title?: string | null;
  showTitle?: string | null;
  cover?: string | null;
  poster?: string | null;
  year?: number | null;
  genres?: string[] | null;
  rating?: number | null;
  season?: number | null;
  episode?: number | null;
};
const IMDB_RE = /^tt\d{4,12}$/;
const LIB_RE = /^[\w.-]{1,80}$/;
/** An episode (stands for its show): a show id and no show type. */
export const isEpisodeLike = (t: TitleLike): boolean =>
  t.type !== 'show' && (!!t.showId || (t.type !== 'movie' && t.season != null && t.episode != null));
const libIdOf = (t: TitleLike): string | null => {
  const id = isEpisodeLike(t) ? t.showId : t.id;
  if (typeof id !== 'string' || !id || id.startsWith('torrent|') || IMDB_RE.test(id) || !LIB_RE.test(id)) return null;
  if (t.source === 'stream' && !isEpisodeLike(t)) return null;
  return id;
};
/**
 * The key the server keeps a title by: its IMDb id when it has one, else "lib:<library id>"
 * (an episode: its show's). null — nothing this title can be recommended as.
 * An episode on disk is keyed by its show's library id (its own imdbId may be the EPISODE's);
 * the server turns "lib:<id>" into the IMDb id it knows for that title.
 */
export const titleKey = (t: TitleLike | null | undefined, imdbFallback?: string | null): string | null => {
  if (!t) return null;
  if (isEpisodeLike(t)) {
    const show = libIdOf(t);
    if (show) return `lib:${show}`;
  }
  const imdb = [t.imdbId, imdbFallback, !isEpisodeLike(t) && IMDB_RE.test(String(t.id || '')) ? t.id : null].find(v => IMDB_RE.test(String(v || '')));
  if (imdb) return String(imdb);
  const lib = libIdOf(t);
  return lib ? `lib:${lib}` : null;
};
/** "movie" | "show": what the picker asks the server about. */
export const titleType = (t: TitleLike): 'movie' | 'show' => (t.type === 'show' || isEpisodeLike(t) ? 'show' : 'movie');
/** What the picker shows as the title: an episode's show. */
export const titleName = (t: TitleLike): string => String((isEpisodeLike(t) ? t.showTitle || t.title : t.title) || '');

export type SendTitle =
  | {id: string}
  | {imdbId: string; type: 'movie' | 'show'; title: string; poster?: string | null; year?: number | null; genres?: string[]; rating?: number | null};
/**
 * What POST /recommend gets as `title`: a library title by its id (the server looks it up — an
 * episode by its show's), a catalogue title described the way the My List toggle sends its stream
 * ref. null — nothing to send.
 */
export const sendTitle = (t: TitleLike | null | undefined, imdbFallback?: string | null): SendTitle | null => {
  if (!t) return null;
  const lib = libIdOf(t);
  if (lib) return {id: lib};
  const imdb = titleKey(t, imdbFallback);
  if (!imdb || !IMDB_RE.test(imdb)) return null;
  const name = titleName(t);
  if (!name) return null;
  return {
    imdbId: imdb,
    type: titleType(t),
    title: name,
    poster: t.cover || t.poster || null,
    year: t.year ?? null,
    genres: t.genres && t.genres.length ? t.genres : undefined,
    rating: t.rating ?? undefined,
  };
};

// ---------- Home's row: the trailing "Show all recommended" tile ----------
export const SHOW_ALL_ID = '__household_all';
/** The tile at the end of the row, only when the server says there are more than ROW_MAX. */
export const showAllTile = () => ({id: SHOW_ALL_ID, title: WORDS.showAll, cta: true as const});
export const isShowAll = (it: {id?: string | null} | null | undefined): boolean => !!it && it.id === SHOW_ALL_ID;
/** The row's items as drawn: the cards, then the tile when `more`. Cached per items array. */
const tailed = new WeakMap<object, unknown[]>();
export const withShowAll = <T extends object>(items: T[], more: boolean | undefined): T[] => {
  if (!more || !items.length) return items;
  let out = tailed.get(items) as T[] | undefined;
  if (!out) {
    out = [...items, showAllTile() as unknown as T];
    tailed.set(items, out);
  }
  return out;
};

// ---------- a new arrival (the live socket's `household_recs`) ----------
export type HhCard = {
  title?: string;
  hh?: {key: string; from: {id: string; name: string; note?: string; at: number}[]; unseen?: boolean; at?: number};
};
/** The newest recommendation time a list holds (server clock), 0 when none. */
export const newestAt = (items: HhCard[] | null | undefined): number => {
  let m = 0;
  for (const it of items || []) for (const f of (it.hh && it.hh.from) || []) if (Number(f.at) > m) m = Number(f.at);
  return m;
};
/**
 * What arrived since `since` (a server time — the newest this TV has already been shown, so the
 * same arrival is never toasted twice and the two clocks never meet): unseen titles with a
 * recommendation newer than it. -> the toast's words ("Dana recommended Dune" / "3 new
 * recommendations from your household"), or '' when nothing is new.
 */
export const arrivalToast = (items: HhCard[] | null | undefined, since: number): string => {
  const fresh = (items || []).filter(it => it.hh && it.hh.unseen && (it.hh.from || []).some(f => Number(f.at) > since));
  if (!fresh.length) return '';
  if (fresh.length === 1) {
    const it = fresh[0];
    const f = [...(it.hh!.from || [])].filter(x => Number(x.at) > since).sort((a, b) => b.at - a.at)[0];
    return `${f.name} recommended ${it.title || ''}`.trim();
  }
  return `${fresh.length} new recommendations from your household`;
};
