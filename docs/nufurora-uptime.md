# Knowing when nufurora.com is down

The server cannot tell you that it is down. Something outside has to look.
This page compares three free services and gives the steps for the one we
recommend. Nothing here is set up for you: you sign up yourself, and the
alerts go to your email.

## What there is to check

`https://nufurora.com/healthz` answers `{"ok":true,"uptime":…,"version":"…"}`.

- It needs no sign-in and carries no secrets (`src/lib/health.js`): safe to
  hand to an outside service.
- While Aurora is stopping or restarting it answers `503` with
  `{"ok":false,"stopping":true}`, or not at all for a second or two. A restart
  (the admin's Restart button, an auto-update) can therefore cause one failed
  check. Set the monitor to alert only after the failure is confirmed (see the
  steps), so that a restart does not wake you.
- Over https, the check also notices a broken or expired certificate and a
  reverse proxy that is down.

## The three options

Plans and limits change. What follows is the free plan as of late 2026, as
far as we know; check each service's pricing page before you rely on it.

| | UptimeRobot | Better Stack (Uptime) | Healthchecks.io |
| --- | --- | --- | --- |
| What it does | calls the URL every few minutes | calls the URL every few minutes | waits for *your server* to call *it*; alerts when the calls stop |
| Check interval (free) | 5 minutes | 3 minutes | you choose the expected period |
| "Page must contain `"ok":true`" | yes (keyword monitor) | yes (keyword check) | not applicable |
| Email alerts (free) | yes | yes | yes |
| Certificate expiry warning | check whether the free plan includes it | check whether the free plan includes it | no |
| Good for | the main check | the main check, a little more often | a second line: the whole box stopped |

Our pick: **UptimeRobot** for the main check. It is the simplest to set up,
its keyword monitor checks the answer and not only the status code, and five
minutes is often enough for a home media server. Better Stack is an equally
good choice if you want checks every three minutes; the steps are almost the
same.

**Healthchecks.io** does not visit nufurora.com at all. It is a dead-man's
switch: Aurora pings it, and it emails you when the pings stop. That catches
what a URL check cannot tell apart, for example the whole VPS gone. Aurora
already knows how to do this: put the ping URL Healthchecks.io gives you in
`config.json` as `"healthPingUrl": "https://hc-ping.com/…"` and restart; the
server then calls it every five minutes for as long as it is alive
(`src/lib/health.js`). Optional.

## UptimeRobot, step by step

1. Go to uptimerobot.com and create a free account with your email address.
   Confirm the email.
2. On the dashboard, click **New monitor** (or **+ Add New Monitor**).
3. **Monitor type:** *Keyword*.
4. **Friendly name:** `nufurora`.
5. **URL:** `https://nufurora.com/healthz`
6. **Keyword:** `"ok":true` (with the quotes, no spaces).
   **Alert when:** the keyword does *not* exist.
7. **Monitoring interval:** 5 minutes (the free minimum).
8. **Alert contacts:** tick your email. It is usually there already, as the
   address you signed up with.
9. If the form offers a delay or "alert after N failed checks", choose 2, so a
   restart does not alert you.
10. If it offers a certificate (SSL) expiry alert, turn it on.
11. **Create monitor.** Within a few minutes it should say *Up*.

To test it: stop Aurora for ten minutes at a quiet time (`sudo systemctl stop
aurora`, then `start`). An email should arrive, then a second one when it is
back.

## Better Stack, if you prefer it

betterstack.com → Uptime → **Create monitor** → *Alert us when: URL becomes
unavailable* or *URL doesn't contain keyword* → URL
`https://nufurora.com/healthz`, keyword `"ok":true` → check frequency 3
minutes → **Confirmation period**: 30 seconds or more → on-call: email only →
create. Leave phone calls and SMS off unless you want them.

## What not to do

- Do not point the monitor at `/` or `/api/…`: the home page and the API may
  sit behind the sign-in wall, and they cost the server more than `/healthz`.
- Do not use a check interval shorter than a minute: it gains nothing here.
- Alerts go to your email. Use ntfy or a phone app only if you decide to.
