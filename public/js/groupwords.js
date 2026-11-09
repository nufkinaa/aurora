// "What do we watch tonight?" on the website — the words and the small rules
// the screen shares with the TV and the phone app. This is the apps'
// tv-native/src/groupPick.ts to the letter (its logic test holds the two
// together: words, steps and lines). screens/group.js draws.

// ---------- the words (the TV's groupPick.ts, to the letter) ----------
export const WORDS = {
  feature: 'What do we watch tonight?',
  entry: 'Pick together',
  entryLine: 'Everyone swipes on their own phone. Aurora finds what you all want.',
  startHere: 'Start',
  joinCode: 'Join with a code',
  codeLabel: 'The code on the screen',
  codeHelp: 'Four letters, on the TV or on the screen of whoever started it.',
  codeWrong: 'The code is four letters and numbers.',
  join: 'Join',
  joinTitle: 'Join in',
  joinLine: 'Scan the code with your phone, or open Aurora and type it in.',
  waiting: 'Waiting for people to join…',
  mood: 'Mood',
  length: 'Length',
  kind: 'Films or series',
  time: 'Time to swipe',
  startSwiping: 'Start swiping',
  needSomeone: 'Someone has to join to start',
  swipeHereToo: 'Swipe on this screen too',
  justShow: 'Only show the code and the result here',
  yes: 'Yes',
  maybe: 'Maybe',
  no: 'No',
  undo: 'Undo',
  addTitle: 'Add a title',
  searchPlaceholder: 'Search for a film or a series',
  added: 'Added',
  inDeck: 'In the deck',
  addLine: 'Adding a title counts as your yes.',
  addedSoFar: 'Added so far',
  doneWaiting: "You're done — waiting for the others",
  oneMore: 'One more minute',
  showNow: 'Show the result now',
  resultTitle: "Tonight's pick",
  somethingElse: 'Something else',
  firstPick: 'Back to the first pick',
  play: 'Play',
  open: 'Open',
  noMatch: 'No match this time',
  noMatchLine: 'Nobody said yes to the same thing. Swipe another round?',
  again: 'Swipe another round',
  onlyHost: 'Waiting for the person who started it',
  enjoy: 'Enjoy the film',
  ended: 'This session has ended',
  leave: 'Leave',
  endAll: 'End for everyone',
  howItWorks: 'How it works',
  skip: 'Skip',
  next: 'Next',
  letsGo: "Let's go",
  libBadge: 'On Aurora',
  screenBadge: 'Screen',
  hostBadge: 'Started it',
  awayBadge: 'Away',
  doneBadge: 'Done',
};

// The first-time explanation: four steps, each a picture and a sentence.
// `art` names the little drawing each app makes for it.
export const TUTORIAL = [
  {art: 'tv', title: 'Start it on the TV', body: 'Pick a mood and how long. A code and a QR code show on the screen.'},
  {art: 'phones', title: 'Join on your phones', body: 'Scan the code or type it in. Everyone gets the same cards.'},
  {art: 'swipe', title: 'Swipe yes, maybe or no', body: 'Each on your own phone, at the same time. Nobody sees what you said. Want something? Add it with search.'},
  {art: 'result', title: 'The pick shows on the TV', body: 'Aurora finds what you all said yes to. One press plays it — or ask for something else.'},
];

// ---------- the rules the screens share ----------
const pad2 = (n) => String(n).padStart(2, '0');

/** "2:31 left" · "0:05 left" · "Time's up" — from the server's deadline and clock. */
export const timeLeft = (s, sinceMs = 0) => {
  if (!s.deadline) return '';
  const left = Math.max(0, Math.round((s.deadline - s.now - sinceMs) / 1000));
  if (left <= 0) return "Time's up";
  return `${Math.floor(left / 60)}:${pad2(left % 60)} left`;
};
/** Seconds left (0 when up), for a countdown bar. */
export const secondsLeft = (s, sinceMs = 0) =>
  s.deadline ? Math.max(0, Math.round((s.deadline - s.now - sinceMs) / 1000)) : 0;

