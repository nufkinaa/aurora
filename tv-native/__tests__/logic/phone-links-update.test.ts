// The phone app: what a TV's sign-in QR (and every other link) opens, and the self-update's
// decisions (phone/linkParse.ts, phone/update/rules.ts — both pure). Plus the manifest's
// link rules, read as text: which nufurora.com addresses the app claims.
export {};
declare const __dirname: string;
import {pairCode, parsePhoneLink, typedPairCode} from '../../src/phone/linkParse';
import {
  checkOnReturn,
  cmpVersion,
  decide,
  dmFailure,
  dmFraction,
  dmLine,
  hasRoom,
  installFailure,
  justUpdated,
  resumeWanted,
  retryable,
  RETURN_CHECK_MS,
  RESUME_MS,
  roomNeeded,
  SNOOZE_MS,
  spaceLine,
  verifyFailure,
} from '../../src/phone/update/rules';
import {askerName, mdPieces, nextRating} from '../../src/phone/words';

const fs = require('fs');
const path = require('path');

describe("a TV's sign-in QR opens the app on “Sign in this TV?”", () => {
  test('the QR (nufurora.com/link?code=…), any case, with or without a slash or junk around', () => {
    expect(parsePhoneLink('https://nufurora.com/link?code=ABC234')).toEqual({kind: 'pair', code: 'ABC234'});
    expect(parsePhoneLink('https://nufurora.com/link?code=abc234')).toEqual({kind: 'pair', code: 'ABC234'});
    expect(parsePhoneLink('https://www.nufurora.com/link/?code=ABC234&x=1')).toEqual({kind: 'pair', code: 'ABC234'});
    expect(parsePhoneLink('http://nufurora.com/link?x=1&code=ABC-234')).toEqual({kind: 'pair', code: 'ABC234'});
  });
  test('no code, or one that cannot be a TV code: the type-the-code field', () => {
    expect(parsePhoneLink('https://nufurora.com/link')).toEqual({kind: 'pair', code: null});
    expect(parsePhoneLink('https://nufurora.com/link?code=')).toEqual({kind: 'pair', code: null});
    // 0 / O / 1 / I / L are not in the TV's alphabet; five or seven long are not codes
    expect(parsePhoneLink('https://nufurora.com/link?code=ABC10O')).toEqual({kind: 'pair', code: null});
    expect(parsePhoneLink('https://nufurora.com/link?code=ABC23')).toEqual({kind: 'pair', code: null});
    expect(parsePhoneLink('https://nufurora.com/link?code=ABC2345')).toEqual({kind: 'pair', code: null});
  });
  test('the website’s own pair page, and the app’s own scheme', () => {
    expect(parsePhoneLink('https://nufurora.com/#/pair/XYZ789')).toEqual({kind: 'pair', code: 'XYZ789'});
    expect(parsePhoneLink('https://nufurora.com/#/pair')).toEqual({kind: 'pair', code: null});
    expect(parsePhoneLink('aurora-phone://pair/xyz789')).toEqual({kind: 'pair', code: 'XYZ789'});
    expect(parsePhoneLink('aurora-phone://link?code=XYZ789')).toEqual({kind: 'pair', code: 'XYZ789'});
  });
  test('the house server’s own address (the TV on the LAN) when the phone is on that server; never a stranger’s', () => {
    expect(parsePhoneLink('http://192.168.50.2:4000/link?code=ABC234')).toBeNull();
    expect(parsePhoneLink('http://192.168.50.2:4000/link?code=ABC234', ['nufurora.com', '192.168.50.2:4000'])).toEqual({kind: 'pair', code: 'ABC234'});
    expect(parsePhoneLink('https://evil.example/link?code=ABC234')).toBeNull();
    expect(parsePhoneLink('https://nufurora.com.evil.example/link?code=ABC234')).toBeNull();
  });
  test('/link is a page of its own: /linked, /links, /install, /download/phone are not', () => {
    expect(parsePhoneLink('https://nufurora.com/linked?code=ABC234')).toBeNull();
    expect(parsePhoneLink('https://nufurora.com/install')).toBeNull();
    expect(parsePhoneLink('https://nufurora.com/download/phone')).toBeNull();
  });
  test('the code field: capitals, letters and digits, six at most; a code is six of the alphabet', () => {
    expect(typedPairCode('ab c-12x9')).toBe('ABC12X');
    expect(pairCode(' abc234 ')).toBe('ABC234');
    expect(pairCode('ABCDEFG')).toBeNull();
    expect(pairCode(null)).toBeNull();
    expect(pairCode('AAAA1A')).toBeNull();
  });
  test('who is asking, in the website’s words', () => {
    expect(askerName({device: {device: 'Mi TV Stick', os: 'Android'}})).toBe('Mi TV Stick · Android');
    expect(askerName({device: {device: 'Other', os: 'Android'}})).toBe('Android');
    expect(askerName({device: {device: 'Other', os: 'Other'}})).toBe('A device');
    expect(askerName(null)).toBe('A device');
  });
});

