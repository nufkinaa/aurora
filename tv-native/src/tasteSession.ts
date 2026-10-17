// The swipe taste picker's bookkeeping, for the TV (screens/Taste.tsx) — the
// same rules as the website's public/js/screens/taste.js, without React so
// the logic tests can hold them:
//
//   • the queue holds the card on show, the one behind it, and two loading;
//     each answer's reply REPLACES what is past the first two, so the cards
//     after an answer were chosen knowing it (the server's tastedeck.js);
//   • nothing answered in this sitting comes back, nothing is queued twice;
//   • Undo walks the answers back one by one and sends each title the answer
//     it had before (the reply's `was`);
//   • a round is `goal` answers; "Keep going" adds `more`; the deck can also
//     run dry.
//
// The remote: LEFT = Not for me, RIGHT = Love, DOWN = Haven't seen, OK = Love
// (the card's own press).
export type TasteCard = {
  imdbId: string;
  id?: string;
  type: 'movie' | 'show';
  title: string;
  year?: number | null;
  poster?: string | null;
  genres?: string[];
  line?: string;
};
export type Verdict = 'love' | 'nope' | 'skip';
export type Entry = {card: TasteCard; verdict: Verdict; was: Verdict | null; settled: boolean};

export const KEEP = 4;

export const verdictForKey = (eventType: string): Verdict | null =>
  eventType === 'right' ? 'love' : eventType === 'left' ? 'nope' : eventType === 'down' ? 'skip' : null;

export class TasteSession {
  queue: TasteCard[] = [];
  history: Entry[] = [];
  answered = 0;
  tally: Record<Verdict, number> = {love: 0, nope: 0, skip: 0};
  exhausted = false;
  goal: number;
  more: number;
  private gone = new Set<string>();

  constructor(goal = 24, more = 12) {
    this.goal = goal;
    this.more = more;
  }

  get current(): TasteCard | null {
    return this.queue[0] || null;
  }
  get behind(): TasteCard | null {
    return this.queue[1] || null;
  }
  get roundOver(): boolean {
    return this.answered >= this.goal || (this.exhausted && !this.queue.length);
  }
  get progress(): number {
    return this.goal ? Math.min(1, this.answered / this.goal) : 0;
  }
  /** What the server should not hand out again: the cards held here. */
  queuedIds(n = 2): string[] {
    return this.queue.slice(0, n).map(c => c.imdbId);
  }

  /** Cards from the server. `replaceTail`: an answer's reply — keep the two
   *  on show, the rest is chosen anew. An empty reply means the deck ran dry. */
  take(cards: TasteCard[] | null | undefined, replaceTail = false) {
    if (replaceTail) this.queue = this.queue.slice(0, 2);
    const list = cards || [];
    if (!list.length) this.exhausted = true;
    for (const c of list) {
      if (!c || !c.imdbId || this.gone.has(c.imdbId) || this.queue.some(q => q.imdbId === c.imdbId)) continue;
      this.queue.push(c);
    }
  }

  /** Answer the card on show. Null when there is nothing to answer. */
  answer(verdict: Verdict): Entry | null {
    if (this.roundOver) return null;
    const card = this.queue.shift();
    if (!card) return null;
    this.gone.add(card.imdbId);
    this.answered++;
    this.tally[verdict]++;
    const entry: Entry = {card, verdict, was: null, settled: false};
    this.history.push(entry);
    return entry;
  }

  /** The server stored it; `was` is the answer the title had before. */
  settle(entry: Entry, was: Verdict | null) {
    entry.was = was;
    entry.settled = true;
  }

  /** The server did not store it: as if it had not been answered. False when
   *  it was already taken back with Undo. */
  fail(entry: Entry): boolean {
    const i = this.history.indexOf(entry);
    if (i < 0) return false;
    this.history.splice(i, 1);
    this.unanswer(entry);
    return true;
  }

  /** Take the last answer back: its card is on show again. */
  undo(): Entry | null {
    const last = this.history.pop();
    if (!last) return null;
    this.unanswer(last);
    return last;
  }

  keepGoing() {
    this.goal += this.more;
  }

  private unanswer(entry: Entry) {
    this.answered = Math.max(0, this.answered - 1);
    this.tally[entry.verdict] = Math.max(0, this.tally[entry.verdict] - 1);
    this.gone.delete(entry.card.imdbId);
    this.queue = [entry.card, ...this.queue.filter(c => c.imdbId !== entry.card.imdbId)];
  }
}
