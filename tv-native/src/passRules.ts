// [auth-round] The password rules every Aurora client shows and the server
// enforces (src/lib/passrules.js; the website's public/js/passrules.js says
// the same). PURE - no imports, tested in specs.
export const MIN_PASSWORD = 4;
export const MAX_PASSWORD = 128;

/** The rule, in words, for the help line under a new-password field. */
export const PASSWORD_HELP = `At least ${MIN_PASSWORD} characters. Longer is stronger.`;

/** What stops a new password, in the shared words; null = it passes the rule. */
export function passwordProblem(pw: string): string | null {
  const s = String(pw || '');
  if (s.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (s.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  return null;
}

const COMMON = new Set([
  'password', 'passw0rd', '123456', '1234567', '12345678', '123456789', '1234567890', 'qwerty', 'qwertyuiop',
  'abc123', '111111', '000000', 'letmein', 'iloveyou', 'admin', 'welcome', 'monkey', 'dragon', 'football',
  'aurora', 'netflix', 'movies', 'cinema', '1234', '12345', 'pass', 'test', 'asdf', 'asdfgh', 'zxcvbn',
]);

export type Strength = {score: 0 | 1 | 2 | 3 | 4; label: 'Too short' | 'Weak' | 'Okay' | 'Good' | 'Strong'};
const LABELS: Strength['label'][] = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];

/** A hint, never a rule: length counts most, then variety; a common word or
 *  the person's own name / username is weak whatever its length. */
export function passwordStrength(pw: string, personal: Array<string | null | undefined> = []): Strength {
  const s = String(pw || '');
  if (s.length < MIN_PASSWORD) return {score: 0, label: LABELS[0]};
  const low = s.toLowerCase();
  const mine = personal.map(x => String(x || '').trim().toLowerCase()).filter(x => x.length >= 3);
  if (COMMON.has(low) || mine.some(x => low.includes(x)) || /^(.)\1+$/.test(s)) return {score: 1, label: LABELS[1]};
  let kinds = 0;
  if (/[a-z]/.test(s)) kinds++;
  if (/[A-Z]/.test(s)) kinds++;
  if (/[0-9]/.test(s)) kinds++;
  if (/[^A-Za-z0-9]/.test(s)) kinds++;
  let score = s.length >= 16 ? 4 : s.length >= 12 ? 3 : s.length >= 8 ? 2 : 1;
  if (kinds >= 3 && score < 4 && s.length >= 8) score++;
  if (kinds <= 1 && score > 1 && s.length < 16) score--;
  const sc = Math.max(1, Math.min(4, score)) as Strength['score'];
  return {score: sc, label: LABELS[sc]};
}

/** A 429's wait in the shared words ("Too many tries. Wait 15 minutes, then try again."). */
export function tooManyWords(retryAfterSec?: number | null): string {
  const m = Math.max(1, Math.ceil((Number(retryAfterSec) || 900) / 60));
  return `Too many tries. Wait ${m} minute${m === 1 ? '' : 's'}, then try again.`;
}
