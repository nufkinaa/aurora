@echo off
rem Start the Aurora media server under its keeper: the keeper starts the
rem server, starts it again when it crashes or hangs, and keeps the log in
rem dataserver-stdout.log / dataserver-stderr.log. Stop Aurora by closing
rem this window or pressing CTRL-C here.
rem
rem To have it start with Windows and survive a reboot, install the Scheduled
rem Task once (docsoperations.md):
rem     powershell -ExecutionPolicy Bypass -File deploywindowsinstall-keeper-task.ps1
rem
rem   start-aurora.cmd          the server under the keeper (recommended)
rem   start-aurora.cmd --bare   the server alone, as before: nothing restarts it
rem
rem Optional: set the AURORA_NODE environment variable to a specific node.exe
rem to pin a Node version (e.g. `setx AURORA_NODE C:
ode20
ode.exe`);
rem otherwise the system node is used.
cd /d "%~dp0"
set "AURORA_ENTRY=scriptskeeper.js"
if /i "%~1"=="--bare" set "AURORA_ENTRY=server.js"
if defined AURORA_NODE if exist "%AURORA_NODE%" (
  "%AURORA_NODE%" %AURORA_ENTRY%
  goto :eof
)
node %AURORA_ENTRY%
