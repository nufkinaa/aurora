# Contributing to Aurora

Thanks for wanting to help! Aurora is a small, dependency-light codebase on
purpose — one Node server, a vanilla-JS frontend with **no build step**, and a
React Native TV client. Most contributions need nothing but Node and a media
folder.

## Getting a dev environment running

```bash
git clone https://github.com/nufkinaa/aurora.git
cd aurora
npm install
cp config.example.json config.json   # point it at any folder with a video file
cp .env.example .env                 # set AURORA_ADMIN_PASSWORD
npm start                            # → http://localhost:4000
```

- Frontend changes are live on refresh (`public/` is served statically,
  no-cache). Server changes need a restart.
- `npm test` runs the unit suite (`node --test`, no network, a few seconds).
  **Please keep it green** — it runs in CI on every PR.
- Optional tools unlock more features: ffmpeg (transcoding/subtitles), aria2
  (downloads), Tesseract + Python 3 (subtitle OCR). Everything degrades
  gracefully without them.

## Code style

Match what's around you — the codebase is consistent and hand-written:

- Plain Node (CommonJS) on the server, vanilla ES modules in `public/js/`.
  No frameworks, no TypeScript, no build step — that's a feature.
- Comments explain **why**, not what. The existing files set the tone: if a
  decision was measured or hard-won, the comment says so.
- Keep dependencies at zero unless there's a very strong case (the server has
  four runtime deps, on purpose).
- Small, focused commits and PRs. One fix or feature per PR.

## Before you open a PR

1. `npm test` passes.
2. You've actually exercised the change in a browser (and on a phone-sized
   viewport if it touches UI, and with keyboard arrows if it touches anything
   focusable — the TV spatial navigation rides on DOM focus).
3. If you changed an API route, check both consumers: the web app
   (`public/js/`) and the TV app (`tv-native/src/api.ts`).
4. Describe what was broken / missing, and how you verified the fix.

## Good first contributions

- Bug reports with reproduction steps are gold.
- Subtitle-provider quirks, codec edge cases, and device-specific playback
  reports (TV model, browser, file details) — even without a fix.
- Translations of UI strings are not wired up yet — open an issue first if
  you're interested.

## Questions

Open a [discussion or issue](https://github.com/nufkinaa/aurora/issues) —
there's no chat server yet.
