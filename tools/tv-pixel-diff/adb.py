#!/usr/bin/env python3
"""Thin adb wrappers for the TV pixel-diff harness, plus the QA broadcast protocol
(see PROTOCOL.md — this file is its reference implementation).

Nothing here is clever: every function is one adb invocation. `Adb` holds the serial,
the package, the QA token and the adb binary path.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

QA_ACTION = "com.auroratv.QA"
QA_RECEIVER = "com.auroratv.ui.qa.QaReceiver"
MAIN_ACTIVITY = "com.auroratv.MainActivity"
TAG_QA = "AuroraQA"          # [qa] result lines (PROTOCOL.md §2)
TAG_QA_LEGACY = "AuroraQa"   # 02 §2's spelling; read, never written
TAG_ANIM = "AuroraAnim"      # [anim] [key] [focus] [ring] lines (PROTOCOL.md §4)
IMPL_KEYS = {"F": "focusable", "C": "card", "R": "row", "H": "hero", "N": "rail", "G": "grid"}
LOCK_NAME = ".device.lock"

_RESULT = re.compile(r"\[qa\]\s+(\S+)\s+(ok|err)(?:\s+rid=(\S+))?\s*(.*)")


class AdbError(RuntimeError):
    pass


def find_adb(explicit: str | None = None) -> str:
    for cand in (explicit, os.environ.get("ADB"), shutil.which("adb"),
                 os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk", "platform-tools", "adb.exe"),
                 os.path.join(os.environ.get("ANDROID_HOME", ""), "platform-tools", "adb.exe"),
                 os.path.join(os.environ.get("ANDROID_HOME", ""), "platform-tools", "adb"),
                 "/usr/bin/adb", "/usr/local/bin/adb"):
        if cand and os.path.isfile(cand):
            return cand
    raise AdbError("adb not found: pass --adb, set ADB, or put platform-tools on PATH")


def impl_spec(letters: str, native: bool) -> str:
    """'FC' -> 'focusable=native,card=native,row=js,hero=js,rail=js,grid=js' (native=True),
    or all '=js' (native=False, the A side)."""
    want = set()
    for ch in letters.upper():
        if ch == "-" or not ch.strip():
            continue
        if ch not in IMPL_KEYS:
            raise ValueError(f"unknown impl letter {ch!r}; known: {''.join(IMPL_KEYS)}")
        want.add(ch)
    return ",".join(f"{k}={'native' if (native and L in want) else 'js'}" for L, k in IMPL_KEYS.items())


def debug_keystore_token(keystore: str | None = None, keytool: str | None = None) -> str:
    """token = sha256( lower-hex(sha256 cert fingerprint) ) from the debug keystore (PROTOCOL.md §1)."""
    repo_ks = Path(__file__).resolve().parent.parent.parent / "tv-native" / "android" / "app" / "debug.keystore"
    ks = keystore or (str(repo_ks) if repo_ks.is_file() else os.path.join(os.path.expanduser("~"), ".android", "debug.keystore"))
    kt = keytool or shutil.which("keytool")
    if not kt:
        java_home = os.environ.get("JAVA_HOME", "")
        for cand in (os.path.join(java_home, "bin", "keytool.exe"), os.path.join(java_home, "bin", "keytool")):
            if os.path.isfile(cand):
                kt = cand
                break
    if not kt:
        raise AdbError("keytool not found (JDK); pass --token instead")
    if not os.path.isfile(ks):
        raise AdbError(f"debug keystore not found at {ks}; pass --keystore or --token")
    out = subprocess.run([kt, "-list", "-v", "-keystore", ks, "-storepass", "android", "-alias", "androiddebugkey"],
                         capture_output=True, text=True)
    m = re.search(r"SHA256:\s*([0-9A-Fa-f:]{95})", out.stdout + out.stderr)
    if not m:
        raise AdbError("could not read the SHA256 fingerprint from keytool output")
    return token_from_fingerprint(m.group(1))


def token_from_fingerprint(fp: str) -> str:
    hexfp = fp.replace(":", "").lower()
    return hashlib.sha256(hexfp.encode("ascii")).hexdigest()


# ---------------------------------------------------------------- the device lock

def _pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class DeviceLock:
    """tools/tv-pixel-diff/.device.lock with the PID and start time; refuses to run while
    another live process holds it (02 §0: the Mi TV is shared)."""

    def __init__(self, path: Path, serial: str, force: bool = False):
        self.path, self.serial, self.force = path, serial, force

    def __enter__(self):
        if self.path.exists():
            try:
                held = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                held = {}
            pid = int(held.get("pid", 0) or 0)
            if pid and _pid_alive(pid) and not self.force:
                raise AdbError(f"device lock held by pid {pid} since {held.get('started')} "
                               f"({held.get('serial')}); wait, or --force-lock if that process is dead")
        self.path.write_text(json.dumps({"pid": os.getpid(), "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                         "serial": self.serial, "host": socket.gethostname()}, indent=2),
                             encoding="utf-8")
        return self

    def __exit__(self, *exc):
        try:
            self.path.unlink()
        except OSError:
            pass
        return False


# ---------------------------------------------------------------- adb

@dataclass
class Adb:
    serial: str
    pkg: str = "com.auroratv.lab"
    token: str = ""
    adb: str = "adb"
    verbose: bool = False
    _rid: int = 0

    # -- plumbing
    def run(self, *args: str, timeout: float = 30, check: bool = True, binary: bool = False):
        cmd = [self.adb, "-s", self.serial, *args]
        if self.verbose:
            print("  $", " ".join(cmd), file=sys.stderr)
        # adb over the network drops now and then ("error: closed", or a call that never
        # returns — both seen 2026-10-10, each killed or failed a state): reconnect and try
        # the call once more; a second failure is an AdbError (the state fails, the run goes on)
        for attempt in (1, 2):
            try:
                p = subprocess.run(cmd, capture_output=True, timeout=timeout)
            except subprocess.TimeoutExpired:
                p = None
            if p is not None and not (p.returncode != 0 and b"error: closed" in p.stderr):
                break
            if attempt == 1:
                subprocess.run([self.adb, "connect", self.serial], capture_output=True, timeout=20)
                time.sleep(1)
        if p is None:
            raise AdbError(f"adb {' '.join(args[:3])}… timed out after {timeout:g} s (twice)")
        if check and p.returncode != 0:
            raise AdbError(f"adb {' '.join(args[:3])}… failed ({p.returncode}): {p.stderr.decode('utf-8', 'replace').strip()}")
        return p.stdout if binary else p.stdout.decode("utf-8", "replace")

    def shell(self, cmd: str, timeout: float = 30, check: bool = True) -> str:
        return self.run("shell", cmd, timeout=timeout, check=check)

    def connect(self) -> str:
        """`adb connect` for a tcp serial; a no-op for usb serials."""
        if ":" in self.serial:
            out = subprocess.run([self.adb, "connect", self.serial], capture_output=True, text=True, timeout=20).stdout
            if "connected" not in out and "already" not in out:
                raise AdbError(f"adb connect {self.serial}: {out.strip()}")
        state = subprocess.run([self.adb, "-s", self.serial, "get-state"], capture_output=True, text=True, timeout=20)
        if state.stdout.strip() != "device":
            raise AdbError(f"{self.serial} is not 'device': {state.stdout.strip() or state.stderr.strip()}")
        return state.stdout.strip()

    def getprop(self, key: str) -> str:
        return self.shell(f"getprop {key}").strip()

    # -- capture
    def screencap(self, path: str | Path) -> Path:
        data = self.run("exec-out", "screencap", "-p", timeout=60, binary=True)
        if not data.startswith(b"\x89PNG"):
            raise AdbError(f"screencap returned {len(data)} bytes that are not a PNG")
        path = Path(path)
        path.write_bytes(data)
        return path

    def screenrecord(self, remote: str, seconds: int = 4, bitrate: int = 8_000_000) -> subprocess.Popen:
        """Starts `screenrecord` in the background; the caller pulls `remote` after it ends."""
        return subprocess.Popen([self.adb, "-s", self.serial, "shell",
                                 f"screenrecord --time-limit {seconds} --bit-rate {bitrate} {remote}"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def pull(self, remote: str, local: str | Path):
        self.run("pull", remote, str(local), timeout=120)

    # -- logcat
    def logcat_clear(self):
        self.run("logcat", "-c", check=False)

    def logcat_dump(self, *tags: str) -> str:
        """`logcat -d -s tag:V …` (default: the QA and anim tags, both spellings)."""
        tags = tags or (TAG_QA, TAG_QA_LEGACY, TAG_ANIM)
        return self.run("logcat", "-d", "-v", "time", "-s", *[f"{t}:V" for t in tags], timeout=30)

    # -- gfxinfo
    def gfx_total_frames(self) -> int | None:
        out = self.shell(f"dumpsys gfxinfo {self.pkg}", check=False)
        m = re.search(r"Total frames rendered:\s*(\d+)", out)
        return int(m.group(1)) if m else None

    def gfx_reset(self):
        self.shell(f"dumpsys gfxinfo {self.pkg} reset", check=False)

    def gfx_framestats(self) -> str:
        return self.shell(f"dumpsys gfxinfo {self.pkg} framestats", check=False)

    # -- app lifecycle
    def force_stop(self):
        self.shell(f"am force-stop {self.pkg}")

    def start(self, data: str | None = None, extras: dict | None = None):
        cmd = f"am start -W -n {self.pkg}/{MAIN_ACTIVITY}"
        if data:
            cmd += f" -d '{data}'"
        for k, v in (extras or {}).items():
            if isinstance(v, bool):
                cmd += f" --ez {k} {'true' if v else 'false'}"
            elif isinstance(v, int):
                cmd += f" --ei {k} {v}"
            else:
                cmd += f" --es {k} '{v}'"
        return self.shell(cmd, timeout=60)

    def restart(self, data: str | None = None, extras: dict | None = None):
        self.force_stop()
        time.sleep(0.5)
        return self.start(data, extras)

    def keyevent(self, name: str):
        self.shell(f"input keyevent KEYCODE_{name}")

    def key_burst(self, name: str, n: int, gap_ms: int):
        """N presses gap_ms apart from ONE shell loop (an adb round trip per press would be
        slower than any repeat rate; 02 §4.1 accepts the approximation — the [key] lines
        record the true arrival times)."""
        gap = max(0, gap_ms) / 1000.0
        self.shell(f"i=0; while [ $i -lt {n} ]; do input keyevent KEYCODE_{name}; sleep {gap:.3f}; i=$((i+1)); done",
                   timeout=30 + n * 0.5)

    # -- environment record (02 §1)
    def environment(self) -> dict:
        env = {
            "serial": self.serial,
            "pkg": self.pkg,
            "fingerprint": self.getprop("ro.build.fingerprint"),
            "model": self.getprop("ro.product.model"),
            "sdk": self.getprop("ro.build.version.sdk"),
            "locale": self.getprop("persist.sys.locale") or self.getprop("ro.product.locale"),
            "timezone": self.getprop("persist.sys.timezone"),
            "animator_duration_scale": self.shell("settings get global animator_duration_scale").strip(),
            "transition_animation_scale": self.shell("settings get global transition_animation_scale").strip(),
            "window_animation_scale": self.shell("settings get global window_animation_scale").strip(),
            "font_scale": self.shell("settings get system font_scale").strip(),
            "screensaver_enabled": self.shell("settings get secure screensaver_enabled").strip(),
            "wm_size": self.shell("wm size").strip(),
            "wm_density": self.shell("wm density").strip(),
        }
        sf = self.shell("dumpsys SurfaceFlinger", check=False, timeout=60)
        m = re.search(r"active mode[^\n]*", sf, re.I) or re.search(r"[^\n]*mActiveMode[^\n]*", self.shell("dumpsys display", check=False, timeout=60))
        env["display_mode"] = m.group(0).strip() if m else "(not found)"
        pkg = self.shell(f"dumpsys package {self.pkg}", check=False, timeout=60)
        m = re.search(r"versionCode=(\d+)", pkg)
        env["versionCode"] = int(m.group(1)) if m else None
        m = re.search(r"versionName=(\S+)", pkg)
        env["versionName"] = m.group(1) if m else None
        return env

    # -- the QA broadcast (PROTOCOL.md)
    def qa(self, cmd: str, arg: str = "", timeout: float = 3.0, poll: float = 0.15) -> tuple[bool, str]:
        """Sends one com.auroratv.QA broadcast and waits for its `[qa] <cmd> ok|err` line.
        Returns (ok, detail). Raises AdbError on timeout (no line at all = wrong token,
        adb_enabled 0, or the receiver is not in this build)."""
        if not self.token:
            raise AdbError("no QA token: pass --token or let --keystore derive it")
        self._rid += 1
        rid = f"{os.getpid()}-{self._rid}"
        self.logcat_clear()
        am = (f"am broadcast -n {self.pkg}/{QA_RECEIVER} -a {QA_ACTION} --es token {self.token} "
              f"--es cmd {cmd} --es rid {rid}")
        if arg:
            am += f" --es arg '{arg}'"
        self.shell(am, timeout=15)
        deadline = time.monotonic() + timeout
        last_unriddled = None
        while time.monotonic() < deadline:
            for line in self.logcat_dump(TAG_QA, TAG_QA_LEGACY).splitlines():
                m = _RESULT.search(line)
                if not m or m.group(1) != cmd:
                    continue
                if m.group(3) == rid:
                    return m.group(2) == "ok", m.group(4).strip()
                if m.group(3) is None:
                    last_unriddled = (m.group(2) == "ok", m.group(4).strip())
            if last_unriddled:
                return last_unriddled
            time.sleep(poll)
        raise AdbError(f"no [qa] {cmd} answer within {timeout}s (token? adb_enabled? receiver in this build?)")

    def qa_expect(self, cmd: str, arg: str = "") -> str:
        ok, detail = self.qa(cmd, arg)
        if not ok:
            raise AdbError(f"[qa] {cmd} {arg!r} -> err {detail}")
        return detail

    def layout(self, native_id: str) -> tuple[int, int, int, int] | None:
        ok, detail = self.qa("layout", native_id)
        if not ok:
            return None
        kv = dict(p.split("=", 1) for p in detail.split() if "=" in p)
        try:
            return int(kv["x"]), int(kv["y"]), int(kv["w"]), int(kv["h"])
        except (KeyError, ValueError):
            return None
