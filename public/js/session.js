// Losing the sign-in while the app is open: an admin's kick, or "Sign out
// everywhere else" pressed on another device. One way out for both — say why, then reload: the
// boot path already knows where a tab without a sign-in belongs (the sign-in
// screen when the server requires one, the profile wall otherwise).
import { toast } from "./ui.js";
import { api } from "./api.js";
import { state } from "./state.js";

let leaving = false;
export const backToSignIn = (message, glyph = "🔒") => {
  if (leaving) return;
  leaving = true;
  toast(message, glyph);
  setTimeout(() => location.reload(), 1500);
};

// main.js sets this once the app is up. Before that, boot is the one
// deciding (its own login screen meets the same refusals).
let running = false;
export const appRunning = () => { running = true; };

// "Sign out everywhere else" was pressed for `profileId` on some device (the
// server tells this profile's other sockets). It ended every other session
// and every unlock token of the profile — but a tab may still be fine: the
// profile has no password, or the tab shares the asking browser's session.
// So ask the server, with what this tab holds, and leave only when refused.
let checkingOut = false;
export const onProfileSignedOut = async (profileId) => {
  if (!running || leaving || checkingOut) return;
  if (!state.profile || state.profile.id !== profileId) return;
  checkingOut = true;
  try {
    await api.profileState(profileId);
  } catch (e) {
    if (e && e.status === 401) backToSignIn("This profile was signed out from another device");
  } finally {
    checkingOut = false;
  }
};
