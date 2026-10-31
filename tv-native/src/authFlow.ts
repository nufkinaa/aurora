// [auth-round] The TV's sign-in, request and reset flows, as rules: what
// stops a form, which words a refusal gets, where a step goes back to.
// PURE (no React Native, no api) - screens/SignIn.tsx, screens/Reset.tsx and
// screens/NewPassword.tsx draw it; __tests__/logic/auth-flow.test.ts checks it.
//
// THE WORDS are the round's contract (docs/auth-round.md section 2), the same
// on the website and the phone. Plain, short, no emoji.
import {MIN_PASSWORD, passwordProblem, tooManyWords} from './passRules';

export type FieldName =
  | 'identifier'
  | 'password'
  | 'name'
  | 'username'
  | 'email'
  | 'confirm'
  | 'newPassword'
  | 'current'
  | 'code'
  | 'note';
export type FieldErrors = Partial<Record<FieldName, string>>;

/** A sentence starting with a name: "the admin approves…" → "The admin approves…". */
export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const WORDS = {
  signinTitle: 'Sign in',
  signinLine: 'Use your Aurora username or email.',
  identifier: 'Username or email',
  password: 'Password',
  forgot: 'Forgot password?',
  signinBtn: 'Sign in',
  signinBusy: 'Signing in…',
  google: 'Continue with Google',
  googleSignup: 'Sign up with Google',
  requestTitle: 'Request access',
  requestLine: (admin: string) => `${cap(admin)} approves new people. Once you're approved, sign in with the details you set here.`,
  name: 'Your name',
  username: 'Username',
  email: 'Email (optional)',
  confirm: 'Confirm password',
  note: (admin: string) => `Note for ${admin} (optional)`,
  usernameHelp: "Letters and numbers. You'll sign in with it.",
  sendRequest: 'Send request',
  sending: 'Sending…',
  sentTitle: 'Request sent',
  sentLine: (admin: string) => `${cap(admin)} will look at it soon. Once you're approved, sign in with your username and password.`,
  sentLineGoogle: (admin: string, email: string) =>
    `${cap(admin)} will look at it soon. Once you're approved, sign in with Google, or with ${email || 'your email'} and your password.`,
  googleSignupTitle: 'Finish your request',
  googleSignupWho: (email: string) => `Google: ${email}`,
  googleSignupLine: 'Set a password as well, so you can sign in on devices without Google.',
  setTitle: 'Set a password',
  setLine: 'Your profile signs in with Google only. Add a password so you can sign in anywhere.',
  setBtn: 'Save password',
  forcedTitle: 'Choose a new password',
  forcedLine: (admin: string) => `${cap(admin)} asked for a new password on this profile.`,
  forgotTitle: 'Reset your password',
  forgotLine: "Pick how you want to confirm it's you.",
  useGoogle: 'Use Google',
  useGoogleLine: 'For profiles linked to a Google account.',
  askAdmin: (admin: string) => `Ask ${admin}`,
  askAdminLine: (admin: string) => `${cap(admin)} approves it, then you choose a new password here.`,
  haveCode: 'I have a reset code',
  haveCodeLine: (admin: string) => `A code ${admin} gave you.`,
  emailLink: 'Email me a link',
  emailLinkLine: 'A link to your email that works for 30 minutes.',
  elsewhere: 'Still signed in on your phone or computer? Change it in Settings there.',
  askSentTitle: 'Request sent',
  askSentLine: (admin: string) =>
    `Keep this screen open. When ${admin} approves, you can choose a new password here. You can also ask ${admin} for a reset code.`,
  waitingFor: (admin: string) => `Waiting for ${admin}…`,
  codeLabel: 'Reset code',
  codeHelp: (len: number) => `${len} letters and numbers.`,
  continue: 'Continue',
  checking: 'Checking…',
  emailSentTitle: 'Check your email',
  emailSentLine: 'If that profile has an email address, a link is on its way. Open it on your phone or computer within 30 minutes, then sign in here with the new password.',
  newPassword: 'New password',
  signOutOthers: 'Sign out of all other devices',
  saveAndSignIn: 'Save and sign in',
  saving: 'Saving…',
  back: 'Back',
  // errors
  noIdentifier: 'Enter your username or email.',
  noPassword: 'Enter your password.',
  badSignin: "That username and password don't match. Check them, or reset your password.",
  mismatch: "The passwords don't match.",
  offline: "Can't reach Aurora. Check your connection and try again.",
  noName: 'Enter your name.',
  badUsername: 'Use at least 2 letters or numbers.',
  badEmail: "That email doesn't look right.",
  noCode: 'Enter the reset code.',
  noCurrent: 'Enter your current password.',
} as const;

/** "{admin}": the server's admin name as it is written ("Elia", or its
 *  default "the admin"), for the middle of a sentence; cap() it to start one. */
export const adminWord = (name?: string | null): string => {
  const n = String(name || '').trim();
  return n || 'the admin';
};

