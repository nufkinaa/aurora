// The phone's "does this profile have AI?" (phone/aiStatus.ts): asked once per
// profile, shared while the ask is on its way, silent on failure (and not kept),
// dropped when the profile is left.
import {api} from '../../src/api';
import {clearProfileCaches, registeredProfileCaches} from '../../src/profileScope';
import {aiEnabled, aiKnown} from '../../src/phone/aiStatus';

const status = jest.spyOn(api, 'aiStatus');

beforeEach(() => {
  status.mockReset();
  clearProfileCaches();
});

test('asked once, then kept: every later look is answered without the server', async () => {
  status.mockResolvedValue({enabled: true});
  expect(aiKnown()).toBeNull();
  expect(await aiEnabled()).toBe(true);
  expect(await aiEnabled()).toBe(true);
  expect(aiKnown()).toBe(true);
  expect(status).toHaveBeenCalledTimes(1);
});

test('two looks while the ask is on its way share it', async () => {
  let answer: (v: {enabled: boolean}) => void = () => {};
  status.mockReturnValue(new Promise(r => (answer = r)));
  const a = aiEnabled();
  const b = aiEnabled();
  answer({enabled: false});
  expect(await a).toBe(false);
  expect(await b).toBe(false);
  expect(status).toHaveBeenCalledTimes(1);
  expect(aiKnown()).toBe(false);
});

test('a failed ask reads as "no AI", quietly, and is asked again next time', async () => {
  status.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({enabled: true});
  expect(await aiEnabled()).toBe(false);
  expect(aiKnown()).toBeNull();
  expect(await aiEnabled()).toBe(true);
  expect(status).toHaveBeenCalledTimes(2);
});

test('leaving the profile drops the answer — and one landing after that is not the next profile’s', async () => {
  expect(registeredProfileCaches()).toContain('phone/aiStatus');
  status.mockResolvedValueOnce({enabled: true});
  await aiEnabled();
  clearProfileCaches();
  expect(aiKnown()).toBeNull();

  let late: (v: {enabled: boolean}) => void = () => {};
  status.mockReturnValueOnce(new Promise(r => (late = r)));
  const grownUp = aiEnabled();
  clearProfileCaches(); // a kids profile comes in while the grown-up's ask is out
  late({enabled: true});
  expect(await grownUp).toBe(true);
  expect(aiKnown()).toBeNull();
  status.mockResolvedValueOnce({enabled: false});
  expect(await aiEnabled()).toBe(false);
});
