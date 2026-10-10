// Which server a run talks to: the list's order, the waits, the first
// address's one second look (src/serverPick.ts). A made-up clock: a ping
// "takes" as long as the script says, and nothing really waits.
import {
  pickServer,
  pingBudget,
  isLanUrl,
  INTERNET_PING_MS,
  LAN_PING_MS,
  FIRST_BUDGET_MS,
  RETRY_NOT_BEFORE_MS,
} from '../../src/serverPick';
import {SERVER_CANDIDATES} from '../../src/api';

const NUFURORA = 'https://nufurora.com';
const HOME = 'http://10.0.0.1:4000';

// what an address does when asked: answers after `ms`, fails after `ms`
// (refused, no route), or never says anything ('silent': the ping's own
// timeout ends it)
type Does = {answer: number} | {fail: number} | 'silent';

const world = (does: Record<string, Does | Does[]>) => {
  let t = 0;
  const calls: {url: string; at: number; timeout: number}[] = [];
  const seen: Record<string, number> = {};
  const deps = {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    ping: async (url: string, timeout: number) => {
      calls.push({url, at: t, timeout});
      const d = does[url];
      const n = seen[url] || 0;
      seen[url] = n + 1;
      const now = Array.isArray(d) ? d[Math.min(n, d.length - 1)] : d;
      if (!now || now === 'silent') {
        t += timeout;
        return false;
      }
      if ('answer' in now) {
        if (now.answer > timeout) {
          t += timeout;
          return false;
        }
        t += now.answer;
        return true;
      }
      t += Math.min(now.fail, timeout);
      return false;
    },
  };
  return {deps, calls, at: () => t};
};

test('the release list: nufurora.com first, then the house server', () => {
  expect(SERVER_CANDIDATES.map(u => u.replace(/\/+$/, ''))).toEqual([NUFURORA, HOME]);
});

test('an internet address is waited for longer than a LAN one', () => {
  expect(isLanUrl(HOME)).toBe(true);
  expect(isLanUrl('http://192.168.50.108:4000')).toBe(true);
  expect(isLanUrl('http://172.16.4.2:4000')).toBe(true);
  expect(isLanUrl(NUFURORA)).toBe(false);
  expect(isLanUrl('http://nufurora.com')).toBe(false);
  expect(isLanUrl('http://172.32.0.1:4000')).toBe(false);
  expect(pingBudget(NUFURORA)).toBe(INTERNET_PING_MS);
  expect(pingBudget(HOME)).toBe(LAN_PING_MS);
});

test('nufurora up: chosen, and the house server is never asked', async () => {
  const w = world({[NUFURORA]: {answer: 180}, [HOME]: {answer: 15}});
  expect(await pickServer([NUFURORA, HOME], w.deps)).toBe(NUFURORA);
  expect(w.calls.map(c => c.url)).toEqual([NUFURORA]);
  expect(w.at()).toBe(180); // no wait for anything else
});

test('a slow nufurora inside the wait still wins over a house server that would answer at once', async () => {
  const w = world({[NUFURORA]: {answer: INTERNET_PING_MS - 100}, [HOME]: {answer: 10}});
  expect(await pickServer([NUFURORA, HOME], w.deps)).toBe(NUFURORA);
  expect(w.calls.map(c => c.url)).toEqual([NUFURORA]);
});

test('nufurora refused at once, home up: one second look, then home — in well under a second', async () => {
  const w = world({[NUFURORA]: {fail: 40}, [HOME]: {answer: 20}});
  expect(await pickServer([NUFURORA, HOME], w.deps)).toBe(HOME);
  expect(w.calls.map(c => c.url)).toEqual([NUFURORA, NUFURORA, HOME]);
  // the second look is not made in the same dead moment as the first
  expect(w.calls[1].at).toBe(RETRY_NOT_BEFORE_MS);
  expect(w.at()).toBe(RETRY_NOT_BEFORE_MS + 40 + 20);
});

test('nufurora silent (packets swallowed), home up: home, no later than the first address’s budget', async () => {
  const w = world({[NUFURORA]: 'silent', [HOME]: {answer: 20}});
  expect(await pickServer([NUFURORA, HOME], w.deps)).toBe(HOME);
  expect(w.calls.map(c => c.url)).toEqual([NUFURORA, NUFURORA, HOME]);
  expect(w.calls[0].timeout).toBe(INTERNET_PING_MS);
  expect(w.calls[1].timeout).toBe(FIRST_BUDGET_MS - INTERNET_PING_MS);
  expect(w.calls[2].at).toBe(FIRST_BUDGET_MS);
  expect(w.at()).toBe(FIRST_BUDGET_MS + 20);
});

test('the Wi-Fi was still waking: nufurora fails once, answers on the second look — home is not asked', async () => {
  const w = world({[NUFURORA]: [{fail: 30}, {answer: 250}], [HOME]: {answer: 20}});
  expect(await pickServer([NUFURORA, HOME], w.deps)).toBe(NUFURORA);
  expect(w.calls.map(c => c.url)).toEqual([NUFURORA, NUFURORA]);
});

test('both down: null (the offline screen), each address asked, the second only once', async () => {
  const w = world({[NUFURORA]: 'silent', [HOME]: 'silent'});
  expect(await pickServer([NUFURORA, HOME], w.deps)).toBeNull();
  expect(w.calls.map(c => c.url)).toEqual([NUFURORA, NUFURORA, HOME]);
  expect(w.at()).toBe(FIRST_BUDGET_MS + LAN_PING_MS);
});

test('every call starts at the top again: a run that fell back does not stay fallen back', async () => {
  const down = world({[NUFURORA]: {fail: 10}, [HOME]: {answer: 20}});
  expect(await pickServer([NUFURORA, HOME], down.deps)).toBe(HOME);
  const up = world({[NUFURORA]: {answer: 200}, [HOME]: {answer: 20}});
  expect(await pickServer([NUFURORA, HOME], up.deps)).toBe(NUFURORA);
  expect(up.calls[0].url).toBe(NUFURORA);
});

test('a QA build’s inserted first line is the first address tried, with a LAN wait', async () => {
  const QA = 'http://192.168.50.108:4000';
  const w = world({[QA]: {answer: 12}, [NUFURORA]: {answer: 100}, [HOME]: {answer: 10}});
  expect(await pickServer([QA, NUFURORA, HOME], w.deps)).toBe(QA);
  expect(w.calls).toEqual([{url: QA, at: 0, timeout: LAN_PING_MS}]);
  // and with the QA PC off, the release order follows
  const off = world({[QA]: 'silent', [NUFURORA]: {answer: 100}, [HOME]: {answer: 10}});
  expect(await pickServer([QA, NUFURORA, HOME], off.deps)).toBe(NUFURORA);
  expect(off.calls.map(c => c.url)).toEqual([QA, QA, NUFURORA]);
});

test('a trailing slash is not part of the address', async () => {
  const w = world({[NUFURORA]: {answer: 50}});
  expect(await pickServer([NUFURORA + '/'], w.deps)).toBe(NUFURORA);
});
