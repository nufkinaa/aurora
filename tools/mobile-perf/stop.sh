#!/usr/bin/env bash
# Stop by-hand harness instances (never anything else): node processes whose
# command line names tools/mobile-perf's instance.js.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'instance\.js' -and \$_.CommandLine -notmatch 'ui-instance' } | ForEach-Object { taskkill /PID \$_.ProcessId /T /F | Out-Null; \$_.ProcessId }"
