@echo off
rem Start the Aurora media server (drop a shortcut to this file into
rem shell:startup to launch it with Windows).
rem
rem Optional: set the AURORA_NODE environment variable to a specific node.exe
rem to pin a Node version (e.g. `setx AURORA_NODE C:\node20\node.exe`);
rem otherwise the system node is used.
cd /d "%~dp0"
if defined AURORA_NODE if exist "%AURORA_NODE%" (
  "%AURORA_NODE%" server.js
  goto :eof
)
node server.js
