// The profile's own pages on the phone — asking for a profile ("Request
// access", from the sign-in card or the wall's "Add profile"), editing your
// profile (name, emoji, colour, email, password) and its photo. The rules and
// the words are the WEBSITE's (public/js/screens/login.js signupView,
// profiles.js profileModal, preferences.js "Your profile"); this file is pure
// so jest can hold them to it (__tests__/logic/phone-profiles.test.ts).

// profiles.js AVATARS / COLORS: the faces and colours a profile can pick
export const AVATARS = [
  '🍿', '🎬', '🦊', '🐼', '🚀', '🌵', '🦖', '👾', '🐳', '🌙', '⚡', '🔥',
  '🐱', '🐶', '🦉', '🐸', '🦄', '🐧', '🍕', '🍩', '☕', '🌈', '🎧', '🎮',
  '🏀', '⚽', '🌊', '🍁', '🎃', '❄️', '💜', '🛸', '🧠', '🕶️', '👑', '🧸',
];
export const COLORS = ['#e05f2c', '#8b7bff', '#2c9fe0', '#38b26c', '#d94f8a', '#e0b52c', '#7a5cd6', '#4ec3c9'];

// routes/profiles.js MIN_PASSWORD (and the site's MIN_PW)
export const MIN_PW = 4;
// the photo route's raw-body limit (express.raw "2mb")
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
// the field lengths the site's inputs allow
export const MAX = {name: 24, username: 24, email: 80, note: 200} as const;

/** profiles.js kidsLabel */
export const kidsLabel = (kids: {maxAge: number} | null | undefined) =>
  !kids ? '' : kids.maxAge === 0 ? 'all-ages titles only' : `titles up to ${kids.maxAge}+`;

/** What the site calls whoever runs the server until /api/server-info says (state.js). */
export const adminOr = (name: string | null | undefined) => (name && name.trim()) || 'the admin';

// ---------------- request access (login.js signupView) ----------------
export type RequestForm = {name: string; username: string; email: string; password: string; again: string; note: string};

export const REQUEST = {
  heading: 'Request access',
  sub: (admin: string) => `${admin} approves every request personally. Set it up now — the moment you're approved, you're in. `,
  subDim: "(Don't reuse a password you care about. This is a living room, not a bank.)",
  name: 'Your name',
  username: 'Pick a username',
  email: 'Email (optional — sign in with it too)',
  password: `Pick a password (${MIN_PW}+ characters)`,
  again: 'Repeat the password',
  note: 'A bribe, an explanation, or a fun fact',
  send: 'Send my request',
  cancel: 'Cancel',
  back: '← Back to sign in',
  failed: "That didn't work.",
  sentHeading: 'Request sent',
  // “who” is now on the pile… <strong>Want it faster? Go ask in person.</strong> Once…
  sentLead: (who: string, admin: string) => `“${who}” is now on the pile of things ${admin} has to deal with. `,
  sentStrong: 'Want it faster? Go ask in person.',
  sentTail: " Once you're approved, come right back here and sign in.",
  done: 'Done',
  backToSignIn: 'Back to sign in',
  firstTime: 'First time here? ',
  link: 'Request access',
  addProfile: 'Add profile',
} as const;

/** The site's checks before it sends (signupView send), in its order; null = send it. */
export function requestProblem(f: RequestForm): string | null {
  if (!f.name.trim()) return 'Your name, at least.';
  if (!f.username.trim() && !f.email.trim()) return 'Pick a username or an email to sign in with.';
  if (f.password !== f.again) return "The passwords don't match.";
  return null;
}

/** POST /api/auth/signup's body, as the site builds it (no Google on the phone). */
export const requestBody = (f: RequestForm) => ({
  name: f.name.trim(),
  username: f.username.trim(),
  email: f.email.trim(),
  password: f.password,
  note: f.note.trim(),
});

