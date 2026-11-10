// Home's remark for the apps (src/remark.ts): the local lines, the ten-minute
// hold, the query (the device's clock and the ids it was shown, nothing
// else), the server's line, and the local line again when there is no answer.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {fetchRemark, localRemark, remarkNow, remarkQuery, LOCAL_LINES, REMARK_HOLD_MS, _resetRemarks} from '../../src/remark';

beforeEach(() => _resetRemarks());

describe('the local lines', () => {
  it('are many, short, and by the part of the day', () => {
    expect(LOCAL_LINES.length).toBeGreaterThanOrEqual(20);
    for (const l of LOCAL_LINES) expect(l.length).toBeLessThanOrEqual(64);
    const morning = new Date(2026, 10, 10, 8);
    for (let i = 0; i < 20; i++) expect(['The couch is preheated.', "Big screen, small ambitions. Let's begin."]).not.toContain(localRemark(morning, () => i / 20));
    expect(localRemark(morning, () => 0, localRemark(morning, () => 0))).not.toBe(localRemark(morning, () => 0));
  });
});

describe('the hold', () => {
  it('keeps the same local line for ten minutes, then another', () => {
    const t = new Date(2026, 10, 10, 20).getTime();
    const a = remarkNow('p1', t, () => 0.1);
    expect(remarkNow('p1', t + REMARK_HOLD_MS - 1, () => 0.9).text).toBe(a.text);
    expect(remarkNow('p1', t + REMARK_HOLD_MS, () => 0.1).text).not.toBe(a.text);
  });
});

describe('the server', () => {
  it('asks with the clock and the ids seen, holds the answer, and sends its id next time', async () => {
    const t = new Date(2026, 10, 10, 20).getTime();
    const paths: string[] = [];
    let n = 0;
    const fetcher = async (p: string) => {
      paths.push(p);
      n++;
      return {id: `em-${n}`, text: `Line ${n}.`, kind: 'everyday-morning'};
    };
    const a = await fetchRemark('p2', {now: t, fetcher});
    expect(a).toEqual({id: 'em-1', text: 'Line 1.', kind: 'everyday-morning'});
    expect(paths[0]).toMatch(/^\/api\/profiles\/p2\/remark\?tzo=-?\d+/);
    expect(paths[0]).not.toContain('seen=');
    expect((await fetchRemark('p2', {now: t + 60000, fetcher})).id).toBe('em-1');
    expect(paths.length).toBe(1);
    expect(remarkNow('p2', t + 60000).text).toBe('Line 1.');
    await fetchRemark('p2', {now: t + REMARK_HOLD_MS, fetcher});
    expect(paths[1]).toContain('seen=em-1');
    const stored = JSON.parse((await AsyncStorage.getItem('aurora.remark.p2')) || '{}');
    expect(stored.seen).toEqual(['em-1', 'em-2']);
  });

  it('with no answer, the line already on screen stays', async () => {
    const t = new Date(2026, 10, 10, 9).getTime();
    const first = remarkNow('p3', t);
    const r = await fetchRemark('p3', {now: t + 1000, fetcher: async () => { throw new Error('offline'); }});
    expect(r).toEqual(first);
    expect((await fetchRemark('p3', {now: t + 2000, fetcher: async () => null})).text).toBe(first.text);
  });

  it('a restarted app inside the hold says the same thing', async () => {
    const t = Date.now();
    await AsyncStorage.setItem('aurora.remark.p4', JSON.stringify({held: {id: 'aw-3', text: 'Kept.', kind: 'away-week', at: t - 1000}, seen: ['aw-3']}));
    const fetcher = jest.fn();
    expect((await fetchRemark('p4', {now: t, fetcher})).text).toBe('Kept.');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('the query says nothing personal', () => {
    expect(remarkQuery(new Date(2026, 0, 1), 'Asia/Jerusalem', ['a-1', 'b-2'])).toMatch(/^tzo=-?\d+&tz=Asia%2FJerusalem&seen=a-1,b-2$/);
  });
});
