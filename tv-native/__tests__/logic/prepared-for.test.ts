// Made overnight (src/avCaps.ts preparedFor, the server's src/media/
// prepared.js): the file the TV and the phone app open in place of the
// title's own when the server holds one this box plays as it is — the
// website's rule to the letter (public/js/screens/player.js preparedFor).
import {preparedFor} from '../../src/avCaps';

const copy = {url: '/stream/prepared/abc123?k=copy', kind: 'copy' as const, audioIndex: 0, height: 2160};
const h264 = {url: '/stream/prepared/abc123?k=h264', kind: 'h264' as const, audioIndex: 1, height: 1080};

test('a prepared file is used when it carries the track this start plays', () => {
  expect(preparedFor(copy, 0)).toEqual(copy);
  expect(preparedFor(h264, 1)).toEqual(h264);
  expect(preparedFor({...copy, audioIndex: undefined}, 0)).not.toBeNull();
});

test('another dub plays the way it always did (only one track is in a prepared file)', () => {
  expect(preparedFor(copy, 1)).toBeNull();
  expect(preparedFor(h264, 0)).toBeNull();
});

test('only what the server sent: a /stream/prepared/ address of a known kind', () => {
  expect(preparedFor(null, 0)).toBeNull();
  expect(preparedFor(undefined, 0)).toBeNull();
  expect(preparedFor('x', 0)).toBeNull();
  expect(preparedFor({...copy, url: 'https://elsewhere.example/x.mp4'}, 0)).toBeNull();
  expect(preparedFor({...copy, url: '/stream/video/abc123'}, 0)).toBeNull();
  expect(preparedFor({...copy, kind: 'hevc'}, 0)).toBeNull();
  expect(preparedFor({...copy, url: '/stream/prepared/abc123?k=other'}, 0)).toBeNull();
});
