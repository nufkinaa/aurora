// Subtitle cues: reading a track, finding what is on screen at a moment, and
// where the cue layer sits. PURE — no imports; the logic tests run it as it is.
//
// Everything the server serves is meant to be WebVTT (src/media/subtitles.js
// converts SRT and extracts embedded tracks to it), but not everything that
// arrives IS clean WebVTT: /stream/torrent/sub passes a torrent's own .srt
// through with only "WEBVTT" put in front, providers ship BOMs, "WEBVTT - title"
// headers, cue ids, NOTE / STYLE blocks, X-TIMESTAMP-MAP lines, timestamps
// without hours (or without milliseconds), CRLF or bare-CR line ends, SRTs
// whose blank lines between cues went missing, and the odd ASS "Dialogue:"
// line. A cue the parser drops is a subtitle the viewer never sees — "the
// subtitles don't work" — so it reads all of those.

export type Cue = {start: number; end: number; text: string};

// hh:mm:ss.mmm, h:mm:ss,mmm (SRT), mm:ss.mmm (WebVTT without hours), and the
// same without a fraction ("00:01:02" — broken SRTs). Hours are any number
// of digits; minutes and seconds are two (one is tolerated for minutes).
const TS = /(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/;
export const parseTs = (s: string): number | null => {
  const m = TS.exec(s);
  if (!m) return null;
  const mins = parseInt(m[2], 10);
  const secs = parseInt(m[3], 10);
  if (secs > 59 || (m[1] && mins > 59)) return null;
  return (
    (m[1] ? parseInt(m[1], 10) : 0) * 3600 +
    mins * 60 +
    secs +
    (m[4] ? parseInt(m[4].padEnd(3, '0'), 10) / 1000 : 0)
  );
};

// A timing line: "<ts> --> <ts>[ settings]". Only the first timestamp on
// each side counts (cue settings such as "position:10%" follow the end).
const timing = (line: string): {start: number; end: number} | null => {
  const at = line.indexOf('-->');
  if (at < 0) return null;
  const start = parseTs(line.slice(0, at));
  const end = parseTs(line.slice(at + 3));
  if (start == null || end == null) return null;
  return {start, end};
};

// The few entities a WebVTT (or an HTML-minded SRT) writes instead of the
// character. &lrm; / &rlm; are direction marks Hebrew tracks carry.
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '\u200E',
  rlm: '\u200F',
};
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name: string) => {
    if (name[0] === '#') {
      const n = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    const v = ENTITIES[name.toLowerCase()];
    return v == null ? all : v;
  });

// A cue's text as RN's <Text> can draw it: no markup. <i>/<b>/<c.class>/
// <v Speaker>/<00:01.000> karaoke stamps, ASS override blocks {\an8}, and
// ASS's \N / \n / \h. A visible "<i>" is worse than losing the italics.
export const cleanCueText = (raw: string): string =>
  decodeEntities(
    raw
      .replace(/<[^>]*>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' '),
  )
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n');

// ASS / SSA: "Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
// with h:mm:ss.cc times. The text is everything after the ninth comma.
const assDialogue = (line: string): Cue | null => {
  const m = /^Dialogue:\s*[^,]*,([^,]+),([^,]+),(?:[^,]*,){6}(.*)$/i.exec(line);
  if (!m) return null;
  const start = parseTs(m[1]);
  const end = parseTs(m[2]);
  if (start == null || end == null) return null;
  const text = cleanCueText(m[3]);
  return text ? {start, end, text} : null;
};

export const parseVtt = (raw: string): Cue[] => {
  const out: Cue[] = [];
  if (typeof raw !== 'string' || !raw) return out;
  const lines = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let cur: {start: number; end: number} | null = null;
  let body: string[] = [];
  const close = () => {
    if (cur) {
      const text = cleanCueText(body.join('\n'));
      if (text && cur.end > cur.start) out.push({start: cur.start, end: cur.end, text});
    }
    cur = null;
    body = [];
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/^\uFEFF/, '');
    const t = timing(line);
    if (t) {
      // A timing line while a cue is still open: the blank line between two
      // SRT cues went missing. The counter just above it belongs to the next
      // cue, not to this one's text.
      if (cur && body.length && /^\s*\d+\s*$/.test(body[body.length - 1])) body.pop();
      close();
      cur = t;
      continue;
    }
    if (!line.trim()) {
      // a blank line ends a cue; ids, NOTE, STYLE, REGION, the header and
      // X-TIMESTAMP-MAP sit between cues and are never read as text
      close();
      continue;
    }
    if (cur) {
      body.push(line);
      continue;
    }
    const d = assDialogue(line);
    if (d) out.push(d);
  }
  close();
  // Some tracks ship out of order; the lookup below assumes sorted cues.
  out.sort((x, y) => x.start - y.start || x.end - y.end);
  return out;
};

// How far back the lookup looks for a cue that is still on while later ones
// started (two speakers at once, a sign held over dialogue).
const OVERLAP_LOOKBACK = 64;

/** The text on screen at content time `t` (already minus the viewer's delay):
 *  every cue with start <= t < end, in order, one per line. '' for none.
 *  Stateless — a binary search, so a seek or a delay nudge in either
 *  direction can never leave a stale cursor past the right cue. */
export const cueTextAt = (cues: Cue[] | null | undefined, t: number): string => {
  if (!cues || !cues.length || !Number.isFinite(t)) return '';
  // the last cue that has started
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (last < 0) return '';
  const on: string[] = [];
  for (let i = last; i >= 0 && i > last - OVERLAP_LOOKBACK; i--) {
    const c = cues[i];
    if (t < c.end && on[0] !== c.text) on.unshift(c.text);
  }
  return on.join('\n');
};

// ----------------------------------------------------------------- layout
// Where the cue layer's bottom edge sits, in dp from the bottom of the screen.
//   chrome hidden: CUE_BOTTOM_PLAIN, as it always was.
//   chrome up:     clear of the transport — the top of the bottom bar (the
//                  scrubber row is its first line) measured by onLayout, plus
//                  a gap. Before the first measurement, the constant that
//                  used to be the only answer.
export const CUE_BOTTOM_PLAIN = 48;
export const CUE_BOTTOM_LIFTED_FALLBACK = 150;
export const CUE_GAP_ABOVE_CHROME = 14;

/** `area`: the bottom bar's top edge, as distance from the screen's bottom
 *  (screen height − its y), or null when it has not been measured. */
export const cueBottom = (controls: boolean, areaFromBottom: number | null, screenH?: number): number => {
  if (!controls) return CUE_BOTTOM_PLAIN;
  if (areaFromBottom == null || !Number.isFinite(areaFromBottom) || areaFromBottom <= 0) return CUE_BOTTOM_LIFTED_FALLBACK;
  const lifted = Math.round(areaFromBottom + CUE_GAP_ABOVE_CHROME);
  // never below the plain position, and never so high that a two-line cue
  // would leave the top half of the picture (a mis-measure must not throw
  // the subtitles off the screen)
  const cap = screenH && screenH > 0 ? Math.round(screenH * 0.55) : Infinity;
  return Math.max(CUE_BOTTOM_PLAIN, Math.min(lifted, cap));
};
