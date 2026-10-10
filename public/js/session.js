// Losing the sign-in while the app is open: an admin's kick, "Sign out
// everywhere else" pressed on another device, or the server starting to
// require sign-in. One way out for all of them — say why, then reload: the
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

// A request was refused with 401 { signedOut } (api.js raises
// "aurora-signed-out"): the admin signed this profile out everywhere — Kick,
// or "Reset password" — and this tab was still using the unlock it had. The
// socket's "kicked" usually gets here first (ws.js); this is the tab that had
// no socket at that moment.
export const onSignedOut = () => {
  if (!running || leaving) return;
  backToSignIn(`${state.adminName} signed this profile out — sign in again`);
};

// A request was refused with 401 { signinRequired } (api.js raises
// "aurora-signin-required"). Routes say that for more than one reason, and a
// burst of requests fails together, so /api/me decides, once: the server
// requires sign-in and this tab has none (the admin closed the wall, or the
// session was revoked or ran out) — or it is signed in as someone other than
// the profile it is showing.
let checkingWall = false;
export const onSigninRequired = async () => {
  if (!running || leaving || checkingWall) return;
  if (document.querySelector(".login-wrap")) return; // already being asked
  checkingWall = true;
  try {
    const me = await api.me();
    if (me.authMode !== "closed") return;
    if (!me.user) {
      state.authMode = "closed";
      state.user = null;
      backToSignIn("Aurora needs you to sign in again");
    } else if (state.profile && me.user.profileId !== state.profile.id) {
      backToSignIn("Aurora needs you to sign in again");
    }
  } catch {
    // no answer: nothing is known, nothing is done
  } finally {
    // one check per burst — the requests of a screen are refused together
    setTimeout(() => { checkingWall = false; }, 3000);
  }
};