/** A server sentence made to look like one: capital first letter, a full stop. */
export const sentence = (s: string): string => {
  const t = String(s || '').trim();
  if (!t) return t;
  const c = t[0].toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(c) ? c : c + '.';
};

const USERNAME = (u: string) =>
  String(u || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
const EMAIL_OK = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim());

/** Sign in: what stops the form, per field (nothing = send it). */
export function signinProblems(identifier: string, password: string): FieldErrors {
  const out: FieldErrors = {};
  if (!String(identifier || '').trim()) out.identifier = WORDS.noIdentifier;
  if (!password) out.password = WORDS.noPassword;
  return out;
}

/** A new password and its confirmation (request, Google sign-up, reset, set). */
export function newPasswordProblems(o: {fresh: string; again: string; askCurrent?: boolean; current?: string}): FieldErrors {
  const out: FieldErrors = {};
  if (o.askCurrent && !o.current) out.current = WORDS.noCurrent;
  const p = passwordProblem(o.fresh);
  if (p) out.newPassword = p;
  else if (o.fresh !== o.again) out.confirm = WORDS.mismatch;
  return out;
}

/** Request access. `google` = a verified Google identity rides along: no
 *  username needed then (the Google email signs in), but a password still is. */
export function requestProblems(o: {
  name: string;
  username?: string;
  email?: string;
  password: string;
  confirm: string;
  google?: boolean;
}): FieldErrors {
  const out: FieldErrors = {};
  if (!String(o.name || '').trim()) out.name = WORDS.noName;
  if (!o.google) {
    if (USERNAME(o.username || '').length < 2) out.username = WORDS.badUsername;
    if (String(o.email || '').trim() && !EMAIL_OK(o.email || '')) out.email = WORDS.badEmail;
  }
  const p = newPasswordProblems({fresh: o.password, again: o.confirm});
  if (p.newPassword) out.password = p.newPassword;
  if (p.confirm) out.confirm = p.confirm;
  return out;
}

/** A reset code as the person typed it, made what the server compares:
 *  capitals, no spaces or dashes. */
export const normalizeCode = (s: string): string =>
  String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export function codeProblems(identifier: string, code: string): FieldErrors {
  const out: FieldErrors = {};
  if (!String(identifier || '').trim()) out.identifier = WORDS.noIdentifier;
  if (!normalizeCode(code)) out.code = WORDS.noCode;
  return out;
}

/** The first field (in the form's own order) that has something to say -
 *  where focus goes after a refused send. */
export function firstProblem(errors: FieldErrors, order: FieldName[]): FieldName | null {
  for (const f of order) if (errors[f]) return f;
  return null;
}

export const hasProblems = (e: FieldErrors) => Object.values(e).some(Boolean);

/** What the server's refusal looks like to this module (api.ts ApiError). */
export type RefusalLike = {status?: number; message?: string; code?: string; field?: string; retryAfter?: number};
export type Where = 'signin' | 'request' | 'resetRequest' | 'resetCode' | 'resetComplete' | 'newPassword' | 'google';
export type Refusal = {field: FieldName | null; words: string};

const FIELD_OF: Record<string, FieldName> = {
  identifier: 'identifier',
  username: 'username',
  password: 'password',
  newPassword: 'newPassword',
  confirm: 'confirm',
  name: 'name',
  email: 'email',
  code: 'code',
  currentPassword: 'current',
  current: 'current',
  note: 'note',
};

/** A refused request in the contract's words, and the field it belongs to
 *  (null = it is about the whole form). Never says whether an account exists:
 *  the server does not either, and a wrong sign-in reads the same for a
 *  username that does not exist and a wrong password. */
export function refusalWords(e: RefusalLike | null | undefined, where: Where, admin = 'the admin'): Refusal {
  const status = e && typeof e.status === 'number' ? e.status : 0;
  if (status === 0) return {field: null, words: WORDS.offline};
  if (status === 429 || e?.code === 'limited') return {field: null, words: tooManyWords(e?.retryAfter)};
  let field: FieldName | null = e?.field ? FIELD_OF[e.field] || null : null;
  if (where === 'signin' && (status === 401 || status === 400 || status === 403) && !e?.field) {
    return {field: 'password', words: WORDS.badSignin};
  }
  if (where === 'request' && field === 'newPassword') field = 'password';
  const code = e?.code;
  if (code === 'mismatch') return {field: field || 'confirm', words: WORDS.mismatch};
  if (code === 'short') return {field: field || (where === 'request' ? 'password' : 'newPassword'), words: `Use at least ${MIN_PASSWORD} characters.`};
  if (where === 'resetCode' || where === 'resetComplete') {
    if (code === 'expired') {
      return {
        field: where === 'resetCode' ? 'code' : null,
        words: where === 'resetCode' ? `That code has expired. Ask ${admin} for a new one.` : 'This reset has expired. Start again from Forgot password.',
      };
    }
    if (code === 'used') {
      return {
        field: where === 'resetCode' ? 'code' : null,
        words: where === 'resetCode' ? `That code was already used. Ask ${admin} for a new one.` : 'This reset was already used. Start again from Forgot password.',
      };
    }
    if (where === 'resetCode' && (code === 'wrong' || status === 400 || status === 401 || status === 404)) {
      return {field: 'code', words: `That code doesn't match. Check it, or ask ${admin} for a new one.`};
    }
    if (where === 'resetComplete' && status === 410) {
      return {field: null, words: 'This reset has expired. Start again from Forgot password.'};
    }
  }
  if (code === 'same') return {field: field || 'newPassword', words: 'That is the old password. Pick a different one.'};
  const words = e?.message && !/^\d{3} \//.test(e.message) ? sentence(e.message) : "That didn't work. Try again.";
  return {field, words};
}

