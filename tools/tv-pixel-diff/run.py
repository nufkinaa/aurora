#!/usr/bin/env python3
"""The TV screenshot-diff harness runner (docs/native-rewrite/02-verification.md §4, §7).

    python run.py --serial 192.168.50.31:5555 --pkg com.auroratv.lab --impl F \
                  --states focusable --runs 1 --out docs/qa/native-diff/2026-10-09/

For every state in the chosen state files, twice (A: every component =js; B: the state's
impl letters =native):  impl -> restart -> freeze/trace/focuslog -> nav -> keys -> settle ->
wait for idle -> screencap (+ logcat).  Then diff.compare(A, B) -> D.png, triptych.png,
result.json; traces/<state>.json for traced states; summary.md + summary.json at the end.
Exit code 1 on any failure (0 when everything passed or was skipped with a declared reason).

No device needed for:  --dry-run (print the plan)  and  --diff-only (re-diff an output dir).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import adb as adbmod  # noqa: E402
import diff as diffmod  # noqa: E402
import trace as tracemod  # noqa: E402
from adb import Adb, AdbError, DeviceLock, impl_spec  # noqa: E402

STATES_DIR = HERE / "states"
KEY_RE = re.compile(r"^([A-Z0-9_]+?)(?:\*(\d+)@(\d+))?(!long)?$")
PHASE_ORDER = ["focusable", "card", "row", "hero", "navrail", "browse"]


# ---------------------------------------------------------------- states

def _merge(defaults: dict, state: dict) -> dict:
    out = json.loads(json.dumps(defaults))
    for k, v in state.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    return out


def _subst(obj, variables: dict):
    if isinstance(obj, str):
        def rep(m):
            if m.group(1) not in variables:
                raise SystemExit(f"state uses ${{{m.group(1)}}} but no --var {m.group(1)}=… was given")
            return variables[m.group(1)]
        return re.sub(r"\$\{(\w+)\}", rep, obj)
    if isinstance(obj, list):
        return [_subst(x, variables) for x in obj]
    if isinstance(obj, dict):
        return {k: _subst(v, variables) for k, v in obj.items()}
    return obj


def load_states(names: list[str], variables: dict, impl_override: str | None, only: list[str]) -> list[dict]:
    """names: component names ('focusable'), 'all', or paths to json files."""
    files = []
    for n in names:
        if n == "all":
            files += [STATES_DIR / f"{c}.json" for c in PHASE_ORDER]
        elif n.endswith(".json"):
            files.append(Path(n))
        else:
            files.append(STATES_DIR / f"{n}.json")
    states = []
    for f in files:
        if not f.exists():
            raise SystemExit(f"no such state file: {f}")
        doc = json.loads(f.read_text(encoding="utf-8"))
        letters = (impl_override or doc.get("impl", "")).upper()
        for st in doc["states"]:
            s = _merge(doc.get("defaults", {}), st)
            s["component"] = doc["component"]
            s["impl"] = (st.get("impl") or letters).upper()
            s["file"] = str(f)
            states.append(s)
    try:
        states = [_subst(s, variables) for s in states]
    except SystemExit as e:
        # defer: only states that need the variable are affected
        kept = []
        for s in states:
            try:
                kept.append(_subst(s, variables))
            except SystemExit as e2:
                s["skip"] = str(e2)
                kept.append(s)
        states = kept
    if only:
        states = [s for s in states if s["name"] in only or f"{s['component']}/{s['name']}" in only]
    return states


def parse_keys(keys: list[str]) -> list[tuple]:
    """-> [('wait', ms) | ('key', NAME, n, gap_ms, long)]"""
    plan = []
    for k in keys:
        if k.startswith("wait:"):
            plan.append(("wait", int(k[5:])))
            continue
        m = KEY_RE.match(k)
        if not m:
            raise SystemExit(f"bad key spec {k!r} (KEY, KEY*N@ms, KEY!long, wait:ms)")
        plan.append(("key", m.group(1), int(m.group(2) or 1), int(m.group(3) or 0), bool(m.group(4))))
    return plan


# ---------------------------------------------------------------- device steps

def drive_keys(dev: Adb, keys: list[str], gap_ms: int):
    for step in parse_keys(keys):
        if step[0] == "wait":
            time.sleep(step[1] / 1000)
            continue
        _, name, n, burst_gap, long = step
        if n > 1:
            dev.key_burst(name, n, burst_gap)
        elif long:
            dev.shell(f"input keyevent --longpress KEYCODE_{name}")
        else:
            dev.keyevent(name)
        time.sleep(gap_ms / 1000)


def count_anim(text: str) -> int:
    return text.count("[anim]")


def wait_idle(dev: Adb, idle: dict) -> dict:
    """Idle = no new [anim] line for quietMs AND `dumpsys gfxinfo` Total frames rendered
    unchanged for gfxStableMs (polls pollMs apart). Returns what it saw."""
    quiet, stable = idle.get("quietMs", 600) / 1000, idle.get("gfxStableMs", 500) / 1000
    poll, timeout = idle.get("pollMs", 100) / 1000, idle.get("timeoutMs", 10000) / 1000
    t0 = now = time.monotonic()
    anim_n, anim_at = count_anim(dev.logcat_dump(adbmod.TAG_ANIM)), now
    frames, frames_at = dev.gfx_total_frames(), now
    polls = 0
    while True:
        time.sleep(poll)
        now = time.monotonic()
        polls += 1
        n = count_anim(dev.logcat_dump(adbmod.TAG_ANIM))
        if n != anim_n:
            anim_n, anim_at = n, now
        f = dev.gfx_total_frames()
        if f != frames:
            frames, frames_at = f, now
        if now - anim_at >= quiet and now - frames_at >= stable:
            return {"idle": True, "waited_ms": int((now - t0) * 1000), "polls": polls, "anim_lines": anim_n, "frames": frames}
        if now - t0 > timeout:
            return {"idle": False, "waited_ms": int((now - t0) * 1000), "polls": polls, "anim_lines": anim_n, "frames": frames,
                    "note": "idle timeout — the app kept drawing or animating; the capture is suspect"}


def capture_side(dev: Adb, state: dict, side: str, out_dir: Path, args) -> dict:
    letters = state["impl"]
    spec = impl_spec(letters, native=(side == "B"))
    info = {"side": side, "impl_spec": spec}
    info["impl_result"] = dev.qa_expect("impl", spec)
    launch = state.get("launch") or {}
    dev.restart(launch.get("data"), launch.get("extras"))
    time.sleep(args.launch_wait_ms / 1000)
    fz = state.get("freeze") or {}
    freeze_arg = fz.get("freeze", "on")
    if isinstance(freeze_arg, bool):
        freeze_arg = "on" if freeze_arg else "off"
    ok, detail = dev.qa("freeze", freeze_arg)
    if not ok:
        raise AdbError(f"freeze {freeze_arg}: {detail}")
    traced = bool(state.get("trace")) or bool(fz.get("trace"))
    dev.qa_expect("trace", "on" if traced else "off")
    dev.qa_expect("focuslog", "on" if fz.get("focuslog", True) else "off")
    info["nav"] = dev.qa_expect("nav", state.get("nav", "home"))
    time.sleep(0.5)  # screen fade (260 ms) + a margin
    info["idle_before_keys"] = wait_idle(dev, state["idle"])
    dev.logcat_clear()
    rec = None
    if args.screenrecord:
        rec = dev.screenrecord(f"/sdcard/tvpd-{state['name']}-{side}.mp4", seconds=4)
    drive_keys(dev, state.get("keys", []), state.get("keyGapMs", 150))
    time.sleep(state.get("settleMs", 700) / 1000)
    info["idle"] = wait_idle(dev, state["idle"])
    png = dev.screencap(out_dir / f"{side}.png")
    info["png"] = str(png)
    log = dev.logcat_dump()
    (out_dir / f"{side}.logcat.txt").write_text(log, encoding="utf-8")
    info["log"] = log
    if rec is not None:
        rec.wait(timeout=10)
        try:
            dev.pull(f"/sdcard/tvpd-{state['name']}-{side}.mp4", out_dir / f"{side}.mp4")
            dev.shell(f"rm /sdcard/tvpd-{state['name']}-{side}.mp4", check=False)
        except AdbError as e:
            info["screenrecord_error"] = str(e)
    # masks / crop by nativeId are resolved on the live view tree
    masks = []
    for m in state.get("masks", []):
        if "nativeId" in m:
            r = dev.layout(m["nativeId"])
            masks.append({"rect": list(r) if r else None, "why": m.get("why", ""), "nativeId": m["nativeId"]})
        else:
            masks.append(m)
    info["masks"] = masks
    crop = state.get("crop")
    if isinstance(crop, dict) and "nativeId" in crop:
        info["crop"] = dev.layout(crop["nativeId"])
        info["crop_nativeId"] = crop["nativeId"]
    else:
        info["crop"] = crop
    ok, detail = dev.qa("framestats")
    info["framestats"] = detail if ok else None
    return info


# ---------------------------------------------------------------- compare

def _crop_img(path: Path, rect):
    from PIL import Image
    im = Image.open(path)
    if rect:
        x, y, w, h = rect
        im = im.crop((x, y, x + w, y + h))
    return im


def compare_state(state: dict, a: dict, b: dict, out_dir: Path, run_idx: int) -> dict:
    tol_d = state.get("tolerance", {})
    tol = diffmod.Tolerance(tol_d.get("threshold", 0.1), tol_d.get("maxDiffFraction", 0.0005), tol_d.get("edgeDilate", 1))
    reasons = []
    crop = a.get("crop")
    if crop and b.get("crop") and list(crop) != list(b["crop"]):
        reasons.append(f"layout rect differs: A {list(crop)} vs B {list(b['crop'])}")
    masks = []
    for m in a.get("masks", []):
        if m.get("rect") is None:
            reasons.append(f"mask {m.get('nativeId')} could not be resolved (layout err)")
            continue
        r = diffmod.Rect.parse(m)
        if crop:
            r.x, r.y = r.x - crop[0], r.y - crop[1]
        masks.append(r)
    dither = []
    for d in state.get("dither", []):
        r = diffmod.Rect.parse(d)
        if crop:
            r.x, r.y = r.x - crop[0], r.y - crop[1]
        dither.append(r)
    A, B = _crop_img(Path(a["png"]), crop), _crop_img(Path(b["png"]), crop)
    D, res = diffmod.compare(A, B, masks, dither, tol)
    D.save(out_dir / "D.png")
    diffmod.triptych(A, B, D, labels=(f"A  js", f"B  {state['impl']} native", "D  diff")).save(out_dir / "triptych.png")

    result = {
        "state": state["name"], "component": state["component"], "impl": state["impl"], "run": run_idx,
        "differing_px": res.differing_px, "off_edge_px": res.off_edge_px, "on_edge_px": res.on_edge_px,
        "diff_fraction": res.diff_fraction, "compared_px": res.compared_px, "masked_px": res.masked_px,
        "max_delta": res.max_delta, "max_yiq": res.max_yiq, "dither_forgiven_px": res.dither_forgiven_px,
        "masks_applied": res.masks_applied, "dither_regions": res.dither_regions,
        "crop": list(crop) if crop else None, "tolerance": tol.__dict__,
        "idle": {"A": a.get("idle"), "B": b.get("idle")},
        "reasons": list(res.reasons) + reasons,
    }
    for side in (a, b):
        if side.get("idle") and not side["idle"].get("idle", True):
            result["reasons"].append(f"{side['side']}: idle timeout before capture")

    # traces
    ids = state.get("trace") or []
    ta, tb = tracemod.parse(a.get("log", "")), tracemod.parse(b.get("log", ""))
    focus = tracemod.compare_focus(ta, tb)
    tr = tracemod.compare(ta, tb, ids, retarget=bool(state.get("retarget"))) if ids else None
    trace_doc = {"state": state["name"], "component": state["component"], "impl": state["impl"], "run": run_idx,
                 "ids": ids, "anim": tr, "focus": focus, "A": ta.to_dict(), "B": tb.to_dict()}
    traces_dir = out_dir.parent.parent / "traces"
    traces_dir.mkdir(parents=True, exist_ok=True)
    (traces_dir / f"{state['component']}.{state['name']}{'' if run_idx == 1 else f'.run{run_idx}'}.json").write_text(
        json.dumps(trace_doc, indent=1), encoding="utf-8")
    if tr is not None:
        result["trace"] = {"pass": tr["pass"], "ids": {k: {"steps_a": v["steps_a"], "steps_b": v["steps_b"],
                                                           "max_abs_err": v["max_abs_err"], "pass": v["pass"]}
                                                       for k, v in tr["ids"].items()}}
        result["reasons"] += [f"trace {r}" for r in tr["reasons"]]
    result["focus"] = {"pass": focus["pass"], "rows": len(focus["rows_a"])}
    if state.get("focusCheck") and not focus["pass"]:
        result["reasons"] += focus["reasons"]
    result["pass"] = not result["reasons"]
    (out_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


# ---------------------------------------------------------------- summary

def git_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short=12", "HEAD"], cwd=HERE, capture_output=True, text=True).stdout.strip() or "?"
    except OSError:
        return "?"


def write_summary(out: Path, env: dict, results: list[dict], args, started: str):
    rows = []
    for r in results:
        if r.get("skipped"):
            rows.append(f"| {r['component']} | {r['state']} | {r.get('run', '-')} | {r['impl']} | - | - | - | - | - | SKIP: {r['skipped']} |")
            continue
        tr = r.get("trace")
        tr_s = "-" if tr is None else ("ok" if tr["pass"] else "FAIL")
        masks = len(r.get("masks_applied", [])) + len(r.get("dither_regions", []))
        verdict = "PASS" if r["pass"] else "**FAIL**"
        rows.append(f"| {r['component']} | {r['state']} | {r['run']} | {r['impl']} | {r['differing_px']} | {r['off_edge_px']} | "
                    f"{r['diff_fraction']:.5f} | {r['max_delta']} | {tr_s} | {masks} | {verdict} |")
    n_pass = sum(1 for r in results if r.get("pass"))
    n_fail = sum(1 for r in results if not r.get("pass") and not r.get("skipped"))
    n_skip = sum(1 for r in results if r.get("skipped"))
    md = [f"# TV pixel diff — {started[:10]}", "",
          f"**{n_pass} pass · {n_fail} fail · {n_skip} skipped** — impl `{args.impl or '(per file)'}`, states `{','.join(args.states)}`, runs {args.runs}", "",
          "| field | value |", "|---|---|",
          f"| APK versionCode | {env.get('versionCode')} ({env.get('versionName')}) `{env.get('pkg')}` |",
          f"| commit | {env.get('commit')} |",
          f"| device | {env.get('model')} sdk {env.get('sdk')} `{env.get('fingerprint')}` |",
          f"| display mode | {env.get('display_mode')} · {env.get('wm_size')} · {env.get('wm_density')} |",
          f"| locale / tz | {env.get('locale')} / {env.get('timezone')} |",
          f"| animator / transition / window scale | {env.get('animator_duration_scale')} / {env.get('transition_animation_scale')} / {env.get('window_animation_scale')} · font {env.get('font_scale')} · screensaver {env.get('screensaver_enabled')} |",
          f"| receiver ping | {env.get('ping')} |",
          f"| server flags declared | {', '.join(args.server) or '(none)'} |",
          f"| started / finished | {started} / {dt.datetime.now().isoformat(timespec='seconds')} |",
          "",
          "## Results", "",
          "Rule: pixelmatch YIQ threshold 0.1; Sobel edge mask (>40/255, dilated 1 px); any differing pixel OFF the edge mask fails; "
          "ON-edge differing pixels must be <= 0.05 % of compared pixels; traces within 1e-3 x range per aligned step, step count +-1.", "",
          "| component | state | run | impl | differing px | off-edge px | on-edge frac | max Δ | trace | masks+dither | result |",
          "|---|---|---|---|---|---|---|---|---|---|---|", *rows, ""]
    waived = [r for r in results if r.get("masks_applied") or r.get("dither_regions")]
    md += ["## Masks and dither regions (what was not compared, or compared loosely)", ""]
    if not waived:
        md.append("none")
    for r in waived:
        for m in r.get("masks_applied", []):
            md.append(f"- {r['component']}/{r['state']}: mask {m['rect']} — {m.get('why', '')}")
        for d in r.get("dither_regions", []):
            md.append(f"- {r['component']}/{r['state']}: dither ±2/255 {d['rect']} — {d.get('why', '')}"
                      + (f" (forgave {r.get('dither_forgiven_px', 0)} px)" if r.get("dither_forgiven_px") else ""))
    fails = [r for r in results if not r.get("pass") and not r.get("skipped")]
    md += ["", "## Failures", ""]
    if not fails:
        md.append("none")
    for r in fails:
        md.append(f"- **{r['component']}/{r['state']}** run {r['run']}: " + "; ".join(r["reasons"])
                  + f" — see `{r['component']}/{r['state']}/triptych.png`")
    md += ["", "## Layout", "",
           "`<component>/<state>[/runN]/{A.png,B.png,D.png,triptych.png,result.json,A.logcat.txt,B.logcat.txt}`, "
           "`traces/<component>.<state>.json`, `env.json`, `summary.json`.", ""]
    (out / "summary.md").write_text("\n".join(md), encoding="utf-8")
    (out / "summary.json").write_text(json.dumps({"env": env, "args": vars(args), "results": results}, indent=1, default=str),
                                      encoding="utf-8")


# ---------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--serial", default="192.168.50.31:5555")
    ap.add_argument("--pkg", default="com.auroratv.lab")
    ap.add_argument("--impl", default=None, help="letters to flip =native on the B side (F C R H N G); default: each state file's own")
    ap.add_argument("--states", default="all", help="comma list of component names (focusable,card,row,hero,navrail,browse), 'all', or .json paths")
    ap.add_argument("--only", default="", help="comma list of state names to run (name or component/name)")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--out", default=None, help="default docs/qa/native-diff/<date>/ under the repo root")
    ap.add_argument("--adb", default=None)
    ap.add_argument("--token", default=os.environ.get("AURORA_QA_TOKEN"), help="QA token; default derived from the debug keystore")
    ap.add_argument("--keystore", default=None)
    ap.add_argument("--var", action="append", default=[], help="k=v for ${k} in state files (e.g. id1=tt9000001)")
    ap.add_argument("--server", action="append", default=[], help="server-side preconditions in effect (artDelay, artFail, aiMock, fixtureTrailer)")
    ap.add_argument("--launch-wait-ms", type=int, default=4000)
    ap.add_argument("--screenrecord", action="store_true", help="also save a 4 s screenrecord per side")
    ap.add_argument("--force-lock", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, touch nothing")
    ap.add_argument("--diff-only", action="store_true", help="re-diff the A/B captures already in --out")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    args.states = [s for s in args.states.split(",") if s]
    only = [s for s in args.only.split(",") if s]
    variables = dict(v.split("=", 1) for v in args.var)
    variables.setdefault("id1", "tt9000001")
    server_flags = set(args.server)

    states = load_states(args.states, variables, args.impl, only)
    if not states:
        print("no states selected")
        return 2
    repo_root = HERE.parent.parent
    out = Path(args.out) if args.out else repo_root / "docs" / "qa" / "native-diff" / dt.date.today().isoformat()
    started = dt.datetime.now().isoformat(timespec="seconds")

    for s in states:  # server preconditions
        need = {k for k, v in (s.get("server") or {}).items() if v}
        missing = need - server_flags
        if missing and not s.get("skip"):
            s["skip"] = f"needs the instance started with {', '.join(sorted(missing))} (declare --server <flag>)"

    if args.dry_run:
        print(f"out: {out}")
        for s in states:
            print(f"\n[{s['component']}/{s['name']}] impl {s['impl']}  " + (f"SKIP {s['skip']}" if s.get("skip") else ""))
            for side in ("A", "B"):
                spec = impl_spec(s["impl"], native=(side == "B"))
                fz = s.get("freeze") or {}
                traced = bool(s.get("trace")) or bool(fz.get("trace"))
                print(f"  {side}: qa impl '{spec}'; am force-stop; am start -W -n {args.pkg}/{adbmod.MAIN_ACTIVITY}"
                      f"{' -d ' + s['launch']['data'] if (s.get('launch') or {}).get('data') else ''}; wait {args.launch_wait_ms} ms;"
                      f" qa freeze {fz.get('freeze', 'on')}; qa trace {'on' if traced else 'off'}; qa focuslog {'on' if fz.get('focuslog', True) else 'off'};"
                      f" qa nav {s.get('nav')}; idle; logcat -c; keys {s.get('keys')} (gap {s.get('keyGapMs')} ms); settle {s.get('settleMs')} ms;"
                      f" idle {s['idle']}; screencap -> {side}.png; logcat -d")
            print(f"  diff: tolerance {s.get('tolerance')} masks {s.get('masks')} dither {[d.get('why') for d in s.get('dither', [])]}"
                  f" crop {s.get('crop')} trace {s.get('trace')}{' retarget' if s.get('retarget') else ''}")
        return 0

    out.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []
    env: dict = {"commit": git_commit(), "pkg": args.pkg}

    if args.diff_only:
        for s in states:
            for run_idx in range(1, args.runs + 1):
                d = out / s["component"] / s["name"] / (f"run{run_idx}" if args.runs > 1 else "")
                if not (d / "A.png").exists() or not (d / "B.png").exists():
                    results.append({"component": s["component"], "state": s["name"], "impl": s["impl"], "run": run_idx,
                                    "skipped": "no A/B capture in " + str(d)})
                    continue
                side = lambda n: {"side": n, "png": str(d / f"{n}.png"), "crop": s.get("crop") if isinstance(s.get("crop"), list) else None,
                                  "masks": [m for m in s.get("masks", []) if "rect" in m],
                                  "log": (d / f"{n}.logcat.txt").read_text(encoding="utf-8") if (d / f"{n}.logcat.txt").exists() else "",
                                  "idle": None}
                r = compare_state(s, side("A"), side("B"), d, run_idx)
                results.append(r)
                print(f"{'PASS' if r['pass'] else 'FAIL'}  {s['component']}/{s['name']}  diff={r['differing_px']} off={r['off_edge_px']}")
        try:
            env.update(json.loads((out / "env.json").read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
        write_summary(out, env, results, args, started)
        return 0 if all(r.get("pass") or r.get("skipped") for r in results) else 1

    # ---- the real thing
    try:
        adb_bin = adbmod.find_adb(args.adb)
        token = args.token or adbmod.debug_keystore_token(args.keystore)
    except AdbError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    dev = Adb(args.serial, args.pkg, token, adb_bin, verbose=args.verbose)
    try:
        with DeviceLock(HERE / adbmod.LOCK_NAME, args.serial, force=args.force_lock):
            dev.connect()
            env.update(dev.environment())
            ok, detail = dev.qa("ping")
            env["ping"] = detail if ok else f"err {detail}"
            env["token_source"] = "--token/env" if args.token else "debug keystore"
            (out / "env.json").write_text(json.dumps(env, indent=2), encoding="utf-8")
            print(f"device {env['model']} v{env['versionCode']} {env['display_mode']} · receiver {env['ping']}")
            if env.get("animator_duration_scale") not in ("1.0", "1"):
                print(f"warning: animator_duration_scale is {env.get('animator_duration_scale')} (02 §1 wants 1.0)")

            for s in states:
                for run_idx in range(1, args.runs + 1):
                    d = out / s["component"] / s["name"] / (f"run{run_idx}" if args.runs > 1 else "")
                    d.mkdir(parents=True, exist_ok=True)
                    if s.get("skip"):
                        results.append({"component": s["component"], "state": s["name"], "impl": s["impl"], "run": run_idx, "skipped": s["skip"]})
                        print(f"SKIP  {s['component']}/{s['name']}: {s['skip']}")
                        continue
                    print(f"----  {s['component']}/{s['name']} (impl {s['impl']}, run {run_idx})")
                    try:
                        a = capture_side(dev, s, "A", d, args)
                        b = capture_side(dev, s, "B", d, args)
                        r = compare_state(s, a, b, d, run_idx)
                    except AdbError as e:
                        r = {"component": s["component"], "state": s["name"], "impl": s["impl"], "run": run_idx, "pass": False,
                             "differing_px": -1, "off_edge_px": -1, "diff_fraction": 0.0, "max_delta": -1, "reasons": [f"harness error: {e}"]}
                        (d / "result.json").write_text(json.dumps(r, indent=2), encoding="utf-8")
                    results.append(r)
                    print(f"{'PASS' if r['pass'] else 'FAIL'}  {s['component']}/{s['name']}  diff={r['differing_px']} off={r['off_edge_px']}"
                          + (f"  trace={'ok' if r['trace']['pass'] else 'FAIL'}" if r.get("trace") else "")
                          + ("" if r["pass"] else "  " + "; ".join(r["reasons"])))
            # leave the box as found: all js, nothing frozen or traced; stay-awake untouched (elia's rule)
            try:
                dev.qa("freeze", "off"); dev.qa("trace", "off"); dev.qa("focuslog", "off")
                dev.qa("impl", impl_spec("", native=False))
            except AdbError:
                pass
    except AdbError as e:
        print(f"error: {e}", file=sys.stderr)
        write_summary(out, env, results, args, started)
        return 2
    write_summary(out, env, results, args, started)
    n_fail = sum(1 for r in results if not r.get("pass") and not r.get("skipped"))
    print(f"\n{len(results) - n_fail} ok, {n_fail} failed -> {out / 'summary.md'}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
