// The phone's profile pages say and check what the website says and checks
// (login.js signupView, profiles.js profileModal, preferences.js pickPhoto).
import {
  adminOr,
  AVATARS,
  COLORS,
  EDIT,
  editPlan,
  editRow,
  kidsLabel,
  MIN_PW,
  newPasswordPlaceholder,
  passwordLabel,
  PHOTO,
  photoAnswer,
  photoRow,
  profileLine,
  refusal,
} from '../../src/phone/profiles';

describe('who runs the server', () => {
  test('"the admin" until the server says', () => {
    expect(adminOr('')).toBe('the admin');
    expect(adminOr(' Elia ')).toBe('Elia');
  });
});

describe('edit profile (profiles.js profileModal)', () => {
  const base = {name: 'Dana', avatar: '🦊', color: '#8b7bff', email: 'd@x.io', emailWas: 'd@x.io', newPassword: '', kids: false};
  test('an empty name only focuses the name', () => {
    expect(editPlan({...base, name: '   '}).problem).toBe('name');
  });
  test('the profile fields, trimmed and cut to 24', () => {
    const p = editPlan({...base, name: '  ' + 'x'.repeat(30) + ' '});
    expect(p.problem).toBeNull();
    expect(p.fields).toEqual({name: 'x'.repeat(24), avatar: '🦊', color: '#8b7bff'});
  });
  test('the email is sent only when it changed (blank removes it)', () => {
    expect(editPlan(base).email).toBeNull();
    expect(editPlan({...base, email: ' new@x.io '}).email).toBe('new@x.io');
    expect(editPlan({...base, email: ''}).email).toBe('');
    expect(editPlan({...base, email: null}).email).toBeNull(); // a kids profile has no email field
  });
  test('a new password: at least 4, and never for a kids profile', () => {
    expect(editPlan({...base, newPassword: 'abc'}).problem).toBe(`Passwords need at least ${MIN_PW} characters.`);
    expect(editPlan({...base, newPassword: 'abcd'}).newPassword).toBe('abcd');
    expect(editPlan({...base, newPassword: ''}).newPassword).toBeNull();
    const kid = editPlan({...base, kids: true, newPassword: 'ab'});
    expect(kid.newPassword).toBeNull();
    expect(kid.problem).toBeNull();
  });
  test('the labels and the Settings row', () => {
    expect(passwordLabel(true)).toBe('Password');
    expect(passwordLabel(false)).toBe('Password (optional)');
    expect(newPasswordPlaceholder(true)).toBe('New password (blank = unchanged)');
    expect(newPasswordPlaceholder(false)).toBe('Password (optional)');
    expect(editRow(false).title).toBe('Edit profile & password');
    expect(editRow(true)).toEqual({title: 'Edit profile', detail: 'Name, avatar and colour.'});
  });
  test('the line under the face', () => {
    expect(profileLine({hasPassword: true})).toBe('Password protected');
    expect(profileLine({hasPassword: false})).toBe('No password set');
    expect(profileLine({hasPassword: true, kids: {maxAge: 7}})).toBe('Kids · titles up to 7+');
    expect(kidsLabel({maxAge: 0})).toBe('all-ages titles only');
  });
  test('refusals: the server words as a sentence, the site words for a wrong password', () => {
    expect(refusal('wrong password', EDIT.failed)).toBe("That's not the current password.");
    expect(refusal('that email is already in use', EDIT.failed)).toBe('That email is already in use.');
    expect(refusal('Passwords need at least 4 characters.', EDIT.failed)).toBe('Passwords need at least 4 characters.');
    expect(refusal('', EDIT.failed)).toBe("Couldn't save that profile.");
    expect(refusal('500 /api/profiles/x', EDIT.failed)).toBe("Couldn't save that profile.");
  });
  test('the pickers are the site ones', () => {
    expect(AVATARS).toHaveLength(36);
    expect(new Set(AVATARS).size).toBe(36);
    expect(AVATARS.every(a => a.length <= 8)).toBe(true); // the server keeps an avatar of up to 8 chars
    expect(COLORS).toHaveLength(8);
    expect(COLORS.every(c => /^#[0-9a-f]{6}$/i.test(c))).toBe(true);
  });
});

describe('the photo (preferences.js pickPhoto)', () => {
  test('the row', () => {
    expect(photoRow(false)).toBe('Upload a photo');
    expect(photoRow(true)).toBe('Change photo');
    expect(PHOTO.note).toBe('A picture of you in place of the emoji — JPEG, PNG or WebP, up to 2 MB.');
  });
  test('the answer the native upload hands back', () => {
    expect(photoAnswer(null)).toBeNull();
    expect(photoAnswer('{"ok":true,"profile":{"id":"a","avatarImage":"/avatars/a.jpg?v=1"}}')).toEqual({avatarImage: '/avatars/a.jpg?v=1'});
    expect(photoAnswer('{"ok":true,"profile":{"id":"a","avatarImage":null}}')).toEqual({avatarImage: null});
    expect(photoAnswer('not json')).toBeNull();
    expect(photoAnswer('{"ok":true}')).toBeNull();
  });
});
