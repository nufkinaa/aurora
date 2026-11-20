# Drive the phone app on the QA emulator (emulator-5554 ONLY) for the glass
# sweep's device pass: tap by label, photograph, read bounds, measure a scroll.
#   python tools/real-glass-app/dev.py tap "More"            tap the node whose text / content-desc is (or starts with) this
#   python tools/real-glass-app/dev.py shot <file.png>        adb screencap
#   python tools/real-glass-app/dev.py nodes [filter]         label + bounds of every labelled node
#   python tools/real-glass-app/dev.py fling <n> [y1 y2 x1 x2]  reset gfxinfo, n up-flings (and back), print the frame numbers
import os
import re
import subprocess
import sys
import time

SERIAL = 'emulator-5554'
ADB = os.environ.get('ADB', 'C:/elia/android-tools/sdk/platform-tools/adb.exe')
PKG = 'com.aurora.phone'


def adb(*args, timeout=60, binary=False):
    r = subprocess.run([ADB, '-s', SERIAL, *args], capture_output=True, timeout=timeout)
    return r.stdout if binary else r.stdout.decode('utf-8', 'replace')


def nodes():
    xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty')
    out = []
    for m in re.finditer(r'<node [^>]*>', xml):
        tag = m.group(0)
        g = lambda k: (re.search(k + r'="([^"]*)"', tag) or [None, ''])[1]
        b = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', g('bounds'))
        if not b:
            continue
        out.append({'text': g('text'), 'desc': g('content-desc'), 'cls': g('class').split('.')[-1], 'click': g('clickable') == 'true', 'b': tuple(int(x) for x in b.groups())})
    return out


def find(label, ns=None):
    ns = ns or nodes()
    for exact in (True, False):
        for n in ns:
            for v in (n['desc'], n['text']):
                if v and (v == label if exact else v.startswith(label)):
                    return n
    return None


def tap(label):
    n = find(label)
    if not n:
        print('NOT FOUND', label)
        return False
    x0, y0, x1, y1 = n['b']
    adb('shell', 'input', 'tap', str((x0 + x1) // 2), str((y0 + y1) // 2))
    return True


def gfx():
    t = adb('shell', 'dumpsys', 'gfxinfo', PKG)
    pick = lambda k: (re.search(k + r':\s*([\d.]+)', t) or [None, '?'])[1]
    total = pick('Total frames rendered')
    janky = re.search(r'Janky frames: (\d+) \(([\d.]+)%\)', t)
    # the mean frame time from the histogram (bucket ms = count)
    h = re.search(r'HISTOGRAM:([^\n]*)', t)
    pairs = [(int(a), int(b)) for a, b in re.findall(r'(\d+)ms=(\d+)', h.group(1))] if h else []
    n = sum(c for _, c in pairs)
    mean = '%.1f' % (sum(ms * c for ms, c in pairs) / n) if n else '?'
    return {'frames': total, 'janky%': janky.group(2) if janky else '?', 'mean': mean, 'p50': pick('50th percentile'), 'p90': pick('90th percentile'), 'p95': pick('95th percentile'), 'p99': pick('99th percentile')}


def fling(n, y1=1900, y2=700, x1=540, x2=540):
    adb('shell', 'dumpsys', 'gfxinfo', PKG, 'reset')
    for _ in range(n):
        adb('shell', 'input', 'swipe', str(x1), str(y1), str(x2), str(y2), '160')
        time.sleep(1.1)
    for _ in range(n):
        adb('shell', 'input', 'swipe', str(x2), str(y2), str(x1), str(y1), '160')
        time.sleep(1.1)
    return gfx()


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'tap':
        sys.exit(0 if tap(sys.argv[2]) else 1)
    elif cmd == 'shot':
        open(sys.argv[2], 'wb').write(adb('exec-out', 'screencap', '-p', binary=True))
    elif cmd == 'nodes':
        flt = sys.argv[2] if len(sys.argv) > 2 else ''
        for n in nodes():
            label = n['desc'] or n['text']
            if (label or n['click']) and flt.lower() in label.lower():
                x0, y0, x1, y1 = n['b']
                print('%-52s %s %dx%d %s' % (label[:52].encode('ascii', 'replace').decode(), n['b'], x1 - x0, y1 - y0, 'click' if n['click'] else ''))
    elif cmd == 'fling':
        a = [int(x) for x in sys.argv[3:7]]
        print(fling(int(sys.argv[2]), *a))
