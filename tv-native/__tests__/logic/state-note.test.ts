// The profile's state the app keeps (api.ts lastState / stateIfFresh): a
// position the player saves is written into it, not a reason to forget it all
// (streaming round 2: the next episode's player starts from it without asking
// again; the same title opened again resumes where it was just left).
import {api, setBaseUrl} from '../../src/api';
import {resumePoint} from '../../src/episodeRules';
import {queue, resetXhr, sent} from './fake-xhr';

const ok = (body: unknown = {}) => ({status: 200, body: JSON.stringify(body)});

beforeEach(() => {
  resetXhr();
  setBaseUrl('http://tv.test');
  api.forgetState();
});

test('a saved position lands in the kept state: one row changes, the rest stay', async () => {
  queue(ok({progress: {e1: {position: 100, duration: 2400}, e2: {position: 600, duration: 2400, finished: false}}}));
  await api.state('p1');
  api.noteProgress('p1', 'e1', 2390, 2400);
  const st = api.stateIfFresh('p1', 30000)!;
  expect(st.progress.e1).toMatchObject({position: 2390, duration: 2400});
  expect(st.progress.e2).toEqual({position: 600, duration: 2400, finished: false});
  // the next episode resumes from the kept answer, with no new request
  expect(resumePoint(st.progress.e2, 2400)).toBe(596);
  expect(sent).toHaveLength(1);
  // and the one just left is past its end rule: no resume there
  expect(resumePoint(st.progress.e1, 2400)).toBeNull();
});

test('another profile, or nothing kept: nothing is written', async () => {
  api.noteProgress('p1', 'e1', 50, 100);
  expect(api.stateIfFresh('p1', 30000)).toBeNull();
  queue(ok({progress: {}}));
  await api.state('p2');
  api.noteProgress('p1', 'e1', 50, 100);
  expect(api.stateIfFresh('p2', 30000)!.progress).toEqual({});
});

test('a new row is added', async () => {
  queue(ok({progress: {}}));
  await api.state('p1');
  api.noteProgress('p1', 'm1', 300, 6000);
  expect(resumePoint(api.stateIfFresh('p1', 30000)!.progress.m1, 6000)).toBe(296);
});
