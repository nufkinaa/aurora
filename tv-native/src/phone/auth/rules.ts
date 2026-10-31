// The phone's sign-in, request-access, Google and password-reset screens: their
// words (docs/auth-round.md section 2, the same on the website and the TV) and
// every decision they make. PURE - no React Native, no api calls - so jest holds
// them to the contract (__tests__/logic/phone-auth.test.ts).
import {MIN_PASSWORD, passwordProblem, tooManyWords} from '../../passRules';

export type GoogleIntent = 'signin' | 'signup' | 'reset';

/** "the admin" → "The admin" at the start of a sentence; a name stays as it is. */
export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** Whoever runs the server, until /api/server-info says (the website's "the admin"). */
export const adminName = (name: string | null | undefined) => (name && name.trim()) || 'the admin';

export const W = {
  // the switch at the top of the panel
  tabSignIn: 'Sign in',
  tabRequest: 'Request access',
  // sign in
  signInTitle: 'Sign in',
  signInLine: 'Use your Aurora username or email.',
  identifier: 'Username or email',
  password: 'Password',
  forgot: 'Forgot password?',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  google: 'Continue with Google',
  googleSignUp: 'Sign up with Google',
  or: 'or',
  useCode: 'Sign in with a code instead',
  // request access
  requestTitle: 'Request access',
  requestLine: (admin: string) => `${cap(admin)} approves new people. Once you're approved, sign in with the details you set here.`,
  name: 'Your name',
  username: 'Username',
  usernameOptional: 'Username (optional)',
  usernameHelp: "Letters and numbers. You'll sign in with it.",
  usernameHelpGoogle: 'You can always sign in with Google or your email.',
  email: 'Email (optional)',
  emailHelp: 'You can sign in with it too.',
  confirm: 'Confirm password',
  note: (admin: string) => `Note for ${admin} (optional)`,
  send: 'Send request',
  sending: 'Sending…',
  sentTitle: 'Request sent',
  sentLine: (admin: string) => `${cap(admin)} will look at it soon. Once you're approved, sign in with your username and password.`,
  backToSignIn: 'Back to sign in',
  backToProfiles: 'Back to profiles',
  done: 'Done',
  cancel: 'Cancel',
  // Google sign-up
  googleSignupTitle: 'Finish your request',
  googleAs: (email: string) => `Google: ${email}`,
  googleSignupLine: 'Set a password as well, so you can sign in on devices without Google.',
  // a Google-only profile with no password yet
  setTitle: 'Set a password',
  setLine: 'Your profile signs in with Google only. Add a password so you can sign in anywhere.',
  setSave: 'Save password',
  // the forced reset
  forcedTitle: 'Choose a new password',
  forcedLine: (admin: string) => `${cap(admin)} asked for a new password on this profile.`,
  currentPassword: 'Current password',
  saveContinue: 'Save and continue',
  signOut: 'Sign out',
  // forgot
  forgotTitle: 'Reset your password',
  forgotLine: "Pick how you want to confirm it's you.",
  wayGoogle: 'Use Google',
  wayGoogleLine: 'For profiles linked to a Google account.',
  wayAdmin: (admin: string) => `Ask ${admin}`,
  wayAdminLine: (admin: string) => `${cap(admin)} approves it, then you choose a new password here.`,
  wayCode: 'I have a reset code',
  wayCodeLine: (admin: string) => `A code ${admin} gave you.`,
  wayEmail: 'Email me a link',
  wayEmailLine: 'A link to choose a new password, to the email on your profile.',
  elsewhere: 'Still signed in on your phone or computer? Change it in Settings there.',
  // ask the admin
  askTitle: (admin: string) => `Ask ${admin}`,
  askLine: (admin: string) => `Say which profile it's for. ${cap(admin)} sees your request and can approve it.`,
  askSentTitle: 'Request sent',
  askSentLine: (admin: string) =>
    `Keep this screen open. When ${admin} approves, you can choose a new password here. You can also ask ${admin} for a reset code.`,
  askWaiting: 'Waiting for approval…',
  askDeclined: (admin: string) => `${cap(admin)} said no to this request. Ask them in person, or try another way.`,
  askExpired: 'This request ran out of time. Ask again, or try another way.',
  haveCode: 'I have a reset code',
  // the reset code
  codeTitle: 'Enter your reset code',
  codeLine: (admin: string, n: number) => `${cap(admin)} can give you a code of ${n} characters. It works for 30 minutes, once.`,
  code: 'Reset code',
  continue: 'Continue',
  // email
  emailTitle: 'Email me a link',
  emailLine: 'If your profile has an email address, a link to choose a new password goes there. It works for 30 minutes.',
  sendLink: 'Send link',
  emailSentTitle: 'Check your email',
  emailSentLine: 'If that profile has an email address, a link is on its way. Open it on this phone or any other device.',
  // the new password (every way ends here)
  newTitle: 'Choose a new password',
  newLine: (name: string) => (name ? `For ${name}.` : 'For your profile.'),
  newPassword: 'New password',
  signOutOthers: 'Sign out of all other devices',
  signOutOthersHelp: 'Recommended if you think someone else knows your old password.',
  saveAndSignIn: 'Save and sign in',
  saving: 'Saving…',
  // Google, the code-on-screen way (no browser here, or a server reached by its address)
  deviceTitle: 'Continue with Google',
  deviceLine: (url: string) => `On a phone or computer, open ${url} and enter this code.`,
  deviceWaiting: 'This screen carries on by itself once you confirm.',
  googleOpening: 'Opening Google…',
  googleFinishing: 'Finishing with Google…',
  back: 'Back',
  // errors (the contract's words first)
  errIdentifier: 'Enter your username or email.',
  errPassword: 'Enter your password.',
  errWrong: "That username and password don't match. Check them, or reset your password.",
  errMismatch: "The passwords don't match.",
  errShort: `Use at least ${MIN_PASSWORD} characters.`,
  errOffline: "Can't reach Aurora. Check your connection and try again.",
  errName: 'Enter your name.',
  errHow: 'Pick a username, or add an email to sign in with.',
  errEmail: 'Check the email address.',
  errCode: 'Enter the reset code.',
  errCurrent: 'Enter your current password.',
  errGoogleLate: 'That Google sign-in took too long. Try again.',
  errGoogleUsed: 'That Google sign-in was already used. Try again.',
  errGoogleStale: 'That Google sign-in is no longer open on this phone. Try again.',
  errGoogleNone: "Google sign-in can't open on this phone.",
  errGoogleOff: "Google sign-in isn't set up on this server.",
  errSame: 'That is your current password. Choose a different one.',
  errResetGone: 'This reset has run out of time. Start again.',
  errResetLinkGone: 'This reset link has expired or was already used. Ask for a new one.',
  checkingLink: 'Checking the link…',
  failed: "That didn't work. Try again.",
} as const;

// ---------------- the fields and what is wrong with them ----------------

export type Field = 'identifier' | 'password' | 'newPassword' | 'confirm' | 'name' | 'username' | 'email' | 'code' | 'current' | 'note';
/** What a form shows: an error next to a field, or one for the whole form (`field` absent). */
export type Problem = {field?: Field; text: string};
export type Problems = Partial<Record<Field | 'form', string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sign in: both fields, in the contract's words. */
export function signInProblems(identifier: string, password: string): Problems {
  const p: Problems = {};
  if (!identifier.trim()) p.identifier = W.errIdentifier;
  if (!password) p.password = W.errPassword;
  return p;
}

export type RequestFields = {name: string; username: string; email: string; password: string; confirm: string; note: string};

/** Request access, every field at once (a Google identity makes the username optional;
 *  a password is ALWAYS asked for: elia's ask #2). */
export function requestProblems(f: RequestFields, google = false): Problems {
  const p: Problems = {};
  if (!f.name.trim()) p.name = W.errName;
  if (!google && !f.username.trim() && !f.email.trim()) p.username = W.errHow;
  if (f.email.trim() && !EMAIL.test(f.email.trim())) p.email = W.errEmail;
  const pw = passwordProblem(f.password);
  if (pw) p.password = pw;
  else if (f.password !== f.confirm) p.confirm = W.errMismatch;
  return p;
}

/** POST /api/auth/signup's body: a password always, the Google proof when there is one. */
export function requestBody(f: RequestFields, pollId?: string | null) {
  return {
    name: f.name.trim(),
    username: f.username.trim(),
    email: f.email.trim(),
    password: f.password,
    note: f.note.trim(),
    ...(pollId ? {pollId} : {}),
  };
}

/** A new password (reset, set, change, forced): the rule, then the two must match. */
export function newPasswordProblems(o: {fresh: string; confirm: string; current?: string | null; askCurrent?: boolean}): Problems {
  const p: Problems = {};
  if (o.askCurrent && !o.current) p.current = W.errCurrent;
  const pw = passwordProblem(o.fresh);
  if (pw) p.newPassword = pw;
  else if (o.fresh !== o.confirm) p.confirm = W.errMismatch;
  return p;
}

export const hasProblems = (p: Problems) => Object.values(p).some(Boolean);
/** The first field with a problem, in the form's order (where the focus goes). */
export const firstProblem = (p: Problems, order: Field[]): Field | null => order.find(f => !!p[f]) || null;

// ---------------- the server's refusals ----------------

/** What an ApiError looks like to these screens (api.ts's, structurally). */
export type Refusal = {status?: number; message?: string; field?: string; code?: string; retryAfter?: number};
const SERVER_FIELDS: Record<string, Field> = {
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
};

/** A refusal → where to say it and the words. The server's sentence when it wrote one
 *  for people; the contract's words for a 429 (with the wait), no connection and a
 *  wrong sign-in. `fieldMap` moves a server field onto this form's own (a reset
 *  form calls its password "newPassword"). */
export function refusalProblem(e: unknown, opts: {wrongField?: Field; fieldMap?: Partial<Record<Field, Field>>} = {}): Problem {
  const r = (e && typeof e === 'object' ? e : {}) as Refusal;
  const status = typeof r.status === 'number' ? r.status : -1;
  if (status === 429) return {text: tooManyWords(r.retryAfter)};
  if (status === 0 || (status === -1 && /network|fetch|reach/i.test(String(r.message || '')))) return {text: W.errOffline};
  const msg = readable(r.message);
  let field = r.field && SERVER_FIELDS[r.field] ? SERVER_FIELDS[r.field] : undefined;
  if (field && opts.fieldMap && opts.fieldMap[field]) field = opts.fieldMap[field];
  if (r.code === 'same') return {field: field || 'newPassword', text: W.errSame};
  if (r.code === 'mismatch') return {field: field || 'confirm', text: W.errMismatch};
  if (r.code === 'short') return {field: field || 'password', text: msg || W.errShort};
  if (status === 401 && opts.wrongField) return {field: opts.wrongField, text: msg || W.errWrong};
  return {field, text: msg || W.failed};
}

/** The server's words, when they are words (not "401 /api/…"), as a sentence. */
export function readable(m: string | null | undefined): string {
  const s = String(m || '').trim();
  if (!s || /^\d{3} \//.test(s) || /^(Cannot reach server|No server configured)$/i.test(s)) return '';
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** The refusal of a Google hand-off (POST app-finish): expired / used have their own words. */
export function googleRefusal(e: unknown): string {
  const r = (e && typeof e === 'object' ? e : {}) as Refusal;
  if (r.status === 410 && r.code === 'used') return W.errGoogleUsed;
  if (r.status === 410) return W.errGoogleLate;
  return refusalProblem(e).text;
}

// ---------------- Google: which way, the hand-off kept across a cold start ----------------

export type GoogleInfo = {googleApp?: boolean; googleDevice?: boolean} | null | undefined;
/** 'tab' = a Custom Tab (the server says the web flow can return to the address this phone
 *  uses: a real domain, or the test mock); 'device' = a code on this screen, confirmed on
 *  another device (the TV's way); null = no Google button at all. The server decides: a
 *  bare IP or localhost answers googleApp:false. */
export function googleWay(info: GoogleInfo): 'tab' | 'device' | null {
  if (!info) return null;
  if (info.googleApp) return 'tab';
  if (info.googleDevice) return 'device';
  return null;
}

export const PENDING_TTL_MS = 10 * 60 * 1000;
export type GooglePending = {verifier: string; intent: GoogleIntent; startedAt: number};
/** RFC 7636: 43 characters of base64url for 32 random bytes. */
export const isVerifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(v);
const INTENTS: GoogleIntent[] = ['signin', 'signup', 'reset'];

/** What was kept before the tab opened → usable (whole, and under 10 minutes old) or null. */
export function readPending(raw: string | null | undefined, now: number): GooglePending | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<GooglePending>;
    if (!p || !isVerifier(p.verifier) || !INTENTS.includes(p.intent as GoogleIntent)) return null;
    const at = Number(p.startedAt);
    if (!Number.isFinite(at) || at > now + 60_000 || now - at > PENDING_TTL_MS) return null;
    return {verifier: p.verifier, intent: p.intent as GoogleIntent, startedAt: at};
  } catch {
    return null;
  }
}

export type GoogleOutcomeLike = {
  pending?: boolean;
  profile?: {id?: string} | null;
  profileToken?: string;
  session?: string;
  signup?: {email?: string | null; name?: string | null} | null;
  pollId?: string;
  reset?: {token?: string; name?: string} | null;
};
/** What a finished Google step means for the screens. */
export type GoogleStep =
  | {kind: 'pending'}
  | {kind: 'signedIn'}
  | {kind: 'signup'; email: string; name: string; pollId: string}
  | {kind: 'reset'; token: string; name: string}
  | {kind: 'unknown'};
export function googleStep(o: GoogleOutcomeLike | null | undefined): GoogleStep {
  if (!o) return {kind: 'unknown'};
  if (o.pending) return {kind: 'pending'};
  if (o.reset && o.reset.token) return {kind: 'reset', token: o.reset.token, name: String(o.reset.name || '')};
  if (o.signup && o.pollId) return {kind: 'signup', email: String(o.signup.email || ''), name: String(o.signup.name || ''), pollId: o.pollId};
  if (o.profile?.id && o.profileToken && o.session) return {kind: 'signedIn'};
  return {kind: 'unknown'};
}

// ---------------- password reset ----------------

export type ResetWays = {google: boolean; admin: boolean; code: boolean; email: boolean};
/** Which ways the "Reset your password" screen offers (Google only where it can run here). */
export function resetWays(opts: {google?: boolean; email?: boolean; admin?: boolean} | null | undefined, googleRuns: boolean): ResetWays {
  return {google: !!opts?.google && googleRuns, admin: opts ? opts.admin !== false : true, code: true, email: !!opts?.email};
}

/** The ask-the-admin wait, one status answer at a time. */
export type AskStep = {kind: 'wait'} | {kind: 'approved'; token: string; name: string} | {kind: 'declined'} | {kind: 'expired'};
export function askStep(s: {status?: string; token?: string; name?: string} | null | undefined): AskStep {
  switch (s?.status) {
    case 'approved':
      return s.token ? {kind: 'approved', token: s.token, name: String(s.name || '')} : {kind: 'wait'};
    case 'declined':
      return {kind: 'declined'};
    case 'expired':
    case 'used':
      return {kind: 'expired'};
    default:
      return {kind: 'wait'};
  }
}
export const ASK_POLL_MS = 4000;

/** A reset code as typed: capitals, letters and digits only (spaces and dashes dropped). */
export const typedResetCode = (raw: string, max = 12) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, max);
