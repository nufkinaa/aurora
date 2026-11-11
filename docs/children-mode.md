# Children mode

elia, 2026-11-11: "can we make it just children mode where it cleans the feed and puts it in
children mode and only after a passcode it returns to normal … and it happens to the whole
account." Children mode replaced kids profiles.

## What it does

- **It belongs to one account** (account = profile). Turning it on affects every device
  signed in to that account: the website, the TV and the phone app. Other accounts in the
  house are never touched.
- **Turning it on is one click.** Pick "Who is watching? All ages · 7+ · 12+ · 16+", then
  Turn on. The first time on an account, the parent also chooses a passcode of 4 to 6 digits,
  typed twice. The passcode is remembered on the account, so later it is not asked again
  when turning on.
- **While it is on:**
  - Everything the account sees is filtered to the chosen age. This includes Home, Continue
    Watching, Movies, Shows, search, the catalogue, title pages, X-Ray, the calendar, My List,
    household recommendations, streams, subtitles, pictures and downloads.
  - The server's age gate (`src/lib/kids.js`) does the filtering, with the same rules kids
    profiles had: a title without a known rating stays hidden, and the strictest rating any
    country gives a title counts.
  - AI picks are off. Remarks use only the kind lines. Wrapped speaks kindly too: its "The intervention" chapter becomes "The highlights".
  - The mint "Kids" mark is shown.
  - Settings keep only the basics. There are no downloads, no Switch profile, no sign-out,
    no Sign in a TV, and no password, email or Google changes.
- **A younger age is free**, because it only restricts more. Choosing an older age, or
  leaving Children mode, takes the passcode. Wrong passcodes are rate-limited in two ways:
  5 tries per device and account in 15 minutes, and 30 tries per account per day.
- **Forgot the passcode?** The account's own password turns Children mode off and clears the
  passcode. On the website, the account's Google sign-in does the same. The next Turn on asks
  for a new passcode. The TV says to use the phone or the website for this. The admin page
  can also turn it off or clear the passcode.
  - **By design:** a child who knows the account's password can leave this way. Children mode
    lives on the parent's own account, so that password is the parent's secret.
  - An account with no password (and no Google) can only be cleared by the admin.

## How it works

- **Stored on the profile** (`src/profiles.js`):
  - `childMode: { maxAge, since }` while it is on.
  - `childPass: { salt, hash, setAt, from? }` is the passcode, hashed with scrypt like a
    password. It is kept when Children mode goes off.
  - Neither field can be set through the plain profile update.
  - `kidsOf(id)`, which every age check reads, returns the limit while Children mode is on.
  - The public profile still carries `kids: { maxAge }` as a mirror for older apps.
- **Routes** (`src/routes/profiles.js`):
  - `GET /api/profiles/:id/child-mode`
  - `POST …/child-mode` with `{ maxAge, newPasscode? | passcode? }`
  - `POST …/child-mode/off` with `{ passcode }`
  - `POST …/child-mode/forgot` with `{ password } | { googleToken }`. The Google token comes
    from a Google sign-in with intent `childmode`, is good for 10 minutes and works once.
  - Admin: `POST /api/admin/profiles/:id/child-mode` with `{ on:false } | { maxAge } |
    { clearPasscode:true }`.
  - Each change goes into the sign-in log (`child-mode-on/off/age`, `child-passcode-reset`),
    which never holds a secret.
- **Every device follows it live:**
  - The server sends `{type:"child_mode", profileId, childMode}` to every socket of the
    account.
  - A device that misses that message is still filtered on its next request, because the
    gate reads the account and not the device.
  - The answer's `X-Aurora-Kids` header tells the website (`js/childmode.js`) and the apps
    (`childMode.ts`, `AppRoot.tsx`) to switch their look and start again from Home.
  - The browser that turned it on is locked to the account with the `aurora_kid` cookie.
    Other tabs lock themselves when they hear the message.
  - A lock left over from an earlier stretch of Children mode is ignored. For example, a
    browser that has moved on to another profile is never pulled back in.
- **No sign-in changes while it is on** (`src/routes/auth.js`): password change, Google link,
  signing other devices out, claiming the account and the self-service password reset are all
  refused.

## Kids profiles became Children mode (the migration)

The migration runs once at server start (`bootMaintenance` → `migrateChildMode`):

1. It copies the whole `profiles.json` aside first, as
   `data/profiles.pre-children-mode-<ms>.json`. Aurora never deletes this copy. If the copy
   cannot be written, nothing is migrated, and the old kids profiles stay exactly as strict.
2. Each kids profile becomes a normal account with Children mode on at its old age. Its
   passcode is a copy of the household PIN's hash, so the same digits a parent already knows
   still open it, and nothing opens up for a child. A kids profile in a house without a PIN
   stays locked until the admin turns it off.
3. Each run is recorded in `migrations.childMode` and logged. Once nothing is left to change,
   the migration does nothing at all.
4. When the admin changes the household PIN, the copied passcodes follow the change.
5. To undo: stop the server, roll the code back, then run
   `node scripts/children-mode-undo.js --write`. A dry run without `--write` says what it
   would do. The undo turns each migrated account back into a kids profile at its current age
   and removes the copied passcode. A whole-file restore is also possible: copy the backup
   over `profiles.json` with the server stopped, accepting that later changes are lost.

**The household PIN** is still used by the profile wall's "Grown-ups only": while an account
is in Children mode, a grown-up's profile that has no password opens with the PIN. The admin
page offers to remove the PIN once no copied passcode and no un-migrated kids profile depends
on it. It is never removed automatically.

## The apps released before Children mode

These are TV 5.9.4 and earlier, and phone 1.1.x.

- They see the account's `kids` mirror and treat the account as a kids profile: a badge, a
  device lock, and a PIN screen to leave.
- Their PIN screen calls `/api/kids/exit`, which now checks **the account's passcode**. A
  correct passcode lifts only that device's lock, and Children mode stays on for the account.
  An account with no passcode can no longer be left this way.
- Their editor's kids switch (`/api/profiles/:id/kids`) is mapped onto Children mode with the
  account's passcode.
- The server filters them regardless, because they name the profile on every request.
- **One gap remains** (the same caveat as before) when sign-in is "open" or "transition". An
  old app that was already in the account when Children mode was turned on elsewhere gets the
  filtered feed, but not the lock, until it enters the profile again. When sign-in is
  "closed", the session is the person and there is no gap.

## Tests

- `test/children-mode.test.js` (server) covers:
  - turning on (one click after the first time), lowering and raising the age;
  - filtering on every device through every source (session, header, token, query, cookie),
    and no other account touched;
  - no way out without the passcode (old exit, old switch, plain update, sign-in changes,
    reset, other accounts' routes, forged or old cookies), and the rate limits;
  - the forgot path with a password and with Google, and the admin's routes;
  - older apps, and the migration including its undo, its failing closed and old locks
    standing.
- Website: `test/ui/children-mode.test.js` and `test/ui/kids.test.js`.
- Apps: `tv-native/__tests__/logic/child-mode.test.ts` and `phone-menu.test.ts`.
