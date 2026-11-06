// "Tell me when it's ready" on the TV and the phone (src/readyNotice.ts): the
// same cases as the website's (test/ready-notice.test.js in the server's tests).
import {readyText, READY_LABEL, READY_NOTE} from '../../src/readyNotice';

const done = {status: 'done', mine: true, libraryId: 'lib1', seenAt: null, smart: false, label: 'Film', title: 'Film'};
const LANG = "This copy doesn't say its language — report it again if it's wrong.";

describe('readyText', () => {
  test("the server's sentence, else the same fallback as the website", () => {
    expect(readyText({...done, readyLine: '“Film” is ready to watch'}, true)).toBe('“Film” is ready to watch');
    expect(readyText(done, true)).toBe('“Film” is ready to watch');
    expect(readyText({...done, label: 'Film — another version'}, true)).toBe('“Film” is ready to watch');
  });
  test('what the language check found rides along — and is said even with the switch off', () => {
    expect(readyText({...done, readyLine: 'The new version of “Film” is in — ready to watch', langLine: LANG}, true)).toBe(
      `The new version of “Film” is in — ready to watch. ${LANG}`,
    );
    expect(readyText({...done, langLine: LANG}, false)).toBe(`“Film”: ${LANG}`);
  });
  test('nothing when switched off, not yours, not landed, already opened, or a smart download', () => {
    expect(readyText(done, false)).toBeNull();
    expect(readyText({...done, mine: false}, true)).toBeNull();
    expect(readyText({...done, status: 'downloading'}, true)).toBeNull();
    expect(readyText({...done, libraryId: null}, true)).toBeNull();
    expect(readyText({...done, seenAt: '2026-11-06T10:00:00Z'}, true)).toBeNull();
    expect(readyText({...done, smart: true}, true)).toBeNull();
    expect(readyText(null, true)).toBeNull();
  });
  test('the Settings wording', () => {
    expect(READY_LABEL).toBe("Tell me when it's ready");
    expect(READY_NOTE).toBe('When something you asked for has downloaded, Aurora says so — on every device you use.');
  });
});
