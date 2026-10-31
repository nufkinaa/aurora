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
| **Signed-in device** | Settings → Change password without the old one, on a phone app or browser session the person signed in on within the last 30 days (not a TV, not a TV pairing, never a kids profile) — or on any device, the TV included, within 10 minutes of typing the password or verifying with Google there. Every other device is signed out. | `GET /api/auth/password/options` → `{ needsCurrent, why? }`; `POST /api/auth/password { newPassword, signOutOthers }` |
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

Web: checked in real Chrome (playwright-core, channel "chrome") on a private instance in closed mode
with the Google stand-in, at 320, 360, 390, 430 wide, a 740x360 landscape phone, 1280, 1920 and
200 % zoom (640x360 CSS px), plus `test/ui/signin-round.test.js`. Screenshots in
`docs/qa/auth-round/after/web-*.png`. Phone and TV: see the helpers' reports.

| practice | web | phone | TV | how it was checked (web) |
| --- | --- | --- | --- | --- |
| `autocomplete` on every field (`username`, `current-password`, `new-password`, `email`, `name`, `one-time-code`) | done | see helper report | see helper report | every input's attributes read from the page on each screen; the test asserts the sign-in pair |
| a username next to every new password, for the password manager | done | see helper report | see helper report | request access has the Username field; reset / set-password / forced reset carry a hidden `autocomplete="username"` field, now filled with what the person typed to get there (username or email), the profile's name only when nothing better is known |
| Show / Hide on passwords | done | see helper report | see helper report | clicked; the accessible name is "Show password" / "Hide password" so it contains the visible word (no `aria-pressed` on top, it read backwards) |
| the rule shown before typing, plus a strength hint | done | see helper report | see helper report | "At least 4 characters. Longer is stronger." under the field from the start; the strength line is read with the field (`aria-describedby`), not announced per key |
| Caps Lock warning | done | see helper report | see helper report | Caps Lock pressed in the test; the line is a polite live region, so it is also heard once |
| errors next to the field, specific, `aria-invalid` + `aria-describedby`, announced | done | see helper report | see helper report | empty, short, mismatch and a wrong reset code; Chrome's accessibility tree read over CDP: the code field is `invalid`, its description is the error, focus stays on it; the line is a polite live region (going back to the help text is silent) |
| fields never cleared on error | done (sign-in screens); the profile wall's unlock sheet still clears a wrong password on purpose (its own test says so) | see helper report | see helper report | wrong password and rate limit: both fields keep what was typed |
| Enter submits / moves to the next field | done | see helper report | see helper report | Enter in username goes to password, in password sends; the request form walks field to field and sends from the last |
| right keyboard on phones (`type`, `inputmode`, `enterkeyhint`, `autocapitalize`, no autocorrect) | done | see helper report | see helper report | attributes read per field: email `type=email inputmode=email`, name `autocapitalize=words`, code `characters`, usernames `none`, `enterkeyhint` next / go / send |
| paste allowed | done | see helper report | see helper report | a synthetic paste into the password is not prevented; nothing listens for paste |
| busy state, button held, no double submit | done | see helper report | see helper report | login slowed by 800 ms: button disabled, "Signing in…", `aria-busy`; Enter twice + a click sent ONE request |
| clear sign in / request access switch (tablist, keyboard) | done | see helper report | see helper report | `role=tablist/tab/tabpanel`, `aria-selected`, `aria-controls`, roving `tabindex`; Left / Right / Home / End switch and keep the keyboard on the tab (mirrored in RTL); a click puts it in the first field |
| "Continue with Google" per Google's branding guidelines | partly | see helper report | see helper report | dark theme `#131314` / `#8E918F` 1 px / `#E3E3E3`, the standard four-colour G unchanged, 14/20 text, 12 px + 10 px + 12 px spacing, approved wording. Not exact: the guidelines' face is Google Sans Medium, which is not shipped (falls back to Roboto / the system face), and the corners follow the panel's 10 px radius rather than Google's stock rectangle or pill |
| labels, headings, landmarks | done | see helper report | see helper report | a visible `<label for>` on every field; one `h1` per step (on the two tabbed doors it is read, not drawn, because the switch already says it); the panel is `<main>` and everything behind it is now `inert`, so there is one reachable landmark |
| focus order and a visible focus ring | done | see helper report | see helper report | Tab walk: username, password, Show, Forgot password?, Sign in, Google, Get the apps, then back round (no longer into the app behind); 2 px mint ring on every control, mint glow on fields (`web-desktop-focus-ring.png`); the first field has the keyboard when the screen opens (it used to be the Sign in tab) |
| hover does not steal the focus | done | not applicable | not applicable | the app's hover-to-focus (for TV pointer remotes) used to move the focus to "Show" or a link under a resting mouse while typing; now kept out of the sign-in screens |
| WCAG AA contrast | done | see helper report | see helper report | measured against the panel over the sky, nominal / bright aurora band (99th percentile) / brightest pixel: label 13.5 / 12.6 / 11.3, help and lede 8.7 / 8.1 / 7.3, error 9.6 / 8.9 / 8.0, link 11.2 / 10.0 / 7.1, faint ("or", Get the apps) 7.1 / 6.6 / 5.9, Google text 14.5. The faint ink was 3.3 at worst and carried the help text; it is lighter now and help uses the dim ink. No placeholders are used |
| prefers-reduced-motion | done | see helper report | see helper report | with `reducedMotion: reduce` no CSS animation runs; the view change and the waiting dot stop, the sky paints one still frame |
| RTL | done | see helper report | see helper report | 320 and 360 wide right to left: no sideways scroll, Show and Forgot password? flip sides, arrow keys on the switch follow the reading direction |
| every phone size + desktop | done | see helper report | see helper report | 320, 360, 390, 430, 740x360 landscape, 1280, 1920: no sideways scroll, the panel inside the screen, controls 44 px tall on touch screens |
| zoom to 200 % | done | see helper report | see helper report | 640x360 CSS px: one column, scrolls vertically only, nothing clipped (`web-zoom200-request-error.png`) |
| rate-limit message | done | see helper report | see helper report | 11 wrong tries: "Too many tries. Wait 15 minutes, then try again.", fields kept |
| no account enumeration in the words | done | see helper report | see helper report | sign-in: "That username and password don't match"; ask the admin, email link and reset options answer the same for anyone; a wrong reset code says the same for an unknown name. (Request access must say a username is taken, as every sign-up does) |
| screen-reader name of the code tiles | done | see helper report | see helper report | the tiles are hidden from screen readers and a line reads "Code: W X Y Z K 7 M 4" (it used to have no name at all: an `aria-label` on a plain div); the tiles stay on one line down to 320 wide (`web-phone360-google-code.png`) |

