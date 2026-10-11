@echo off
rem Start the Aurora media server under its keeper: the keeper starts the
rem server, starts it again when it crashes or hangs, and keeps the log in
rem data\server-stdout.log / data\server-stderr.log. Stop Aurora by closing
rem this window or pressing CTRL-C here.
rem
rem To have it start with Windows and survive a reboot, install the Scheduled
rem Task once (docs\operations.md):
rem     powershell -ExecutionPolicy Bypass -File deploy\windows\install-keeper-task.ps1
rem
rem   start-aurora.cmd          the server under the keeper (recommended)
rem   start-aurora.cmd --bare   the server alone, as before: nothing restarts it
rem
rem Optional: set the AURORA_NODE environment variable to a specific node.exe
rem to pin a Node version (e.g. `setx AURORA_NODE C:\node20\node.exe`);
rem otherwise the system node is used.
cd /d "%~dp0"
set "AURORA_ENTRY=scripts\keeper.js"
if /i "%~1"=="--bare" set "AURORA_ENTRY=server.js"
if defined AURORA_NODE if exist "%AURORA_NODE%" (
  "%AURORA_NODE%" %AURORA_ENTRY%
  goto :eof
)
node %AURORA_ENTRY%
