// [auth-round] What the sign-in screens tell the "set a password" screen before it can ask
// the server: this profile signs in with Google only and has no password yet
// (the login shape's passwordSetup). NewPassword.tsx also reads /api/me's passwordSetup,
// so a relaunch (nothing in memory) says the same.
let setupFor: string | null = null;
export const markPasswordSetup = (profileId: string | null) => {
  setupFor = profileId;
};
export const isPasswordSetup = (profileId: string) => setupFor === profileId;