Decisions for elia:

- **Minimum length 4.** Kept, because it is the household's existing rule and the server enforces
  it for every client. The common minimum today is 8 (NIST SP 800-63B asks for at least 8 for a
  password chosen by the person). Raising it would only apply to new passwords; existing ones
  keep working.
- **Google's face.** The button uses Roboto / the system face instead of Google Sans Medium,
  which Aurora does not ship. Shipping it means adding the font files to the site.
- **The profile wall's unlock sheet** clears a wrong password (like a lock screen) and has
  `autocomplete="off"`, so a shared household browser does not save every profile's password.
  Both on purpose; say if the sheet should behave like the sign-in screen instead.

## 5. Email reset: what elia would need to provide

Email reset is built (src/lib/mailer.js, POST /api/auth/reset/email, the "Email me a link"
option and the #/reset/<token> link page) and switched OFF. No mail account was set up and no
mail was sent; the sender was only tested against a fake mail server inside the test run.
"Email me a link" appears on every client only once all of this is in place:

1. **A sending account.** One of:
   - **SMTP** (any mailbox provider): host, port (465 for TLS, or 587 with STARTTLS), the
     username, and its password. With Gmail this is `smtp.gmail.com`, 465, the Gmail address,
     and an **app password** (Google Account → Security → 2-Step Verification → App passwords),
     never the account password. The server refuses a mail server without encryption.
   - **Resend** (resend.com, an HTTP API, no SMTP): an API key, and nufurora.com added as a
     sending domain there (it gives DNS records to add).
2. **A from address**, e.g. `Aurora <no-reply@nufurora.com>`. For mail from @nufurora.com to
   land in inboxes rather than spam, the domain needs SPF and DKIM records (the provider lists
   them) and ideally a DMARC record. With Gmail SMTP the from address is the Gmail address.
3. **config.json** on the nufurora.com host:
   ```json
   "publicUrl": "https://nufurora.com",
   "passwordReset": { "email": {
     "enabled": true,
     "from": "Aurora <no-reply@nufurora.com>",
     "provider": "smtp",
     "smtp": { "host": "smtp.gmail.com", "port": 465, "user": "you@gmail.com" }
   } }
   ```
   (`"provider": "resend"` needs no `smtp` block.)
4. **.env** (secrets never go in config.json; configcheck refuses a password there):
   `AURORA_SMTP_PASSWORD=…` for SMTP, or `AURORA_MAIL_API_KEY=…` for Resend.
5. A server restart. Then: Forgot password? → "Email me a link" shows on web, phone and TV.

How it behaves: the link goes only to the email already on the profile (never one typed on
the reset screen), works once for 30 minutes, the answer on screen is the same whether the
name exists or not, it is rate-limited (5 per hour per name, 12 per hour per address), and the
link points at `publicUrl`, never at whatever Host a request claimed.
