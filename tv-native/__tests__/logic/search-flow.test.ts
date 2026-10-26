// Search on the TV (searchFlow.ts, driven by screens/Search.tsx): a catalogue
// that was too slow or down is retried ONCE and then said as a failure with
// Try again — never "No results" (2026-10-26, "La Cocina"). The same steps
// and words as the website (public/js/searchflow.js; the root test
// test/search-flow.test.js runs both through one set of assertions).
import {runSearch, SEARCH_TEXT, settleNote} from '../../src/searchFlow';

type A = {results: Array<{key?: string; title: string}>; related: unknown[]; pending: boolean; catalogFailed?: boolean};
const answer = (titles: string[], extra: Partial<A> = {}): A => ({
  results: titles.map(title => ({key: `k:${title}`, title})),
  related: [],
  pending: false,
  catalogFailed: false,
  ...extra,
});

const drive = async (script: Array<A | Error>) => {
  const said: Array<string | null> = [];
  const asks: Array<{wait: boolean; pin: string | null}> = [];
  const out = await runSearch<A>({
    ask: async o => {
      asks.push(o);
      const next = script.shift();
      if (!next || next instanceof Error) throw next || new Error('no more');
      return next;
    },
    paint: () => {},
    busy: t => said.push(t),
    live: () => true,
    committed: true,
    q: 'la cocina',
    retryAfterMs: 1,
  });
  return {out, said, asks};
};

test('a slow catalogue: Still searching…, one retry, found', async () => {
  const {out, said, asks} = await drive([answer([], {pending: true}), answer([], {catalogFailed: true}), answer(['La Cocina'])]);
  expect(asks.map(a => a.wait)).toEqual([false, true, true]);
  expect(said).toContain(SEARCH_TEXT.still);
  expect(out?.note).toBeNull();
});

test("a catalogue that stays down: Couldn't reach the catalogue, never No results", async () => {
  const {out, asks} = await drive([answer([], {pending: true}), answer([], {catalogFailed: true}), answer([], {catalogFailed: true})]);
  expect(asks).toHaveLength(3);
  expect(out?.note).toBe('unreachable');
  expect(SEARCH_TEXT.unreachable).toBe("Couldn't reach the catalogue — try again");
});

test('the server itself does not answer: offline', async () => {
  const {out} = await drive([new Error('Cannot reach server')]);
  expect(out?.note).toBe('offline');
});

test('what a settled search says', () => {
  expect(settleNote({answer: answer(['Test Film One']), failed: true})).toBe('partial');
  expect(settleNote({answer: answer([]), committed: true, q: 'la cocina'})).toBe('none');
  expect(settleNote({answer: answer([]), committed: false, q: 'la'})).toBe('short');
  expect(settleNote({answer: null})).toBe('offline');
});
