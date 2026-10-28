// A film that stops mid-play comes back by itself at the same spot, a bounded
// number of times, and then the card says so — the website's rule since
// 1.13.7 (public/js/screens/player.js mseAgain + its stall watcher), for
// ExoPlayer (src/playback/recovery.ts, wired in Player.tsx).
import {
  AGAIN_DELAYS_MS,
  AGAIN_MAX,
  AGAIN_WINDOW_MS,
  againStep,
  CARD_RETRY_MS,
  REFUSED_UNDER_S,
  spotOf,
  STALL_BUDGET_MS,
  STALL_MAX_REBUILDS,
  STOPPED_FILM,
  STOPPED_STREAM,
  stopWords,
  Watch,
  watchNew,
  watchReset,
  watchTick,
  WatchIn,
} from '../../src/playback/recovery';

const T0 = 1_000_000;

describe('an error on a film that has been playing', () => {
  it('the same source again, 0.3 s and then 2 s later; the third is the card', () => {
    const tries: number[] = [];
    const o = {played: 600, canEncode: true};
    expect(againStep(tries, T0, o)).toEqual({kind: 'again', delayMs: 300, n: 1});
    expect(againStep(tries, T0 + 1500, o)).toEqual({kind: 'again', delayMs: 2000, n: 2});
    expect(againStep(tries, T0 + 5000, o)).toEqual({kind: 'card'});
    // the card is not a counter: the tries it saw stay
    expect(tries).toHaveLength(AGAIN_MAX);
  });
  it('the numbers are the website’s', () => {
    expect(AGAIN_MAX).toBe(2);
    expect(AGAIN_DELAYS_MS).toEqual([300, 2000]);
    expect(AGAIN_WINDOW_MS).toBe(3 * 60000);
    expect(CARD_RETRY_MS).toBe(30000);
    expect(REFUSED_UNDER_S).toBe(30);
    expect(STALL_MAX_REBUILDS).toBe(2);
    expect(STALL_BUDGET_MS).toBe(5 * 60000);
  });
  it('tries older than three minutes no longer count', () => {
    const tries: number[] = [];
    const o = {played: 600, canEncode: false};
    againStep(tries, T0, o);
    againStep(tries, T0 + 2000, o);
    expect(againStep(tries, T0 + AGAIN_WINDOW_MS + 2001, o)).toEqual({kind: 'again', delayMs: 300, n: 1});
  });
  it('a path hardly played that keeps failing: the full encode, not the card', () => {
    const tries: number[] = [];
    againStep(tries, T0, {played: 12, canEncode: true});
    againStep(tries, T0 + 500, {played: 12, canEncode: true});
    expect(againStep(tries, T0 + 3000, {played: 12, canEncode: true})).toEqual({kind: 'encode'});
  });
  it('…but a path played half a minute or more is not refused here, and with no rung left it is the card', () => {
    const a: number[] = [T0, T0 + 1];
    expect(againStep(a, T0 + 3000, {played: 30, canEncode: true})).toEqual({kind: 'card'});
    const b: number[] = [T0, T0 + 1];
    expect(againStep(b, T0 + 3000, {played: 5, canEncode: false})).toEqual({kind: 'card'});
  });
});

