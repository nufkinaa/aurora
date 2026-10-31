// The new-password screen's own rules (screens/NewPassword.tsx). PURE.
//
// [auth-round] Two reasons to be on that screen, both answered by the server
// with `mustReset` on the sign-in and `passwordResetRequired` on /api/me:
//   - "forced": the admin asked for a new password on this profile. The
//     current password is needed to save it; the TV already holds it after a
//     typed sign-in or an unlock, and asks for it otherwise (QR pairing, Google).
//   - "setup" (`passwordSetup: true`): the profile signs in with Google only
//     and has no password yet. Nothing to ask; the screen says "Set a password".
import {FieldName, refusalWords, RefusalLike} from './authFlow';

export {MIN_PASSWORD} from './passRules';

export type NewPasswordMode = {mode: 'loading' | 'setup' | 'forced'; askCurrent: boolean};

/** Which screen to draw. `typed`: the password this TV just saw (null when it
 *  saw none). `me`: /api/me's answer - undefined while it is on its way,
 *  null when it could not be had. */
export function newPasswordMode(
  typed: string | null,
  me: {passwordSetup?: boolean} | null | undefined,
): NewPasswordMode {
  if (typeof typed === 'string') return {mode: 'forced', askCurrent: false};
  if (me === undefined) return {mode: 'loading', askCurrent: false};
  if (me && me.passwordSetup) return {mode: 'setup', askCurrent: false};
  return {mode: 'forced', askCurrent: true};
}

/** What to say when the server refused the save (POST /api/profiles/:id/
 *  password or /api/auth/password), and next to which field: 401 = the
 *  current password is wrong; 400 carries a `code` ("same", "short",
 *  "mismatch") and words written for the viewer; 429 carries the wait. */
export function saveRefusal(e: RefusalLike | null | undefined, admin = 'the admin'): {field: FieldName | null; words: string} {
  if (e && e.status === 401) return {field: 'current', words: "That isn't your current password."};
  return refusalWords(e, 'newPassword', admin);
}
