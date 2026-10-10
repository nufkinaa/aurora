// The player's rules shared with the website (playerRules.ts): what is next,
// the Up next card, "Still watching?", Skip intro / recap, a direct-play stall.
import {
  nextAutoRun,
  NextEp,
  nextFile,
  planUpNext,
  rangeOf,
  readNext,
  skippableAt,
  stallStep,
  STILL_WATCHING_AFTER,
  upNextState,
  upNextWindow,
} from '../../src/playerRules';

const lib: NextEp = {kind: 'library', id: 'e5', season: 1, episode: 5, name: 'Five', label: 'S1 E5 · Five'};
const str: NextEp = {kind: 'stream', imdbId: 'tt1', season: 1, episode: 5, name: 'Five', label: 'S1 E5 · Five'};

describe('the server’s answer', () => {
  test('an episode on disk, one that is not, and nothing', () => {
    expect(readNext({next: {kind: 'library', id: 'e5', showId: 's', season: 1, episode: 5, title: 'Five'}, why: 'adjacent'})).toEqual(lib);
    expect(readNext({next: {kind: 'stream', imdbId: 'tt1', season: 1, episode: 5, title: 'Five', released: null}})).toEqual(str);
    expect(readNext({next: null, why: 'series-end'})).toBeNull();
  });

  test('"Episode 5" is not a name worth printing', () => {
    expect(readNext({next: {kind: 'library', id: 'e5', season: 1, episode: 5, title: 'Episode 5'}})).toMatchObject({name: '', label: 'S1 E5'});
  });

  test('what is NOT an answer (an older server’s 404 body, junk) says so, so the caller falls back', () => {
    expect(readNext({error: 'Not found'})).toBeUndefined();
    expect(readNext(null)).toBeUndefined();
    expect(readNext('<html>')).toBeUndefined();
    expect(readNext({next: {kind: 'library', season: 1, episode: 5}})).toBeUndefined(); // no id
    expect(readNext({next: {kind: 'who-knows', id: 'x', season: 1, episode: 5}})).toBeUndefined();
  });

  test('the fallback for a server without the route is the old rule: the next file in the list', () => {
    const seasons = [{episodes: [{id: 'e4', season: 1, episode: 4, title: 'Four'}, {id: 'e8', season: 1, episode: 8, title: 'Eight'}]}];
    expect(nextFile(seasons, 'e4')).toEqual({kind: 'library', id: 'e8', season: 1, episode: 8, name: 'Eight', label: 'S1 E8 · Eight'});
    expect(nextFile(seasons, 'e8')).toBeNull();
    expect(nextFile(null, 'e4')).toBeNull();
  });
});

describe('the Up next card', () => {
  const base = {next: lib, autoplayPref: true, inParty: false, guest: false, autoRun: 0};

  test('an episode on disk, autoplay on: Play now and a 15 s countdown', () => {
    expect(planUpNext(base)).toEqual({card: 'upnext', countdown: 15, primary: 'play'});
  });

  test('autoplay off (the person’s setting): offered, nothing starts by itself', () => {
    expect(planUpNext({...base, autoplayPref: false})).toEqual({card: 'upnext', countdown: null, primary: 'play'});
  });

  test('not on disk: "Choose episode", never a countdown — a source is never picked for the viewer', () => {
    expect(planUpNext({...base, next: str})).toEqual({card: 'upnext', countdown: null, primary: 'choose'});
    expect(planUpNext({...base, next: str, autoRun: 9})).toEqual({card: 'upnext', countdown: null, primary: 'choose'});
  });

  test('a party guest gets the card with no countdown (the host carries the room); the host counts down', () => {
    expect(planUpNext({...base, inParty: true, guest: true}).countdown).toBeNull();
    expect(planUpNext({...base, inParty: true, guest: false}).countdown).toBe(15);
  });

  test('Still watching? after three episodes that started by themselves — and never in a party', () => {
    expect(planUpNext({...base, autoRun: STILL_WATCHING_AFTER - 1}).card).toBe('upnext');
    expect(planUpNext({...base, autoRun: STILL_WATCHING_AFTER})).toEqual({card: 'still', countdown: null, primary: 'keep'});
    expect(planUpNext({...base, autoRun: 7, inParty: true}).card).toBe('upnext');
    // with autoplay off nothing was going to start anyway: the ordinary card
    expect(planUpNext({...base, autoRun: 7, autoplayPref: false}).card).toBe('upnext');
  });

  test('the run counts only episodes that started by the countdown, outside a party', () => {
    expect(nextAutoRun({byCountdown: true, inParty: false, autoRun: 2})).toBe(3);
    expect(nextAutoRun({byCountdown: false, inParty: false, autoRun: 2})).toBe(0); // Play now, Next, Keep watching
    expect(nextAutoRun({byCountdown: true, inParty: true, autoRun: 2})).toBe(0);
  });

  test('four hands-off episodes: three start by themselves, the fourth asks', () => {
    let run = 0; // the first was opened by hand
    const cards: string[] = [];
    for (let i = 0; i < 4; i++) {
      const plan = planUpNext({...base, autoRun: run});
      cards.push(plan.card);
      if (plan.countdown == null) break;
      run = nextAutoRun({byCountdown: true, inParty: false, autoRun: run});
    }
    expect(cards).toEqual(['upnext', 'upnext', 'upnext', 'still']);
  });
});

