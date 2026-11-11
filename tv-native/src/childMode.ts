// CHILDREN MODE (2026-11-11, docs/children-mode.md) — the TV's and the phone
// app's shared half: the words (the website's, public/js/childmode.js), the
// ages, and the one place the app hears that the ACCOUNT went into or out of
// children mode — from this device (the sheet / screen), from another device
// (the socket's `child_mode`), or from an answer filtered differently
// (api.ts onAudienceChange). AppRoot listens and follows: the kids lock, the
// cached profile, everything held for the profile dropped, Home again, and a
// toast that says why.
//
// elia: "it cleans the feed and puts it in children mode and only after a
// passcode it returns to normal … it happens to the whole account". The
// server's age gate does the cleaning (src/lib/kids.js); the app only asks
// and paints.

export const AGES = [0, 7, 12, 16] as const;
export const ageWords = (a: number) => (a === 0 ? 'All ages' : `${a}+`);
export const keepsLine = (a: number) => (a === 0 ? 'Only titles rated for all ages.' : `Only titles rated ${a}+ and under.`);

// The same words on the website, the TV and the phone app.
export const WORDS = {
  title: 'Children mode',
  leave: 'Leave Children mode',
  intro: 'Cleans the feed for children on every device signed in to this account. Leaving it takes the passcode.',
  who: 'Who is watching?',
  pick: 'Pick who is watching.',
  turnOn: 'Turn on',
  cancel: 'Cancel',
  choose: 'Choose a passcode',
  codeHint: 'Passcode (4–6 digits)',
  once: 'Once more',
  chooseNote: 'You need it to leave Children mode. It is asked only this once — Aurora remembers it on this account.',
  enterToLeave: 'Enter the passcode to leave Children mode',
  enterToAllow: (a: number) => `Enter the passcode to allow ${ageWords(a)}`,
  allow: (a: number) => `Allow ${ageWords(a)}`,
  onFor: (a: number) => `On for this account — ${ageWords(a)}. ${keepsLine(a)}`,
  forgot: 'Forgot the passcode?',
  // the TV has no good way to type a password or to sign in with Google
  forgotTv: 'Use Aurora on your phone or the website: Leave Children mode → Forgot the passcode? Your account’s password turns it off there.',
  forgotNote: "Your account's own password turns Children mode off and clears the passcode. You choose a new one next time.",
  forgotNone: (admin: string) => `This account has no password to prove it is yours. Ask ${admin} to clear the passcode in the admin page.`,
  password: 'Your password',
  turnOff: 'Turn off',
  digits: 'The passcode is 4 to 6 digits.',
  mismatch: "Those two don't match.",
  // the Settings line, off and on
  rowOff: 'Cleans the feed for children on every device signed in to this account.',
  rowOn: (a: number) => `On for this account — ${ageWords(a)}. Leaving takes the passcode.`,
};

/** The toast every device shows when the account changes (the one that did it and the ones that followed). */
export const toastFor = (was: number | null, now: number | null, note = ''): [string, string] | null => {
  if (was === now) return null;
  if (now === null) return [`Children mode is off${note ? `. ${note}` : ''}`, '✅'];
  if (was === null) return [`Children mode is on — ${ageWords(now)}`, '🧸'];
  return [`Children mode — ${ageWords(now)}`, '🧸'];
};

export const validCode = (s: string) => /^\d{4,6}$/.test(s);

// ---------- the account changed ----------
// `kids` is the account's limit now ({maxAge} or null); `note` rides the toast.
export type ChildChange = {profileId: string; kids: {maxAge: number} | null; note?: string};
type Listener = (c: ChildChange) => void;
const listeners = new Set<Listener>();
export const onChildModeChanged = (fn: Listener) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const childModeChanged = (c: ChildChange) => {
  listeners.forEach(f => {
    try {
      f(c);
    } catch {}
  });
};
/** What a server answer (a profile) says the limit is. */
export const limitOf = (p: {kids?: {maxAge: number} | null; childMode?: {maxAge: number} | null} | null | undefined) => {
  const k = (p && (p.childMode || p.kids)) || null;
  return k && typeof k.maxAge === 'number' ? {maxAge: k.maxAge} : null;
};
/** The socket's `{type: "child_mode", profileId, childMode}` → a change, or null for another account. */
export const fromWord = (d: Record<string, unknown>, profileId: string | null): ChildChange | null => {
  if (!profileId || String(d.profileId || '') !== profileId) return null;
  const cm = d.childMode as {maxAge?: unknown} | null | undefined;
  return {profileId, kids: cm && typeof cm.maxAge === 'number' ? {maxAge: cm.maxAge} : null};
};
/** An answer's audience ("kids:7" / "all", api.ts) → the limit it says the account has. */
export const fromAudience = (said: string): {maxAge: number} | null => {
  const m = /^kids:(\d{1,2})$/.exec(said);
  return m ? {maxAge: Number(m[1])} : null;
};
