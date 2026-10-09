# tv-pixel-diff — the screenshot/trace A-B harness for the native rewrite

Implements `docs/native-rewrite/02-verification.md` §4 (and the parts of §2, §3, §5, §7 it
needs) in Python 3 + Pillow + numpy. Everything runs against the real Mi TV (elia's rule:
no sandbox for TV checks). The broadcast protocol between this harness and the app's
`QaReceiver` is fixed in **`PROTOCOL.md`** — the receiver must be written to it.

```
tools/tv-pixel-diff/
  run.py         the runner: states -> device -> captures -> diff -> summary
  diff.py        the pure pixel diff (standalone CLI, unit-testable)
  trace.py       [anim]/[key]/[focus] parsing + numeric comparison
  adb.py         adb wrappers, the QA broadcast, the device lock
  selftest.py    synthetic self-test of diff.py + trace.py (no device)
  PROTOCOL.md    the com.auroratv.QA contract
  states/*.json  the state DSL, one file per component in phase order
  .device.lock   present only while a run holds the TV
```

## Run

```
cd tools/tv-pixel-diff
python selftest.py                                   # must print SELFTEST GREEN
python run.py --dry-run --states all                 # print the plan, touch nothing

python run.py --serial 192.168.50.31:5555 --pkg com.auroratv.lab --impl F \
              --states focusable --runs 1 --out docs/qa/native-diff/2026-10-09/ \
              --var id1=tt9000001 --server artDelay
```

| option | meaning |
|---|---|
| `--serial`, `--pkg` | the TV and the applicationId (`com.auroratv.lab` = the lab build, `com.auroratv` = the real app) |
| `--impl F` | which components are `=native` on the B side (letters `F C R H N G` = focusable card row hero rail grid, PROTOCOL §5). Omit to use each state file's own letter |
| `--states` | comma list of `focusable,card,row,hero,navrail,browse`, `all`, or paths to `.json` files; `--only name,…` narrows to named states |
| `--runs N` | repeat each state N times (`<state>/runN/`); a state passes only if every run passes |
| `--out` | default `docs/qa/native-diff/<today>/` under the repo root |
| `--var k=v` | substitutes `${k}` in state files (`id1` = a fixture item id for `detail:` states; default `tt9000001`) |
| `--server flag` | declares which instance options are in effect (`artDelay`, `artFail`, `aiMock`, `fixtureTrailer`). States that need one you did not declare are **skipped** with the reason in the summary; the harness does not start the instance itself (02 §1 — `scripts/ui-test-server.js --port 4100` with the fixture, by the operator) |
| `--token` / `--keystore` | the QA token (PROTOCOL §1); by default derived from `tv-native/android/app/debug.keystore` via `keytool`. A release-signed build needs `--keystore tv-native/android/app/aurora.keystore` (and its password in the JDK keytool prompt is not supported — pass `--token` instead) |
| `--screenrecord` | also saves a 4 s `A.mp4`/`B.mp4` per state for the human pass |
| `--diff-only` | re-diffs the `A.png`/`B.png` already in `--out` (tune masks/tolerances without the TV) |
| `--force-lock` | ignore a stale `.device.lock` (only when its PID is dead) |

Before a run, pin the box as 02 §1 says (animator scales 1.0, font scale 1.0, 1080p, `en-US`,
screensaver off, stay-awake **on and left on**). The harness records all of it in `env.json`
and the summary header and warns when `animator_duration_scale` is not 1.0; it never
changes a setting itself.

## What a "state" is

One still of the app that both implementations must render identically, plus how to get
there. A state file:

```json
{
  "component": "row", "impl": "R",
  "defaults": { … every key below, merged under each state … },
  "states": [
    {"name": "lead",
     "launch":   {"data": null, "extras": {}},               // am start -d <uri> / --es extras
     "nav":      "home",                                     // the nav broadcast (PROTOCOL §3)
     "keys":     ["DPAD_DOWN", "wait:800", "DPAD_RIGHT*12@50", "DPAD_CENTER!long"],
     "keyGapMs": 150,                                        // pause after each key
     "settleMs": 900,                                        // after the last key, before the idle poll
     "freeze":   {"freeze": "on", "trace": false, "focuslog": true},   // freeze on|off|on,trailer
     "idle":     {"quietMs": 600, "gfxStableMs": 500, "pollMs": 100, "timeoutMs": 10000},
     "masks":    [{"rect": [x, y, w, h], "why": "…"}, {"nativeId": "qa-…", "why": "…"}],
     "dither":   [{"rect": [x, y, w, h], "why": "…"}],
     "crop":     null,                                       // or [x,y,w,h] or {"nativeId": "qa-row-continue"}
     "trace":    ["row.tx"], "retarget": true,               // [anim] ids compared; retarget adds the rest-time check
     "server":   {"artDelay": 600000},                       // precondition; see --server
     "tolerance": {"threshold": 0.1, "maxDiffFraction": 0.0005, "edgeDilate": 1},
     "note":     "what the frame should show"}
  ]
}
```

Keys: `KEY` → `input keyevent KEYCODE_KEY`; `KEY*N@ms` → N presses `ms` apart from one shell
loop (the hold approximation of 02 §4.1 — `input keyevent` cannot produce Android's own
auto-repeat; the `[key]` lines carry the true arrival times); `KEY!long` → `--longpress`;
`wait:ms` → a pause. Masks and dither rects are **px on the 1920×1080 screencap** (dp × 2);
with a `crop`, they are still given in screen px and shifted by the harness.

