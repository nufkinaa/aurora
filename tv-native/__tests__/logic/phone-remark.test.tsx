// The phone Home's remark (src/phone/useRemark.ts, over src/remark.ts) — the website's greeting
// block: a line at once, the server's in its place when it comes, a kids profile only ever
// shows the server's warm line; and Wrapped's intervention (wrappedWords.ts interventionFor):
// the server's roasts as sent, the rules when there are none, kind words for a kids profile.
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';

const mockApi = jest.fn();
jest.mock('../../src/api', () => ({apiRequest: (p: string) => mockApi(p)}));
jest.mock('../../src/profileScope', () => ({registerProfileCache: () => {}}));

import {firstLine, RemarkState, useRemark, wanted} from '../../src/phone/useRemark';
import {LOCAL_LINES, _resetRemarks} from '../../src/remark';
import {interventionFor, roastsFor, Wrapped} from '../../src/phone/wrappedWords';

beforeEach(() => {
  _resetRemarks();
  mockApi.mockReset();
});

describe('the first line', () => {
  it('is a local line for a grown-up and nothing for a kids profile', () => {
    expect(LOCAL_LINES).toContain(firstLine('a1', false));
    expect(firstLine('k1', true)).toBe('');
  });
  it('the server line replaces only when it says something else; a kids profile never takes a local one', () => {
    expect(wanted(null, 'x', false)).toBe(false);
    expect(wanted({id: 'e-1', text: 'x', kind: 'everyday'}, 'x', false)).toBe(false);
    expect(wanted({id: 'e-1', text: 'y', kind: 'everyday'}, 'x', false)).toBe(true);
    expect(wanted({id: null, text: 'y', kind: 'local'}, '', true)).toBe(false);
    expect(wanted({id: 'k-1', text: 'Story time!', kind: 'kids-any'}, '', true)).toBe(true);
  });
});

function Probe({id, kids, out}: {id: string; kids: boolean | null; out: {r?: RemarkState}}) {
  out.r = useRemark(id, kids, true);
  return null;
}
const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>(r => setTimeout(r, 0));
});

describe('the hook', () => {
  it("shows a local line, then the server's (a quick answer is a plain swap)", async () => {
    mockApi.mockResolvedValue({id: 'ev-3', text: 'Server says hi.', kind: 'everyday'});
    const out: {r?: RemarkState} = {};
    let t: TestRenderer.ReactTestRenderer;
    act(() => {
      t = TestRenderer.create(<Probe id="g1" kids={false} out={out} />);
    });
    expect(LOCAL_LINES).toContain(out.r!.text);
    await flush();
    expect(mockApi).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/profiles\/g1\/remark\?tzo=/));
    expect(out.r!.offer).toBe('Server says hi.');
    act(() => out.r!.take(true));
    expect(out.r!.text).toBe('Server says hi.');
    expect(out.r!.offer).toBe(null);
    act(() => t!.unmount());
  });

  it('a refused offer (it would need more lines under the billboard) keeps the line on screen', async () => {
    mockApi.mockResolvedValue({id: 'ev-4', text: 'A much longer line than the one on screen.', kind: 'everyday'});
    const out: {r?: RemarkState} = {};
    act(() => {
      TestRenderer.create(<Probe id="g2" kids={false} out={out} />);
    });
    const was = out.r!.text;
    await flush();
    act(() => out.r!.take(false));
    expect(out.r!.text).toBe(was);
    expect(out.r!.offer).toBe(null);
  });

  it('a kids profile shows nothing until the server, and nothing when it cannot be had', async () => {
    mockApi.mockRejectedValue(new Error('offline'));
    const out: {r?: RemarkState} = {};
    act(() => {
      TestRenderer.create(<Probe id="k2" kids out={out} />);
    });
    expect(out.r!.text).toBe('');
    await flush();
    expect(out.r!.offer).toBe(null);
    expect(out.r!.text).toBe('');

    _resetRemarks();
    mockApi.mockResolvedValue({id: 'kids-any-2', text: 'Ready for a story?', kind: 'kids-any'});
    const out2: {r?: RemarkState} = {};
    act(() => {
      TestRenderer.create(<Probe id="k3" kids out={out2} />);
    });
    await flush();
    act(() => out2.r!.take(true));
    expect(out2.r!.text).toBe('Ready for a story?');
  });

  it('waits for the profile (kids or not) before it says anything', async () => {
    const out: {r?: RemarkState} = {};
    act(() => {
      TestRenderer.create(<Probe id="u1" kids={null} out={out} />);
    });
    await flush();
    expect(out.r!.text).toBe('');
    expect(mockApi).not.toHaveBeenCalled();
  });
});

describe("Wrapped's intervention", () => {
  const w: Wrapped = {
    since: '2026-01-01', totalSec: 40 * 3600, plays: 30, distinctTitles: 9, topTitles: [{name: 'Dark', sec: 20 * 3600}],
    topWeekday: 5, byDevice: [], biggestDay: null, bestStreak: 4, lateNightSessions: 0, latestFinish: null,
    longestSession: null, activeDays: 12, topGenres: [], started: 10, finished: 2,
  };
  it("uses the server's roasts as sent, four at most, empty ones dropped", () => {
    expect(interventionFor({...w, roasts: ['One.', ' ', 'Two.', 'Three.', 'Four.', 'Five.']}, 'Ann')).toEqual(['One.', 'Two.', 'Three.', 'Four.']);
  });
  it('falls back to the rules when the server sends none', () => {
    expect(interventionFor(w, 'Ann')).toEqual(roastsFor(w, 'Ann'));
    expect(interventionFor({...w, roasts: []}, 'Ann')).toEqual(roastsFor(w, 'Ann'));
  });
  it('never roasts a kids profile', () => {
    const k = interventionFor({...w, roasts: ['Sting.']}, 'Kid', {kids: true});
    expect(k).not.toContain('Sting.');
    expect(k[0]).toBe('Your favourite was “Dark”. Great pick, Kid!');
    for (const l of roastsFor(w, 'Kid')) expect(k).not.toContain(l);
  });
});