describe('the frozen-picture watcher', () => {
  const run = (w: Watch, from: number, to: number, base: Partial<WatchIn> = {}) => {
    const out: Record<number, string> = {};
    for (let s = from; s <= to; s++) {
      const r = watchTick(w, {now: T0 + s * 1000, ct: 100, countable: true, loaded: true, party: false, ...base});
      if (r) out[s] = r;
    }
    return out;
  };
  it('a nudge at 6 s, the same source at 20 s, the card at 45 s', () => {
    const w = watchNew();
    w.lastCt = 100;
    expect(run(w, 0, 50)).toEqual({6: 'nudge', 20: 'rebuild', 45: 'card'});
    expect(w.hold).toBe(true);
  });
  it('the clock moving again ends the stall (and says so: a card up for it can go)', () => {
    const w = watchNew();
    w.lastCt = 100;
    run(w, 0, 10);
    expect(w.since).toBeGreaterThan(0);
    expect(watchTick(w, {now: T0 + 11000, ct: 101, countable: true, loaded: true, party: false})).toBe('moved');
    expect(w.since).toBe(0);
    expect(w.hold).toBe(false);
  });
  it('a viewer’s jump starts the count again; the jumps of our own reload do not', () => {
    const w = watchNew();
    w.lastCt = 100;
    run(w, 0, 10);
    watchTick(w, {now: T0 + 11000, ct: 600, countable: true, loaded: true, party: false});
    expect(w.since).toBe(0);
    const h = watchNew();
    h.lastCt = 100;
    run(h, 0, 21); // the 20 s reload sets the hold
    const since = h.since;
    // the reloaded source reports 0, then the spot again
    watchTick(h, {now: T0 + 22000, ct: 0, countable: true, loaded: false, party: false});
    watchTick(h, {now: T0 + 23000, ct: 100, countable: true, loaded: true, party: false});
    expect(h.since).toBe(since);
    expect(run(h, 24, 46, {ct: 100})).toEqual({45: 'card'});
  });
  it('the viewer’s pause stops the count — an error’s does not exist here (only `countable` says paused)', () => {
    const w = watchNew();
    w.lastCt = 100;
    run(w, 0, 10);
    watchTick(w, {now: T0 + 11000, ct: 100, countable: false, loaded: true, party: false});
    expect(w.since).toBe(0);
    expect(run(w, 12, 17)).toEqual({}); // counted again from 12
    expect(run(w, 18, 18)).toEqual({18: 'nudge'});
  });
  it('no nudge into a source that has not loaded; the reload still comes', () => {
    const w = watchNew();
    w.lastCt = 100;
    expect(run(w, 0, 21, {loaded: false})).toEqual({20: 'rebuild'});
  });
  it('two reloads per five minutes; then the next stall goes to the card at 20 s', () => {
    const w = watchNew();
    w.lastCt = 100;
    run(w, 0, 21);
    watchTick(w, {now: T0 + 22000, ct: 101, countable: true, loaded: true, party: false}); // moved
    w.lastCt = 101;
    const second = run(w, 23, 44, {ct: 101});
    expect(second[43]).toBe('rebuild');
    watchTick(w, {now: T0 + 45000, ct: 102, countable: true, loaded: true, party: false});
    expect(run(w, 46, 66, {ct: 102})).toEqual({52: 'nudge', 66: 'card'});
    // five minutes on, the budget is back
    const later = watchNew();
    later.rebuilds.push(T0, T0 + 1000);
    later.lastCt = 5;
    const out: string[] = [];
    for (let s = 0; s <= 20; s++) {
      const r = watchTick(later, {now: T0 + STALL_BUDGET_MS + 2000 + s * 1000, ct: 5, countable: true, loaded: true, party: false});
      if (r) out.push(r);
    }
    expect(out).toEqual(['nudge', 'rebuild']);
  });
  it('Try again counts from scratch', () => {
    const w = watchNew();
    w.rebuilds.push(T0, T0 + 1);
    w.since = T0;
    w.carded = true;
    watchReset(w);
    expect(w).toMatchObject({since: 0, carded: false, rebuilds: []});
  });
  it('in a watch party: a nudge, but no reload and no card (the party waits for this TV)', () => {
    const w = watchNew();
    w.lastCt = 100;
    expect(run(w, 0, 60, {party: true})).toEqual({6: 'nudge'});
  });
});

describe('where a reload goes back to', () => {
  it('a pending resume, else the spot our reload heads for, else where the film stood — never 0:00 for a film further on', () => {
    expect(spotOf({resumeAt: 1200, held: 900, cur: 0})).toBe(1200);
    expect(spotOf({resumeAt: 0, held: 900, cur: 0})).toBe(900);
    expect(spotOf({resumeAt: 0, held: 0, cur: 734.5})).toBe(734.5);
    expect(spotOf({resumeAt: 0, held: 0, cur: -1})).toBe(0);
  });
});

describe('the words and the wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const web: string = fs.readFileSync(path.join(__dirname, '../../../public/js/screens/player.js'), 'utf8');
  const tv: string = fs.readFileSync(path.join(__dirname, '../../src/playback/Player.tsx'), 'utf8').replace(/\r\n/g, '\n');
  it('the card says what the website’s says, word for word', () => {
    expect(web).toContain(JSON.stringify(STOPPED_FILM));
    expect(web).toContain(JSON.stringify(STOPPED_STREAM));
    expect(stopWords('film')).toBe(STOPPED_FILM);
    expect(stopWords('stream')).toBe(STOPPED_STREAM);
  });
  it('an error on a film that has been playing goes to the recovery before the codec ladder', () => {
    const onError = tv.slice(tv.indexOf('const onError = '));
    const recover = onError.indexOf('recoverAgain(');
    expect(recover).toBeGreaterThan(0);
    expect(recover).toBeLessThan(onError.indexOf('const looksTransient'));
    expect(onError.slice(0, recover)).toMatch(/if \(everPlayed\.current && !isTorrent\) \{\s*$/);
  });
  it('the switch to the encode mid-film never restarts at 0:00', () => {
    const fb = tv.slice(tv.indexOf('const fallbackToTranscode = '), tv.indexOf('const fallbackToTranscode = ') + 900);
    expect(fb).toContain('fallbackToZero: at < 5');
    expect(fb).not.toContain('fallbackToZero: true');
  });
  it('a repackaged stream past its job’s start is made again AT the spot, never handed back to where its job began', () => {
    const r = tv.slice(tv.indexOf('const reloadSame = '), tv.indexOf('const hideStop = '));
    expect(r).toMatch(/if \(usingTranscodeRef\.current && base && at > clockBase\.current \+ 5\) \{\s*resumeAt\.current = 0;\s*ownProbe\.current = probeToken\.current \+ 1;[^\n]*\s*startTranscodeAt\(base, at, currentV\.current\);/);
    // the watcher counts through that probe (a server that does not answer still gets the card at 45 s)
    expect(tv).toMatch(/\(!probing\.current \|\| probingOurs\)/);
    // a repackaged stream is not nudged by a seek
    expect(tv).toMatch(/if \(usingTranscodeRef\.current\) return;\s*mark\('stall-nudge'/);
  });
  it('the card is drawn from the recovery state, with Try again from the same spot', () => {
    expect(tv).toContain('{stopWords(stopCard)}');
    expect(tv).toMatch(/onPress=\{tryAgain\}/);
    expect(tv).not.toContain('Playback has stalled');
  });
});