describe('when Up next is on', () => {
  test('the window scales with the runtime: 30 s at least, 90 s at most', () => {
    expect(upNextWindow(300)).toBe(30);
    expect(upNextWindow(1320)).toBe(66);
    expect(upNextWindow(3600)).toBe(90);
  });

  test('from the detected credits when there are any; else the window', () => {
    expect(upNextState(2512, 2700, 2520)).toBe('hold'); // 8 s before the credits
    expect(upNextState(2521, 2700, 2520)).toBe('show');
    expect(upNextState(2600, 2700, null)).toBe('hold'); // 100 s left, window 90
    expect(upNextState(2611, 2700, null)).toBe('show');
  });

  test('credits "starting" in the last five seconds are not credits', () => {
    expect(upNextState(2600, 2700, 2698)).toBe('hold');
  });

  test('going back out of the credits by more than 15 s takes the card away again', () => {
    expect(upNextState(2400, 2700, 2520)).toBe('retract');
    expect(upNextState(2510, 2700, 2520)).toBe('hold'); // just outside: neither shown anew nor retracted
  });

  test('an unknown length never shows it', () => {
    expect(upNextState(100, 0, null)).toBe('hold');
  });
});

describe('Skip intro / Skip recap', () => {
  const recap = {start: 0, end: 45};
  const intro = {start: 50, end: 110};

  test('the recap while inside it, else the intro', () => {
    expect(skippableAt(10, {recap, intro})).toEqual({kind: 'recap', range: recap});
    expect(skippableAt(60, {recap, intro})).toEqual({kind: 'intro', range: intro});
    expect(skippableAt(47, {recap, intro})).toBeNull();
    expect(skippableAt(200, {recap, intro})).toBeNull();
  });

  test('never in a range’s final second', () => {
    expect(skippableAt(44.5, {recap, intro: null})).toBeNull();
    expect(skippableAt(109.2, {recap: null, intro})).toBeNull();
  });

  test('a recap that overlaps the intro wins while inside it', () => {
    expect(skippableAt(55, {recap: {start: 40, end: 70}, intro})!.kind).toBe('recap');
  });

  test('only a real range is used', () => {
    expect(rangeOf({start: 5, end: 60})).toEqual({start: 5, end: 60});
    expect(rangeOf({start: 60, end: 5})).toBeNull();
    expect(rangeOf({start: 'x', end: 5})).toBeNull();
    expect(rangeOf(null)).toBeNull();
  });
});

describe('a stall on direct play', () => {
  const none = {nudged: false, rebuilt: false, carded: false};
  test('nudge at 6 s, the source again at 20 s, the card at 45 s — one of each', () => {
    expect(stallStep(3000, none)).toBeNull();
    expect(stallStep(6000, none)).toBe('nudge');
    expect(stallStep(9000, {...none, nudged: true})).toBeNull();
    expect(stallStep(20000, {...none, nudged: true})).toBe('rebuild');
    expect(stallStep(30000, {...none, nudged: true, rebuilt: true})).toBeNull();
    expect(stallStep(45000, {...none, nudged: true, rebuilt: true})).toBe('card');
    expect(stallStep(90000, {nudged: true, rebuilt: true, carded: true})).toBeNull();
  });
});