describe('every address the website and the server hand out opens the right place', () => {
  test('the website’s search link (#/search/<q>) as well as the app’s (?q=)', () => {
    expect(parsePhoneLink('https://nufurora.com/#/search/the%20bear')).toEqual({kind: 'search', q: 'the bear'});
    expect(parsePhoneLink('https://nufurora.com/#/search?q=dune')).toEqual({kind: 'search', q: 'dune'});
  });
  test('the "is ready" push (#/play/<id>), the website’s pages the app has, and the ones only the site has', () => {
    expect(parsePhoneLink('https://nufurora.com/#/play/ab12cd')).toEqual({kind: 'play', id: 'ab12cd'});
    expect(parsePhoneLink('https://nufurora.com/#/play/<x>')).toBeNull();
    expect(parsePhoneLink('https://nufurora.com/#/new')).toEqual({kind: 'screen', name: 'WhatsNew'});
    expect(parsePhoneLink('https://nufurora.com/#/household/sent')).toEqual({kind: 'screen', name: 'Household', params: {tab: 'sent'}});
    expect(parsePhoneLink('https://nufurora.com/#/household')).toEqual({kind: 'screen', name: 'Household', params: undefined});
    expect(parsePhoneLink('https://nufurora.com/#/saved')).toEqual({kind: 'screen', name: 'Downloads'});
    expect(parsePhoneLink('https://nufurora.com/#/wrapped')).toEqual({kind: 'screen', name: 'Wrapped'});
    expect(parsePhoneLink('https://nufurora.com/#/taste')).toEqual({kind: 'screen', name: 'Taste'});
    expect(parsePhoneLink('https://nufurora.com/#/taste/list')).toEqual({kind: 'screen', name: 'TasteList'});
    expect(parsePhoneLink('aurora-phone://wrapped')).toEqual({kind: 'screen', name: 'Wrapped'});
    expect(parsePhoneLink('https://nufurora.com/#/pick')).toEqual({kind: 'web', path: 'pick'});
    expect(parsePhoneLink('https://nufurora.com/#/requests')).toEqual({kind: 'web', path: 'requests'});
    expect(parsePhoneLink('https://nufurora.com/#/party/ABCD')).toEqual({kind: 'party', code: 'ABCD'});
  });
});

describe('the phone manifest claims exactly the app’s pages of nufurora.com', () => {
  const m = fs.readFileSync(path.join(__dirname, '../../android/app/src/phone/AndroidManifest.xml'), 'utf8') as string;
  const filter = m.slice(m.indexOf('android:autoVerify="true"'), m.indexOf('</intent-filter>', m.indexOf('android:autoVerify="true"')));
  test('"/" (every hash route) and "/link" (a TV’s QR) on nufurora.com — no prefix, no pattern', () => {
    expect(filter).toMatch(/android:host="nufurora\.com"/);
    const paths = [...filter.matchAll(/android:path="([^"]+)"/g)].map(x => x[1]);
    expect(paths.sort()).toEqual(['/', '/link']);
    // /install, /download/phone (the APK itself), /web, /admin… stay the browser's
    expect(filter).not.toMatch(/pathPrefix|pathPattern|pathAdvancedPattern|pathSuffix/);
    expect(filter).toMatch(/android:scheme="https"/);
  });
});

