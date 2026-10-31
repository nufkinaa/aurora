// The password rule and the strength hint (auth-round, 2026-10-31). The rule
// is the server's (src/lib/passrules.js) and the apps say the same
// (tv-native/src/passRules.ts): at least 4 characters. The strength line is
// a hint only — length counts most, then variety; a common word or the
// person's own name is weak whatever its length. PURE (tested in Node).
export const MIN_PASSWORD = 4;
export const MAX_PASSWORD = 128;
export const PASSWORD_HELP = `At least ${MIN_PASSWORD} characters. Longer is stronger.`;

export const passwordProblem = (pw) => {
  const s = String(pw || "");
  if (s.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (s.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  return null;
};

const COMMON = new Set([
  "password", "passw0rd", "123456", "1234567", "12345678", "123456789", "1234567890", "qwerty", "qwertyuiop",
  "abc123", "111111", "000000", "letmein", "iloveyou", "admin", "welcome", "monkey", "dragon", "football",
  "aurora", "netflix", "movies", "cinema", "1234", "12345", "pass", "test", "asdf", "asdfgh", "zxcvbn",
]);
const LABELS = ["Too short", "Weak", "Okay", "Good", "Strong"];

export const passwordStrength = (pw, personal = []) => {
  const s = String(pw || "");
  if (s.length < MIN_PASSWORD) return { score: 0, label: LABELS[0] };
  const low = s.toLowerCase();
  const mine = personal.map((x) => String(x || "").trim().toLowerCase()).filter((x) => x.length >= 3);
  if (COMMON.has(low) || mine.some((x) => low.includes(x)) || /^(.)\1+$/.test(s)) return { score: 1, label: LABELS[1] };
  let kinds = 0;
  if (/[a-z]/.test(s)) kinds++;
  if (/[A-Z]/.test(s)) kinds++;
  if (/[0-9]/.test(s)) kinds++;
  if (/[^A-Za-z0-9]/.test(s)) kinds++;
  let score = s.length >= 16 ? 4 : s.length >= 12 ? 3 : s.length >= 8 ? 2 : 1;
  if (kinds >= 3 && score < 4 && s.length >= 8) score++;
  if (kinds <= 1 && score > 1 && s.length < 16) score--;
  const sc = Math.max(1, Math.min(4, score));
  return { score: sc, label: LABELS[sc] };
};

export const tooManyWords = (retryAfterSec) => {
  const m = Math.max(1, Math.ceil((Number(retryAfterSec) || 900) / 60));
  return `Too many tries. Wait ${m} minute${m === 1 ? "" : "s"}, then try again.`;
};
