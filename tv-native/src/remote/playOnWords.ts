// "Play on TV" / "Continue on this phone": every sentence the phone app shows
// as the sender, in ONE place — the website's public/js/playOnWords.js, word
// for word (test/play-on-tv-words.test.js runs both and compares). No imports.
//
// `tv` is the device's name ("Living room TV"), `what` the title ("Arrival",
// "Silo · S1 E3"), `form` this device ("phone").
export const PLAY_ON = {
  button: 'Play on TV',
  buttonFor: (tv = '') => `Play on ${tv}`,
  pick: 'Play on…',
  // one TV on: a single press, and this to confirm it
  confirm: (tv = '', what = '') => (what ? `Play “${what}” on ${tv}?` : `Play on ${tv}?`),
  playing: (tv = '') => `Playing on ${tv}`,
  // the TV is on "Who's watching?" and the profile has a door
  needsPin: (tv = '', what = '') => `Enter your PIN on ${tv} to play ${what || 'it'}`,
  needsPassword: (tv = '', what = '') => `Enter your password on ${tv} to play ${what || 'it'}`,
  noAnswer: (tv = '') => `${tv} didn't answer`,
  failed: (tv = '') => `Couldn't play on ${tv}`,
  superseded: (tv = '') => `Something else was just started on ${tv}`,
  // a TV nobody is signed in to yet
  onWall: 'On “Who\'s watching?”',
  // the reverse: what the TV plays, here
  continueHere: (form = 'phone') => `Continue on this ${form}`,
  continued: (tv = '') => `Paused on ${tv} — carrying on here`,
  nothingThere: (tv = '') => `Nothing is playing on ${tv}`,
  streamHere: "That's a stream — open it from its title page here",
};

type PlayRes = {ok: boolean; error?: string | null; message?: string | null; status?: string | null};

/** The sentence for a play_item's answer. */
export const playOnResult = (res: PlayRes | null | undefined, tv = '', what = ''): string => {
  if (res && res.ok) {
    if (res.status === 'needs-pin') return PLAY_ON.needsPin(tv, what);
    if (res.status === 'needs-password') return PLAY_ON.needsPassword(tv, what);
    return PLAY_ON.playing(tv);
  }
  if (res && res.error === 'timeout') return PLAY_ON.noAnswer(tv);
  if (res && res.error === 'superseded') return PLAY_ON.superseded(tv);
  return (res && res.message) || PLAY_ON.failed(tv);
};

type Titled = {title?: string | null; showTitle?: string | null; season?: number | null; episode?: number | null};
/** "Arrival", "Silo · S1 E3" — the title a sentence names. */
export const playOnTitle = (it: Titled | null | undefined): string => {
  if (!it) return '';
  const show = it.showTitle || null;
  if (show && it.season != null && it.episode != null) return `${show} · S${it.season} E${it.episode}`;
  return it.title || show || '';
};