/** "2 of 3 done" — the voters who have answered every card. */
export const progressLine = (s) => {
  const byPerson = new Map();
  for (const m of s.members) if (m.role === 'voter') byPerson.set(m.profileId, (byPerson.get(m.profileId) || false) || m.done);
  const of = byPerson.size;
  const done = [...byPerson.values()].filter(Boolean).length;
  return of ? `${done} of ${of} done` : '';
};
/** "3 people are in" · "Dana is in" — the lobby's count, one name per person. */
export const joinedLine = (s) => {
  const names = [];
  for (const m of s.members) if (m.role === 'voter' && !names.includes(m.name)) names.push(m.name);
  if (!names.length) return WORDS.waiting;
  if (names.length === 1) return `${names[0]} is in`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are in`;
  return `${names.length} people are in`;
};
/** One chip per person in the room (a person on two devices is one chip). */
export const peopleOf = (s) => {
  const out = [];
  for (const m of s.members) {
    const had = out.findIndex(o => o.profileId === m.profileId);
    if (had === -1) out.push(m);
    else if (out[had].role === 'screen' && m.role === 'voter') out[had] = m; // the person, not the TV
  }
  return out;
};

/** "2021 · 1 h 48 · Comedy" — a card's small line. */
export const cardMeta = (c) => {
  const parts = [];
  if (c.year) parts.push(String(c.year));
  if (c.runtime) {
    const h = Math.floor(c.runtime / 60);
    const m = c.runtime % 60;
    parts.push(c.type === 'show' ? `${c.runtime} min episodes` : h ? `${h} h${m ? ` ${pad2(m)}` : ''}` : `${m} min`);
  } else if (c.type === 'show') parts.push('Series');
  if (c.genres && c.genres.length) parts.push(c.genres.slice(0, 2).join(' · '));
  return parts.join(' · ');
};
/** "Dana has seen it" · "Dana and Avi have seen it" */
export const seenLine = (names) => {
  const n = (names || []).filter(Boolean);
  if (!n.length) return '';
  if (n.length === 1) return `${n[0]} has seen it`;
  if (n.length === 2) return `${n[0]} and ${n[1]} have seen it`;
  return `${n.length} of you have seen it`;
};
export const addedLine = (name) => (name ? `Added by ${name}` : '');
export const limitLabel = (sec) => `${Math.round(sec / 60)} min`;

/** The cards this member has not answered yet, in deck order. */
export const unanswered = (s) => s.deck.filter(c => !s.mine[c.key]);

// Which step a member is on — what their screen shows.
//   tutorial  first time here (the app decides from GroupOptions.tutorialSeen)
//   lobby     waiting to start (the host sees the choices and Start)
//   swipe     cards left to answer
//   waiting   all answered, the others are still at it (or: a screen)
//   result    the pick (or "no match")
//   chosen    someone pressed Play
//   ended     over (the reason)
export const stepOf = (s) => {
  if (s.phase === 'ended') return 'ended';
  if (s.phase === 'chosen') return 'chosen';
  if (s.phase === 'result') return 'result';
  if (s.phase === 'lobby') return 'lobby';
  if (s.you && s.you.role === 'voter' && unanswered(s).length) return 'swipe';
  return 'waiting';
};
/** The pick on screen now (null: nothing got a yes). */
export const currentPick = (s) => {
  const r = s.result;
  if (!r || !r.picks.length) return null;
  return r.picks[Math.min(Math.max(0, r.index), r.picks.length - 1)] || null;
};
export const hasNextPick = (s) => !!s.result && s.result.index + 1 < s.result.picks.length;

/** What the QR code holds: the website's join page for this code. */
export const joinUrl = (base, code) => `${String(base || '').replace(/\/+$/, '')}/#/group/${encodeURIComponent(code)}`;
/** The address printed under the QR code ("nufurora.com"), for typing. */
export const hostOf = (base) => String(base || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
/** A typed code, tidied: four letters and numbers, upper case (no I, O, 0, 1). */
export const tidyCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
export const codeOk = (code) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{4}$/.test(code);

/** A newer session replaces the one on screen; an older answer (a slow poll) never does. */
export const newer = (had, next) =>
  !!next && (!had || had.code !== next.code || next.rev >= had.rev);
