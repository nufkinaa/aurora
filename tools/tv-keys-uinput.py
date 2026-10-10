#!/usr/bin/env python3
"""Real key presses on the TV: a virtual remote made with Android's `uinput` shell tool.

`adb shell input keyevent` injects a key-down and its key-up in the same millisecond. A person
holds a key for 60-250 ms, and react-native-tvos only tells JS about the key-UP - so what the
app's JS key handlers see depends on how long the key was held. This prints a `uinput` script
(one JSON command per line) for a sequence of presses with real down/up timing:

    python tools/tv-keys-uinput.py "DOWN:80 w1200 UP:120 w1500" [--repeat N] | adb shell uinput -

  KEY:hold_ms   press KEY (UP DOWN LEFT RIGHT CENTER BACK), release after hold_ms
  wN            wait N ms
The device exists only while the command runs. Needs no root (the shell user is in group uhid).
"""
import json, sys
KEYS = {'UP': 103, 'DOWN': 108, 'LEFT': 105, 'RIGHT': 106, 'CENTER': 353, 'BACK': 158}
def main():
    args = sys.argv[1:]
    rep = 1
    if '--repeat' in args:
        i = args.index('--repeat'); rep = int(args[i + 1]); del args[i:i + 2]
    seq = ' '.join(args).split()
    out = [{'id': 1, 'command': 'register', 'name': 'aurora-qa-remote', 'vid': 4660, 'pid': 22136, 'bus': 'usb',
            'configuration': [{'type': 100, 'data': [1]}, {'type': 101, 'data': sorted(KEYS.values())}]},
           {'id': 1, 'command': 'delay', 'duration': 2500}]
    for _ in range(rep):
        for tok in seq:
            if tok[0] == 'w' and tok[1:].isdigit():
                out.append({'id': 1, 'command': 'delay', 'duration': int(tok[1:])})
                continue
            k, _, hold = tok.partition(':')
            code = KEYS[k.upper()]
            out.append({'id': 1, 'command': 'inject', 'events': [1, code, 1, 0, 0, 0]})
            out.append({'id': 1, 'command': 'delay', 'duration': int(hold or 80)})
            out.append({'id': 1, 'command': 'inject', 'events': [1, code, 0, 0, 0, 0]})
    out.append({'id': 1, 'command': 'delay', 'duration': 300})
    sys.stdout.write('\n'.join(json.dumps(o) for o in out) + '\n')
main()