// ---- the reset steps --------------------------------------------------------

export type ResetOptionsLike = {google?: boolean; email?: boolean; admin?: boolean};
export type ResetWay = 'google' | 'admin' | 'code' | 'email';

/** The ways the "Reset your password" step lists, in order. Ask the admin
 *  and a reset code are always there; Google and email only when the
 *  server offers them. */
export function resetWays(o: ResetOptionsLike | null | undefined): ResetWay[] {
  const out: ResetWay[] = [];
  if (o?.google) out.push('google');
  out.push('admin', 'code');
  if (o?.email) out.push('email');
  return out;
}

export type ResetStep = 'choose' | 'google' | 'admin' | 'adminWait' | 'code' | 'email' | 'emailSent' | 'newPassword';

/** Where Back goes from a reset step. null = out of the reset, to sign-in. */
export function resetBack(step: ResetStep, came?: ResetStep | null): ResetStep | null {
  switch (step) {
    case 'choose':
      return null;
    case 'adminWait':
      return 'admin';
    case 'emailSent':
      return 'email';
    case 'newPassword':
      // A token is in hand; Back gives it up and starts the choice again.
      return 'choose';
    case 'code':
      // From the waiting screen's "I have a reset code": back to waiting.
      return came === 'adminWait' ? 'adminWait' : 'choose';
    default:
      return 'choose';
  }
}

/** What a poll of an admin request means for the waiting screen. */
export function resetStatusNext(s: {status?: string; token?: string} | null | undefined):
  | {next: 'wait'}
  | {next: 'approved'; token: string}
  | {next: 'stop'; words: (admin: string) => string} {
  const st = s?.status;
  if (st === 'approved' && s?.token) return {next: 'approved', token: s.token};
  if (st === 'declined') return {next: 'stop', words: admin => `${cap(admin)} said no to this request. Talk to ${admin}, or try another way.`};
  if (st === 'expired' || st === 'used') return {next: 'stop', words: () => 'This request has expired. Send a new one.'};
  return {next: 'wait'};
}

export const RESET_POLL_MS = 4000;

// ---- the sign-in area -------------------------------------------------------

export type SignInView = 'signin' | 'request' | 'google' | 'forgot';

/** Back on the sign-in area: one step back, never out of the app from a
 *  sub-step. null = this is the floor (Back leaves the app). */
export function signinBack(view: SignInView): SignInView | null {
  return view === 'signin' ? null : 'signin';
}

/** What Google's answer to the device flow means, by why it was asked. */
export type GoogleNext =
  | {next: 'wait'}
  | {next: 'signedIn'}
  | {next: 'signup'; pollId: string; email: string; name: string}
  | {next: 'reset'; token: string; name: string}
  | {next: 'error'; words: string};
export function googleNext(
  p: {pending?: boolean; signup?: {email?: string | null; name?: string | null}; reset?: {token: string; name: string}; profile?: {id?: string}; profileToken?: string; session?: string; error?: string} | null | undefined,
  pollId: string,
  intent: 'signin' | 'signup' | 'reset',
): GoogleNext {
  if (!p || p.pending) return {next: 'wait'};
  if (p.reset && p.reset.token) return {next: 'reset', token: p.reset.token, name: p.reset.name || ''};
  if (intent === 'reset') {
    // Google said who it is, but no profile is linked to that account.
    return {next: 'error', words: 'No Aurora profile is linked to that Google account. Try another way below.'};
  }
  if (p.signup) {
    return {next: 'signup', pollId, email: String(p.signup.email || ''), name: String(p.signup.name || '')};
  }
  if (p.profile?.id && p.profileToken && p.session) return {next: 'signedIn'};
  return {next: 'error', words: p.error ? sentence(p.error) : "Google didn't finish. Try again."};
}

/** The profile name a Google sign-up suggests (Google's name, else the
 *  email's first part), at the server's 24 characters. */
export const suggestedName = (name?: string | null, email?: string | null): string =>
  String(name || String(email || '').split('@')[0] || '')
    .trim()
    .slice(0, 24);
