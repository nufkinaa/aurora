// The forced reset's own checks (screens/NewPassword.tsx). PURE - no imports.
export const MIN_PASSWORD = 4; // the server's (src/routes/profiles.js)

/** What stops a save, in the site's words; null = good to go. Pure. */
export const newPasswordProblem = (o: {askCurrent: boolean; current: string; fresh: string; again: string}): string | null => {
  if (o.askCurrent && !o.current) return 'Your current password first.';
  if (o.fresh.length < MIN_PASSWORD) return `At least ${MIN_PASSWORD} characters.`;
  if (o.fresh !== o.again) return "They don't match.";
  return null;
};

/** What to say when the server refused the save (POST /api/profiles/:id/
 *  password): 401 = the current password is wrong; 400 carries a `code`
 *  ("same": that is the old password; "needed": one is required) and words
 *  written for the viewer; 429 = too many attempts. Pure. */
export const saveRefusal = (status: number, code: string | undefined, message: string): string => {
  if (status === 401) return 'That is not the current password.';
  if (code === 'same') return 'That is the old password — pick a different one.';
  if (status === 429) return 'Too many attempts — try again in a few minutes.';
  if (status === 0) return "Couldn't reach the server. Try again.";
  return message || "Couldn't save it. Try again.";
};
