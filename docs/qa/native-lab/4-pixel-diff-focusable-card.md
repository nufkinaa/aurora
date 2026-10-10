# Native Focusable + Card vs their JS twins — 2026-10-10 (P1 + P2)

Mi TV MiTV-AFMU0 (Android 14, 1920x1080 @ 320 dpi), `com.auroratv.lab` v9000, local server, profile Claude QA, `freeze on`.
Rule (diff.py, unchanged): pixelmatch YIQ 0.1; any differing px off an edge fails; on-edge <= 0.05 %.

| run | folder | result |
|---|---|---|
| js vs js (determinism, `--impl -`) | `js-vs-js/` | 25 pass · 0 fail · 4 skipped — 0 differing px in every state (Home, Browse, Detail/Sources) |
| js vs focusable+card native (`--impl FC`) | `FC/` | 24 pass · 1 fail (trace only, 0 px) · 4 skipped |
| `navitem-lit` again, x3 (`--impl FC --runs 3`) | `FC-navitem-lit-x3/` | 3 pass |

## Per state (impl FC; js-vs-js alongside)

| component | state | FC differing px | FC off-edge px | FC max Δ | FC trace | FC | js-vs-js differing px |
|---|---|---|---|---|---|---|---|
| focusable | card-rest | 0 | 0 | 0 | - | PASS | 0 |
| focusable | card-lit | 0 | 0 | 1 | ok | PASS | 0 |
| focusable | btn-primary-lit | 0 | 0 | 0 | - | PASS | 0 |
| focusable | btn-primary-rest | 0 | 0 | 0 | - | PASS | 0 |
| focusable | btn-secondary-lit | 0 | 0 | 0 | ok | PASS | 0 |
| focusable | btn-secondary-rest | 0 | 0 | 0 | - | PASS | 0 |
| focusable | chip-on-lit | 0 | 0 | 0 | - | PASS | 0 |
| focusable | chip-lit | 0 | 0 | 0 | ok | PASS | 0 |
| focusable | chip-rest | 0 | 0 | 0 | - | PASS | 0 |
| focusable | chip-surface-lit | 0 | 0 | 0 | - | PASS | 0 |
| focusable | navitem-lit | 0 | 0 | 0 | FAIL | **FAIL** | 0 |
| focusable | navitem-lit-2 | 0 | 0 | 0 | - | PASS | 0 |
| focusable | sources-row-lit | 0 | 0 | 0 | - | PASS | 0 |
| focusable | sources-row-lit-2 | 0 | 0 | 0 | ok | PASS | 0 |
| card | rest-home | 0 | 0 | 0 | - | PASS | 0 |
| card | size-frame | 0 | 0 | 1 | ok | PASS | 0 |
| card | progress-bar | 0 | 0 | 1 | - | PASS | 0 |
| card | size-frame-episode | 0 | 0 | 1 | - | PASS | 0 |
| card | size-poster | 0 | 0 | 0 | ok | PASS | 0 |
| card | kind-tag | 0 | 0 | 0 | - | PASS | 0 |
| card | size-poster-row2 | 0 | 0 | 0 | - | PASS | 0 |
| card | grid-rest | 0 | 0 | 0 | - | PASS | 0 |
| card | grid-lit | 0 | 0 | 0 | ok | PASS | 0 |
| card | new-tag | 0 | 0 | 0 | - | PASS | 0 |
| card | new-tag-rest | 0 | 0 | 0 | - | PASS | 0 |
| card | size-wide | - | - | - | - | SKIP (needs the instance started with fixture) | - |
| card | size-compact | - | - | - | - | SKIP (needs the instance started with aiMock) | - |
| card | blur-up | - | - | - | - | SKIP (needs the instance started with artDelay) | - |
| card | broken-tile | - | - | - | - | SKIP (needs the instance started with artFail) | - |

## The one failure

`focusable/navitem-lit` (LEFT on the hero's Stream opens the rail): **0 differing px**; the `focus.ring` TRACE did not match in this run — `A step 1 at 20.0 ms = 0.638`. The rail opening drops frames in both implementations, and the JS side's `[anim]` lines are stamped when they ARRIVE at the native module, not at their frame: its first two steps (frame 0 and frame 2 of the 160 ms curve) arrived 20 ms apart after a 176 ms wait, so A's curve looks compressed against B's frame-stamped one. A measurement artefact of the JS trace under load, not a different animation: the same state passed in the js-vs-js run and 3/3 in `FC-navitem-lit-x3/`. Left failing here rather than loosened.

## Skipped (need a fixture or a server flag — see `tools/tv-pixel-diff/states/card.json`)

- `card/size-wide` — no episode item exists outside Continue Watching in this library (there it is a frame card: `size-frame-episode`); needs the 02 §3.1 fixture.
- `card/size-compact` — the AI page needs an answer (`--server aiMock`).
- `card/blur-up`, `card/broken-tile` — `--server artDelay` / `--server artFail`.

## Below the threshold, for the record (threshold-free comparison of the filed captures)

- js-vs-js: all 25 pairs are byte-identical pictures (0 px at any level).
- FC: 21 of 25 pairs are byte-identical. The other four are the four states with a LIT Continue Watching (frame) card, and differ by exactly 1/255 only in that card's lift-shadow halo
  (`0 18px 36px rgba(0,0,0,0.6)`, outside the card): `card/size-frame` 4 px, `card/progress-bar` 4 505 px, `focusable/card-lit` 15 535 px, `card/size-frame-episode` 20 379 px.
  None reaches the YIQ 0.1 threshold, so the rule passes them (max Δ 1 in the table).
- What it is not: a different end state. In the traced one (`card-lit`) the native run's last `[anim]` values are exactly `focus.ring 1.000000`, `focus.spring 1.000000`
  (scale 1.055, lift −3 dp), as in JS, and the card's own pixels are identical.
- What it is: the same halo was captured in two discrete 1/255 variants, and BOTH implementations produce both — a JS capture after a key burst showed the second variant
  against another JS capture (15 531 px), five native captures in a row showed the first. The shadow is RN's `OutsetBoxShadowDrawable` (a `BlurMaskFilter` round-rect) drawn under a
  view that is scaling while it fades in; which blurred mask the renderer ends up with depends on the frames drawn on the way (the two runs dropped different frames), not on the final values.
  It showed more often on the native side in this run (3 of 4 states vs 0 of 4 js-vs-js). Not masked, not fixed; stated.
