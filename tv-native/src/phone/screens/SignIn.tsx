// Sign in on the phone — the closed-mode stage (AppRoot's "login"): every way in, on one
// glass panel (phone/auth/AuthDoor.tsx — Sign in · Request access, Continue with Google,
// Forgot password?, a code approved on another device). Nowhere else to go from here:
// the server requires a sign-in.
import React from 'react';
import AuthDoor, {SignedIn} from '../auth/AuthDoor';

export default function SignIn({onSignedIn, notice}: {onSignedIn: SignedIn; notice: string}) {
  return <AuthDoor onSignedIn={onSignedIn} notice={notice} />;
}
