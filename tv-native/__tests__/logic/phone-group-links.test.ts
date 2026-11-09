// "What do we watch tonight?": the TV's QR (groupPick.ts joinUrl) opens the
// phone app's join step with the code (phone/linkParse.ts).
import {parsePhoneLink} from '../../src/phone/linkParse';
import {joinUrl} from '../../src/groupPick';

test("the TV's QR, the app's own scheme, and a hand-typed address", () => {
  expect(parsePhoneLink(joinUrl('https://nufurora.com', 'K7QM'))).toEqual({
    kind: 'group',
    code: 'K7QM',
  });
  expect(parsePhoneLink('https://nufurora.com/#/group/k7qm')).toEqual({
    kind: 'group',
    code: 'K7QM',
  });
  expect(parsePhoneLink('https://www.nufurora.com/#/group/K7QM')).toEqual({
    kind: 'group',
    code: 'K7QM',
  });
  expect(parsePhoneLink('aurora-phone://group/K7QM')).toEqual({
    kind: 'group',
    code: 'K7QM',
  });
  // the server this phone is on (a home address)
  expect(parsePhoneLink('http://10.0.0.5:4000/#/group/K7QM', ['nufurora.com', '10.0.0.5:4000'])).toEqual({kind: 'group', code: 'K7QM'});
});

test('no code, or one that cannot be a code: the type-the-code field', () => {
  expect(parsePhoneLink('https://nufurora.com/#/group')).toEqual({
    kind: 'group',
    code: null,
  });
  expect(parsePhoneLink('https://nufurora.com/#/group/K7Q')).toEqual({
    kind: 'group',
    code: null,
  });
  expect(parsePhoneLink('https://nufurora.com/#/group/K7QMX')).toEqual({
    kind: 'group',
    code: null,
  });
  expect(parsePhoneLink('https://nufurora.com/#/group/O0I1')).toEqual({
    kind: 'group',
    code: null,
  }); // look-alikes are never in a code
});

test("someone else's site never opens it", () => {
  expect(parsePhoneLink('https://example.com/#/group/K7QM')).toBe(null);
});

test('the watch party link is still a party', () => {
  expect(parsePhoneLink('https://nufurora.com/#/party/ABCD')).toEqual({
    kind: 'party',
    code: 'ABCD',
  });
});