Per state the runner does, for side A (every component `=js`) and side B (the state's
letters `=native`): `impl` broadcast → `am force-stop` → `freeze` / `trace` / `focuslog`
broadcasts (written BEFORE the launch: the receiver takes them with the process dead and
they persist, so the app starts frozen and the JS side attaches its trace listeners at
start) → `am start` → wait `--launch-wait-ms` (4000) → `nav` → 500 ms (screen fade) → idle →
`logcat -c` → keys → `settleMs` → idle → `screencap -p` → `logcat -d` (saved) → resolve
`nativeId` masks/crop with `layout` → `framestats`.

**Determinism** (2026-10-10). Before the first state the runner turns `trace` on for 3 s
and counts `[key]` lines: any key it did not send aborts the run ("something else is
driving the TV"). The first run of this harness failed 12/12 because four orphaned
`tools/tv-bench.sh` loops on the PC were pressing LEFT/RIGHT every 0.6 s — the hero
"rotated", the rail opened, nothing was ever idle. A traced state also fails if more
`[key]` lines arrive than its key path has. To prove a setup is deterministic run a state
against itself: `--impl -` makes the B side all-js too, and every state must then come back
with 0 differing px.

**Idle** = no new `[anim]` line (`adb logcat -d -s AuroraAnim:V`) for `quietMs` **and**
`dumpsys gfxinfo <pkg>` "Total frames rendered" unchanged for `gfxStableMs`, polled every
`pollMs`. On `timeoutMs` the capture is taken anyway and the state fails with "idle timeout";
a screen that never settled after `nav` (before the keys) fails the state as well.

The state files assume the deterministic fixture of 02 §3.1 (`/api/home` rows: continue,
recent, poster rows with ≥ 16 items; the "Claude QA" profile) — each file's `notes` lists its
assumptions and the key paths they lead to. Adjust the key lists, not the harness, when
the fixture's row order differs.

## The pass/fail rule (diff.py)

1. Colour distance per pixel = **pixelmatch**'s: alpha-blend on white, YIQ,
   `delta = 0.5053·dY² + 0.299·dI² + 0.1957·dQ²`; a pixel *differs* when
   `delta > 35215 · threshold²` (threshold **0.1** → 352.15). Anti-aliasing detection is off.
2. **Masks** are excluded from the compare; every mask is listed in the report with its `why`.
3. **Edge mask** = Sobel on A's luma, normalised so a clean step of height *h* reads *h*,
   `> 40` (of 255), dilated by `edgeDilate` = **1 px**.
4. Differing pixels **on** the edge mask are tolerated up to `maxDiffFraction` =
   **0.0005** (0.05 %) of the compared pixels. **Any differing pixel off the edge mask
   fails** the state (a flat area that differs is a colour, alpha or shift error).
5. **Dither regions**: off the edges, a pixel whose largest per-channel difference is
   ≤ **2/255** is forgiven; the regions and the number of forgiven pixels are always
   reported. (At threshold 0.1 the YIQ test already absorbs ≤ ~26 luma levels, so the
   allowance matters at `threshold: 0` — the zero-tolerance text procedure of 02 §3.4.)
6. Size mismatch, a `layout` rect that differs between A and B, an unresolvable
   `nativeId` mask, an idle timeout, or a harness error fail the state.
7. **Traces** (trace.py — its header has the reasoning): for each id in `trace`, the steps
   after the LAST `[key]` of the path (`"traceFrom": "first"`, or `retarget`, for a burst)
   are compared as curves in TIME since their first step: every step of one run must lie
   on the other run's curve within ±25 ms (+ 1e-3 × range), the rest values must agree
   within 1e-3 × range and the settle times within 50 ms; with `retarget` the final step's
   time after the key within 16.7 ms. (The first rule — align by step index, 1e-3 per
   step — failed a run against itself: the drivers step on real frame times.) The ids
   `focus.ring` / `focus.spring` are the element GAINING focus; the one losing it logs
   `focus.ring.out` / `focus.spring.out`. key→first-step latency is reported, not judged.
   A missing trace on either side fails. The `[focus]` table (02 §5) is written
   to `traces/` and compared; it gates the state only with `"focusCheck": true`.

Standalone: `python diff.py A.png B.png [--out D.png --triptych T.png --json R.json
--mask x,y,w,h --dither x,y,w,h --threshold 0.1 --max-diff-fraction 0.0005 --edge-dilate 1]`
prints the numbers and exits 1 on fail. A full 1920×1080 pair diffs in ~0.5 s.

## Output layout

```
<out>/
  env.json                      device fingerprint, display mode, locale, scales, versionCode, receiver ping
  summary.md                    header (APK versionCode / commit / fingerprint / display mode / locale),
                                the pass/fail table, masks + dither used, failures, skips
  summary.json                  the same, machine-readable (every result.json inlined)
  <component>/<state>[/runN]/
    A.png  B.png                full screencaps (js / native)
    D.png                       A dimmed grey; edge mask blue; masks dark-hatched; differing px red
                                (off-edge ones fattened by 2 px so one pixel is visible at 1080p)
    triptych.png                A | B | D at 960 px per panel
    result.json                 {state, impl, run, differing_px, off_edge_px, on_edge_px, diff_fraction,
                                 max_delta (max channel Δ), max_yiq, masks_applied, dither_regions,
                                 dither_forgiven_px, crop, idle{A,B}, trace{…}, focus{…}, reasons, pass}
    A.logcat.txt  B.logcat.txt  the AuroraQA/AuroraAnim lines of each capture
    A.mp4  B.mp4                with --screenrecord
  traces/<component>.<state>[.runN].json
                                both parsed traces, the per-id comparison, the focus tables
```

Exit code: 0 when every state passed or was skipped with a declared reason, 1 on any failure,
2 on a harness/usage error. A phase is "passed" only by a `summary.md` elia has seen (02 §7).
