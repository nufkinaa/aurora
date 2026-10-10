// The forced reset's own checks (screens/NewPassword.tsx). PURE - no imports.
export const MIN_PASSWORD = 4; // the server's (src/routes/profiles.js)

/** What stops a save, in the site's words; null = good to go. Pure. */
export const newPasswordProblem = (o: {askCurrent: boolean; current: string; fresh: string; again: string}): string | null => {
  if (o.askCurrent && !o.current) return 'Your current password first.';
  if (o.fresh.length < MIN_PASSWORD) return `At least ${MIN_PASSWORD} characters.`;
  if (o.fresh !== o.again) return "They don't match.";
  return null;
};
