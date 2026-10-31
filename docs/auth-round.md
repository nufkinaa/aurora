# Sign-in round (auth-round, 2026-10-31)

elia's four asks, in his words:

1. "There is not sign in with google on the apk phone, we have to have it also!!!!"
2. "you can sign up without putting in a password if you sign in with google that's not good at all."
3. "improve how the sign in and sign up pages look and work (make it look less ai and more like it follows our brand feel ... make sure we are doing every common practice"
4. "a lot of users forget their password so let's make it easy and clear to reset it by themselves."

This file is the contract every client was built against (server API, the words, the look)
and, at the end, the list of practices with the status of each.

---

## 1. Server contract

All routes live under `/api/auth/` (open through the closed-mode wall) unless said otherwise.
Every error body is `{ error: "<a sentence for the viewer>" }`, plus where it helps:

- `field`: which input the error belongs to (`identifier`, `password`, `newPassword`,
  `confirm`, `name`, `username`, `email`, `code`), so a client can put it next to that field;
- `code`: a machine word (`short`, `mismatch`, `same`, `wrong`, `expired`, `used`, `limited`, `taken`);
- `retryAfter`: seconds, on every 429 (also sent as the `Retry-After` header).

Clients say what they are with the header **`X-Aurora-App: tv | phone`** (the website sends none).
The server keeps it on the session (`kind`: `web`, `phone`, `tv`; an app that sends nothing is `tv`).

### Password rules (`src/lib/passrules.js`, `public/js/passrules.js`, `tv-native/src/passRules.ts`)

