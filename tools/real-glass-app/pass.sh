#!/usr/bin/env bash
# One device pass over the phone app's glass panes on the QA emulator
# (emulator-5554 only; the app already installed, `adb reverse tcp:4000` set to
# tools/real-glass-app/qa-server.js): photographs, node bounds and scroll frame
# numbers of every screen the glass sweep touched, into <out>/.
#   bash tools/real-glass-app/pass.sh <out folder>
# The same steps for "today" and for the new build, so the two can be laid
# side by side (sheets2.py) and their bounds diffed.
set -u
O="${1:?out folder}"; mkdir -p "$O"
HERE="$(cd "$(dirname "$0")" && pwd)"
D="python $HERE/dev.py"
A="timeout 30 ${ADB:-C:/elia/android-tools/sdk/platform-tools/adb.exe} -s emulator-5554"
shot() { $D shot "$O/$1.png"; $D nodes > "$O/$1.txt"; }
runs() { for i in 1 2 3; do $D fling 5 "${@:2}" | tee -a "$O/gfx-$1.txt"; sleep 1; done; }

$A shell input tap 540 60                      # a touch first: after key input the window shows a focus highlight on the first tab
$A shell am force-stop com.aurora.phone
$A shell monkey -p com.aurora.phone -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
sleep 14
shot home

$A shell input tap 460 2300; sleep 4          # Shows (chips, a search field)
shot shows
$D tap "Paper Harbor"; sleep 6
$A shell input swipe 540 1900 540 900 500; sleep 2
$A shell input swipe 540 1900 540 1100 800; sleep 2
shot episodes
runs episodes 1500 1500 950 150               # the episode cards' rail
shot episodes-after
$A shell input swipe 540 900 540 1800 600; sleep 2
$D tap "My List"; sleep 0.8
$D shot "$O/toast.png"; sleep 5
$D tap Recommend; sleep 2.5
shot sheet
$D tap Cancel; sleep 2
$D tap "My List"; sleep 5                     # (back as it was)

$A shell input tap 790 2300; sleep 2.5        # More
shot more
$D tap "Calendar, What"; sleep 5
$D tap Month; sleep 3
shot calendar-month
$A shell input swipe 540 1900 540 900 800; sleep 2
shot calendar-day
$A shell input swipe 540 900 540 1900 300; sleep 0.6
$A shell input swipe 540 900 540 1900 300; sleep 1.5
$D tap List; sleep 3
shot calendar-list
runs calendar-list
$A shell input swipe 540 900 540 1900 200; sleep 2
$D tap Month; sleep 2

$A shell input tap 790 2300; sleep 2.5
$D tap "My downloads, What"; sleep 5
shot downloads
runs downloads
$A shell input swipe 540 1900 540 1500 600; sleep 2
shot downloads-mid
$A shell input swipe 540 900 540 1900 200; sleep 1   # back up: the tab bar hides while a page is scrolled down
$A shell input swipe 540 900 540 1900 200; sleep 2

$A shell input tap 955 2297; sleep 3          # Search
$A shell input tap 500 448; sleep 1.5
$A shell input text "pa"; sleep 5
shot search

# + the full glass (2026-11-20): the profile menu, Settings' panes, a text field, the Remote
$A shell input keyevent 4; sleep 1                   # the keyboard down
$A shell input tap 129 2300; sleep 4                 # Home
$A shell input tap 986 202; sleep 3                  # the profile menu
shot profile-menu
$A shell input keyevent 4; sleep 2
$A shell input tap 852 202; sleep 4                  # Settings
shot settings
$D tap "Edit profile"; sleep 4
shot edit-profile
$A shell input keyevent 4; sleep 2
$A shell input keyevent 4; sleep 2
$A shell input tap 790 2300; sleep 2.5               # More
$D tap "Your TVs, This"; sleep 5
$D shot "$O/remote.png"
$A shell input tap 996 220; sleep 3                  # the Remote's More sheet
$D shot "$O/remote-sheet.png"
$A shell input keyevent 4; sleep 2
$A shell input keyevent 4; sleep 2
$A shell input tap 540 60
echo done