describe('the self-update decides', () => {
  const run = {versionName: '1.0.0', versionCode: 1};
  const now = 5_000_000;
  test('newer: offered — the same version never (no prompt loop), an older one never (no downgrade)', () => {
    expect(decide({versionName: '1.0.1', versionCode: 2}, run, null, now)).toBe('offer');
    expect(decide({versionName: '1.0.0', versionCode: 1}, run, null, now)).toBe('same');
    expect(decide({versionName: '1.0.0', versionCode: 9}, run, null, now)).toBe('same');
    expect(decide({versionName: '0.9.9', versionCode: 9}, run, null, now)).toBe('downgrade');
    expect(decide({versionName: '1.0.10'}, {versionName: '1.0.9', versionCode: 0}, null, now)).toBe('offer');
  });
  test('a newer name with a build number that did not go up: Android would refuse it, so never offered', () => {
    expect(decide({versionName: '1.0.1', versionCode: 1}, run, null, now)).toBe('badcode');
    expect(decide({versionName: '1.0.1', versionCode: 0}, run, null, now)).toBe('offer'); // unknown: Android decides
  });
  test('Later holds that one version back for a day', () => {
    expect(decide({versionName: '1.0.1', versionCode: 2}, run, {version: '1.0.1', until: now + 1}, now)).toBe('snoozed');
    expect(decide({versionName: '1.0.1', versionCode: 2}, run, {version: '1.0.1', until: now - 1}, now)).toBe('offer');
    expect(decide({versionName: '1.0.2', versionCode: 3}, run, {version: '1.0.1', until: now + SNOOZE_MS}, now)).toBe('offer');
  });
  test('nothing usable published: nothing said', () => {
    expect(decide(null, run, null, now)).toBe('none');
    expect(decide({versionName: ''}, run, null, now)).toBe('none');
    expect(decide({versionName: '<b>1.2</b>'}, run, null, now)).toBe('none');
  });
  test('versions compare as numbers', () => {
    expect(cmpVersion('1.0.10', '1.0.9')).toBe(1);
    expect(cmpVersion('1.0', '1.0.0')).toBe(0);
    expect(cmpVersion('1.0.0', '1.1')).toBe(-1);
  });
  test('coming back to the app asks again at most every 30 minutes, never over the sheet', () => {
    expect(checkOnReturn(0, RETURN_CHECK_MS, false)).toBe(true);
    expect(checkOnReturn(1000, RETURN_CHECK_MS, false)).toBe(false);
    expect(checkOnReturn(0, RETURN_CHECK_MS, true)).toBe(false);
  });
  test('Update pressed, then Android’s settings and a restart: carried on only for that version, only soon after', () => {
    expect(resumeWanted({version: '1.0.1', at: now - 1000}, '1.0.1', now)).toBe(true);
    expect(resumeWanted({version: '1.0.1', at: now - RESUME_MS - 1}, '1.0.1', now)).toBe(false);
    expect(resumeWanted({version: '1.0.1', at: now}, '1.0.2', now)).toBe(false);
    expect(resumeWanted(null, '1.0.1', now)).toBe(false);
  });
  test('room: the file, Android’s copy and some to spare; unknown never blocks', () => {
    const size = 46 * 1024 ** 2;
    expect(roomNeeded(size)).toBe(Math.ceil(size * 2.5) + 50 * 1024 ** 2);
    expect(hasRoom(size, roomNeeded(size))).toBe(true);
    expect(hasRoom(size, roomNeeded(size) - 1)).toBe(false);
    expect(hasRoom(size, -1)).toBe(true);
    expect(hasRoom(null, 10)).toBe(true);
    expect(spaceLine(size, 20 * 1024 ** 2)).toMatch(/needs about 165 MB free, and 20\.0 MB is/);
  });
  test('the download’s line: progress, or why it waits', () => {
    expect(dmLine({status: 'running', bytes: 23 * 1024 ** 2, total: 46 * 1024 ** 2})).toBe('Downloading… 50% of 46.0 MB');
    expect(dmLine({status: 'running', bytes: 0, total: -1}, 46 * 1024 ** 2)).toBe('Downloading… 0% of 46.0 MB');
    expect(dmLine({status: 'paused', reason: 2})).toMatch(/Waiting for a connection/);
    expect(dmLine({status: 'paused', reason: 1})).toMatch(/didn't answer/);
    expect(dmLine({status: 'pending'})).toBe('Starting the download…');
    expect(dmFraction({status: 'running', bytes: 5, total: 10})).toBe(0.5);
    expect(dmFraction({status: 'running', bytes: 5, total: 0})).toBe(0);
  });
  test('every failure in plain words', () => {
    expect(dmFailure(1006)).toMatch(/enough free space/);
    expect(dmFailure(404)).toMatch(/no longer on the server/);
    expect(dmFailure(503)).toMatch(/answered 503/);
    expect(dmFailure(undefined)).toMatch(/stopped/);
    expect(verifyFailure('sha256')).toMatch(/damaged/);
    expect(verifyFailure('size')).toMatch(/damaged/);
    expect(verifyFailure('signer')).toMatch(/signed/);
    expect(verifyFailure('older')).toMatch(/not newer/);
    expect(verifyFailure('package')).toMatch(/isn't Aurora/);
    expect(installFailure('aborted')).toMatch(/wasn't installed/);
    expect(installFailure('storage')).toMatch(/free space/);
    expect(installFailure('failed', 'INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match')).toMatch(/doesn't match/);
    expect(installFailure('failed', '')).toMatch(/didn't install/);
  });
  test('a damaged file is fetched again by itself; a wrong one is not', () => {
    expect(retryable('sha256')).toBe(true);
    expect(retryable('size')).toBe(true);
    expect(retryable('signer')).toBe(false);
    expect(retryable('older')).toBe(false);
  });
  test('what’s new, once: only when this run is newer than the last one', () => {
    expect(justUpdated('1.0.0', '1.0.1')).toBe(true);
    expect(justUpdated('1.0.1', '1.0.1')).toBe(false);
    expect(justUpdated(null, '1.0.1')).toBe(false); // a first install: nothing to say
    expect(justUpdated('1.0.2', '1.0.1')).toBe(false);
  });
});

describe('small pieces', () => {
  test('stars: the lit one again clears it', () => {
    expect(nextRating(0, 4)).toBe(4);
    expect(nextRating(4, 4)).toBe(0);
    expect(nextRating(4, 2)).toBe(2);
  });
  test('the changelog’s Markdown: **bold** drawn bold, `code` plain', () => {
    expect(mdPieces('**Fast.** Starts `now` at once')).toEqual([
      {text: 'Fast.', bold: true},
      {text: ' Starts now at once', bold: false},
    ]);
    expect(mdPieces('plain')).toEqual([{text: 'plain', bold: false}]);
  });
});