- At least **4** characters (the household's existing rule), at most 128.
- A strength hint (client side only, never a rule): `0..4` → "Too short", "Weak", "Okay", "Good", "Strong".
- Every NEW password (sign-up, Google sign-up, reset, set, change) goes through the same check on the server.

### Sign-in answers

Every answer that signs a device in has the login shape:

```
{ ok, user, profile, profileToken, session, mustReset, passwordSetup? }
```

- `mustReset: true` + `passwordSetup: true` = the profile signs in with Google only and has
  no password yet: the client shows **Set a password** (wording below), then saves it with
  `POST /api/auth/password { newPassword }` (no current password exists) and carries on with the
  fresh credentials in the answer (`token`, `session`, `user`), exactly as for a forced reset.
  Until then every credential of that profile is a restricted one (lib/resetgate.js), so no
  client, old or new, can skip it.
- `/api/me` → `{ user: null, passwordResetRequired: true, passwordSetup?: true, resetProfile }`.

### Google sign-up needs a password (ask #2)

`POST /api/auth/signup { name, username?, email?, password, note?, pollId? }`
- `password` is REQUIRED for every request, Google or not (400 `{field:"password", code:"short"}`).
- With `pollId` (a verified Google identity) the email defaults to the Google email.

### Google on the phone app (ask #1)

The app never sees Google's code or tokens and carries no Google SDK. It reuses the website's
OAuth client and its registered redirect URI (`https://<host>/api/auth/google/web-callback`):
**no Google console change**.

1. The app makes a `verifier` (32 random bytes, base64url) and `challenge = base64url(sha256(verifier))`,
   and keeps `{ verifier, intent, startedAt }` in storage (so a cold start can finish).
2. It opens a Chrome Custom Tab at
   `GET {base}/api/auth/google/app-start?intent=signin|signup|reset&challenge=<challenge>`.
   The server remembers the challenge with a fresh `state` and redirects to Google.
3. Google returns to `/web-callback`. The server verifies the person, then makes a one-time
   **hand-off code** (32 random bytes; only its sha256 is kept; 3 minutes; single use;
   bound to the challenge) and redirects the tab to
   `aurora-phone://auth/google?code=<code>` (or `aurora-phone://auth/google?error=<words>`).
4. The app posts `POST /api/auth/google/app-finish { code, verifier }`.
   - sha256(verifier) must equal the challenge, so a code another app intercepted is useless;
   - the code is burnt on the first try, right or wrong; expired = 410 `{code:"expired"}`, used = 410 `{code:"used"}`.
   - Answer, by what Google said: the login shape (a linked profile), or
     `{ ok, signup: { email, name }, pollId }` (unknown Google account: continue to the request
     form, which now asks for a password), or `{ ok, reset: { token, name } }` (intent `reset`).
5. Fallback (no browser that can open the tab, or a server reached by IP address): the TV's
   device-code flow, `POST /api/auth/google/start { intent }` + `POST /api/auth/google/poll { pollId }`.

`/api/server-info` adds `googleApp: true` when the phone flow can run (the web client is configured).

### Password reset (ask #4)

`GET /api/auth/reset/options` → `{ google, email, admin: true, adminName, codeLength }`.
The same answer for everyone: nothing about any account.

| way | how | routes |
| --- | --- | --- |
| **Google** | Verify with Google; a profile linked to that Google account gets a reset token. | web: `web-start?intent=reset` → `web-finish` → `{reset:{token,name}}`; TV: `google/start {intent:"reset"}` + `poll`; phone: `app-start?intent=reset` + `app-finish` |
| **Signed-in device** | Settings → Change password without the old one, on a phone app or browser session signed in within the last 30 days (never a TV session, never a kids profile). | `GET /api/auth/password/options` → `{ needsCurrent, why? }`; `POST /api/auth/password { newPassword, signOutOthers }` |
| **Ask the admin** | The person asks; the admin approves in People; the waiting screen continues by itself, and the admin also gets a one-time code to read out. | `POST /api/auth/reset/request { identifier, note? }` → `{ ok, ticket, expiresIn }` (always the same answer); `POST /api/auth/reset/status { ticket }` → `{ status: pending\|approved\|declined\|expired, token?, name? }` |
| **Reset code** | A code from the admin (8 characters, 30 minutes, single use). | `POST /api/auth/reset/code { identifier, code }` → `{ ok, token, name }` |
| **Email** (off) | A link `{publicUrl}/#/reset/<token>` by email, 30 minutes. Built, switched off; see section 5. | `POST /api/auth/reset/email { identifier }` → `{ ok }` always (501 when off) |

Then, for every way:

- `POST /api/auth/reset/check { token }` → `{ ok, name, avatar, color }` or 410 (for a link that is opened).
- `POST /api/auth/reset/complete { token, newPassword, signOutOthers = true }` → the login shape
  plus `{ signedOutOthers: n }`. The token is single use (sha256 stored, 15 minutes for Google and
  approvals, 30 for code and email). Signing out every other device is the default; the person
  can untick it.

Admin (X-Admin-Password, unchanged): `GET /api/admin/people` adds `resetRequests` and each
person's `authLog`; `POST /api/admin/reset-requests/:id/approve` → `{ ok, code, expiresAt }`;
`POST /api/admin/reset-requests/:id/decline`; `POST /api/admin/profiles/:id/reset-code` → `{ ok, code, expiresAt }`.
The admin's own password and lock-out are not touched.

Security, for all of it: rate limits per address and per account (`429` with `retryAfter`);
tokens, codes and tickets are random, short-lived, single use and stored as sha256 only;
no answer says whether an account exists; every event lands in the auth log
(`data/auth-log.json`, shown per person in People) without any secret in it.

---

## 2. The words (all three clients use these)

Plain, warm, short. No emoji, no jokes in the way of getting in.

| where | text |
| --- | --- |
| switch | **Sign in** · **Request access** |
| sign in, title | Sign in |
| sign in, line | Use your Aurora username or email. |
| labels | Username or email · Password · Forgot password? |
| button | Sign in (busy: Signing in…) |
| Google | Continue with Google (sign in) · Sign up with Google (request access) |
| request, title | Request access |
| request, line | {admin} approves new people. Once you're approved, sign in with the details you set here. |
| request, labels | Your name · Username · Email (optional) · Password · Confirm password · Note for {admin} (optional) |
| help under username | Letters and numbers. You'll sign in with it. |
| help under password | At least 4 characters. Longer is stronger. |
| request, button | Send request |
| sent | Request sent · {admin} will look at it soon. Once you're approved, sign in with your username and password. |
| Google sign-up | Finish your request · Google: {email} · Set a password as well, so you can sign in on devices without Google. |
| set a password (Google-only profile) | Set a password · Your profile signs in with Google only. Add a password so you can sign in anywhere. · Save password |
| forced reset | Choose a new password · {admin} asked for a new password on this profile. |
| forgot | Reset your password · Pick how you want to confirm it's you. |
| forgot, Google | Use Google · For profiles linked to a Google account. |
| forgot, admin | Ask {admin} · {admin} approves it, then you choose a new password here. |
| forgot, code | I have a reset code |
| forgot, email | Email me a link (only when switched on) |
| forgot, signed in elsewhere | Still signed in on your phone or computer? Change it in Settings there. |
| ask admin, sent | Request sent · Keep this screen open. When {admin} approves, you can choose a new password here. You can also ask {admin} for a reset code. |
| new password | New password · Confirm password · Sign out of all other devices · Save and sign in |
| strength | Too short · Weak · Okay · Good · Strong |
| errors | Enter your username or email. · Enter your password. · That username and password don't match. Check them, or reset your password. · The passwords don't match. · Use at least 4 characters. · Too many tries. Wait {n} minutes, then try again. · Can't reach Aurora. Check your connection and try again. · Caps Lock is on. |

---

## 3. The look

- The night sky with the real aurora painter stays the ground (it is Aurora's, not a generic
  blob), calmer and lower. One glass panel carries the form; corners at the app's own radius,
  not pill-round. The Beam mark with the "Aurora" wordmark heads the panel, small and still.
- Visible labels above every field (placeholders only as examples), help text under the field,
  errors in place of the help text, in the error colour with an icon-free sentence.
- One primary button in the mint→violet accent; Google's button in Google's dark style
  (`#131314` fill, `#8E918F` 1 px stroke, `#E3E3E3` text, the four-colour G, "Continue with Google").
- Left-aligned text, short lines, no centred paragraphs of copy.

---

## 4. Practices checklist

(Filled in at the end of the round: done / not applicable / decision for elia, per client.)

## 5. Email reset: what elia would need to provide

(Filled in at the end of the round.)
