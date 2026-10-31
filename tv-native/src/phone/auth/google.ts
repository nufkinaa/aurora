// [auth-round] Google on the phone app (docs/auth-round.md "Google on the phone app").
//
//   start:  a PKCE pair is made natively (PhoneModule.googlePkce: SecureRandom), the
//           verifier is KEPT ON THE PHONE first ({verifier, intent, startedAt}, so a cold
//           start can finish), then {server}/api/auth/google/app-start?intent&challenge
//           opens in a Custom Tab (PhoneModule.openAuthTab).
//   return: the tab ends at aurora-phone://auth/google?code=… (links.ts hands it to the
//           screen that is up: onAuthLink), and the code + the verifier are traded at
//           POST /api/auth/google/app-finish. The kept verifier is dropped then, used or
//           not, and anything older than 10 minutes is never used.
//   no browser that can open the tab: the code-on-screen way (googleStartFor + poll).
import AsyncStorage from '@react-native-async-storage/async-storage';
import {api, GoogleOutcome} from '../../api';
import {phoneNative} from '../native';
import {GoogleIntent, PENDING_TTL_MS, readPending, W} from './rules';

const KEY = 'aurora.phone.googlePending';

/** Opens Google in a Custom Tab. 'opened' = the tab is up (the answer comes back as a
 *  link); 'noBrowser' = nothing here can open it (use the code-on-screen way). */
export async function openGoogleTab(intent: GoogleIntent): Promise<'opened' | 'noBrowser'> {
  const {verifier, challenge} = await phoneNative.googlePkce();
  await AsyncStorage.setItem(KEY, JSON.stringify({verifier, intent, startedAt: Date.now()}));
  const ok = await phoneNative.openAuthTab(api.googleAppStartUrl(intent, challenge));
  if (!ok) {
    await AsyncStorage.removeItem(KEY).catch(() => {});
    return 'noBrowser';
  }
  return 'opened';
}

/** The intent of the hand-off this phone is waiting for (null: none, or too old). */
export async function pendingIntent(): Promise<GoogleIntent | null> {
  try {
    return readPending(await AsyncStorage.getItem(KEY), Date.now())?.intent || null;
  } catch {
    return null;
  }
}

export class GoogleProblem extends Error {}

/** Trades the tab's code for what Google said (the login shape, a sign-up, or a reset).
 *  Throws GoogleProblem (no kept verifier: too old, or never started here) or the
 *  server's refusal (410 used / expired, 400 a verifier that does not match). */
export async function finishGoogleTab(code: string): Promise<{intent: GoogleIntent; outcome: GoogleOutcome}> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch {}
  await AsyncStorage.removeItem(KEY).catch(() => {});
  const p = readPending(raw, Date.now());
  if (!p) throw new GoogleProblem(W.errGoogleStale);
  const outcome = await api.googleAppFinish(code, p.verifier);
  return {intent: p.intent, outcome};
}

/** Forgets a hand-off this phone was waiting for (Back, Cancel, an error from the tab). */
export const dropPending = () => AsyncStorage.removeItem(KEY).catch(() => {});

export {PENDING_TTL_MS};