// ---------------- edit your profile (profiles.js profileModal, edit mode) ----------------
export const EDIT = {
  heading: 'Edit profile',
  name: 'Name',
  email: 'Email',
  emailPlaceholder: 'Email (optional)',
  emailHint: 'Optional — sign in with it instead of your username. Blank removes it.',
  avatar: 'Avatar',
  color: 'Color',
  kids: 'Kids',
  current: 'Current password',
  removePw: 'Remove password',
  save: 'Save',
  cancel: 'Cancel',
  saved: 'New password locked in',
  removed: 'Password removed — living dangerously',
  reenter: 'Password changed — please switch back into this profile',
  failed: "Couldn't save that profile.",
  emailFailed: "Couldn't save that email.",
  wrongPw: "That's not the current password.",
} as const;

export const passwordLabel = (hasPw: boolean) => (hasPw ? 'Password' : 'Password (optional)');
export const newPasswordPlaceholder = (hasPw: boolean) => (hasPw ? 'New password (blank = unchanged)' : 'Password (optional)');

/** The Settings row that opens the editor (preferences.js): a kids profile has no password to edit. */
export const editRow = (kids: boolean) =>
  kids
    ? {title: 'Edit profile', detail: 'Name, avatar and colour.'}
    : {title: 'Edit profile & password', detail: 'Name, avatar, colour, your password — and kids mode.'};

/** "Password protected" / "No password set" / the kids line under the face in Settings. */
export const profileLine = (p: {hasPassword?: boolean; kids?: {maxAge: number} | null} | null) =>
  !p ? '' : p.kids ? `Kids · ${kidsLabel(p.kids)}` : p.hasPassword ? 'Password protected' : 'No password set';

export type EditPlan = {
  /** what is wrong before anything is sent ('name' = the name is empty: focus it) */
  problem: 'name' | string | null;
  fields: {name: string; avatar: string; color: string};
  /** the email changed (sent to POST /api/profiles/:id/email) */
  email: string | null;
  /** a new password to set (never for a kids profile) */
  newPassword: string | null;
};

/** What one press of Save does, in the site's order: the profile, the email if it changed, the password if typed. */
export function editPlan(o: {
  name: string;
  avatar: string;
  color: string;
  email: string | null; // null = no email field (a kids profile)
  emailWas: string;
  newPassword: string;
  kids: boolean;
}): EditPlan {
  const name = o.name.trim();
  const email = o.email === null ? null : o.email.trim() !== o.emailWas ? o.email.trim() : null;
  const newPassword = !o.kids && o.newPassword ? o.newPassword : null;
  let problem: string | null = null;
  if (!name) problem = 'name';
  // the server's own words (routes/profiles.js password route), said before the round trip
  else if (newPassword && newPassword.length < MIN_PW) problem = `Passwords need at least ${MIN_PW} characters.`;
  return {problem, fields: {name: name.slice(0, MAX.name), avatar: o.avatar, color: o.color}, email, newPassword};
}

/** A refusal said in a sentence a person can act on — the server's own words, but
 *  "wrong password" is the site's "That's not the current password." */
export function refusal(message: string | null | undefined, fallback: string): string {
  const m = String(message || '').trim();
  if (!m || /^\d{3} \//.test(m)) return fallback; // no words from the server, only "401 /api/…"
  if (/^wrong password$/i.test(m)) return EDIT.wrongPw;
  const s = m.charAt(0).toUpperCase() + m.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

// ---------------- the photo (preferences.js pickPhoto) ----------------
export const PHOTO = {
  note: 'A picture of you in place of the emoji — JPEG, PNG or WebP, up to 2 MB.',
  remove: 'Remove photo',
  removeNote: 'Back to the emoji.',
  uploaded: 'Looking sharp',
  backToEmoji: 'Back to the emoji',
  removeFailed: "Couldn't remove it",
  failed: 'Upload failed',
  tooBig: '2MB max — pick a smaller image',
  noPicker: "This phone can't pick a photo here.",
} as const;
export const photoRow = (hasImage: boolean) => (hasImage ? 'Change photo' : 'Upload a photo');

/** The native upload resolves the server's JSON text; this reads the new avatar out of it
 *  (null when the answer says nothing readable — the profile is then simply read again). */
export function photoAnswer(text: string | null): {avatarImage: string | null} | null {
  if (text == null) return null;
  try {
    const j = JSON.parse(text) as {profile?: {avatarImage?: string | null}};
    if (j && j.profile && typeof j.profile === 'object' && 'avatarImage' in j.profile) return {avatarImage: j.profile.avatarImage ?? null};
  } catch {}
  return null;
}
