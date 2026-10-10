# Install the Scheduled Task that starts Aurora's keeper with Windows.
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-keeper-task.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-keeper-task.ps1 -When Startup
#
# Run it from an ELEVATED PowerShell (right-click > Run as administrator):
# Windows only lets an administrator create a task with a logon or boot
# trigger. Nothing else is installed - no service, no pm2, no extra program.
#
# -When Logon    (default) the keeper starts when YOU log in, exactly like the
#                shortcut in shell:startup did. Network drives and everything
#                else your session has are there. After a power cut the server
#                is back once you (or Windows auto-logon) sign in.
# -When Startup  the keeper starts when Windows boots, before anyone signs in
#                and without a stored password. Use this when the library is on
#                local disks: mapped network drives are NOT available this way.
#
# What the task does: runs `node scripts\keeper.js --host task --quiet` in the
# Aurora folder with no window. The keeper starts the server, restarts it when
# it crashes or hangs, and writes data\server-stdout.log / server-stderr.log.
# If the keeper itself is ever killed, Task Scheduler starts it again within a
# minute.
#
# Afterwards:
#   Start-ScheduledTask Aurora            start it now
#   node scripts\keeper.js --status       what the keeper has seen
#   node scripts\keeper.js --stop         stop Aurora cleanly (stores saved)
#   deploy\windows\uninstall-keeper-task.ps1
param(
  [ValidateSet("Logon", "Startup")] [string]$When = "Logon",
  [string]$TaskName = "Aurora",
  [string]$Node = $env:AURORA_NODE
)
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not (Test-Path (Join-Path $root "scripts\keeper.js"))) { throw "scripts\keeper.js was not found under $root" }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Run this from an elevated PowerShell (Run as administrator): Windows requires it for a logon or startup task." }

if (-not $Node -or -not (Test-Path $Node)) { $Node = (Get-Command node -ErrorAction Stop).Source }
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name

# conhost --headless: the keeper gets a console (CTRL-C semantics, child
# output) and nobody gets a window.
$action = New-ScheduledTaskAction -Execute $conhost -Argument ("--headless `"{0}`" scripts\keeper.js --host task --quiet" -f $Node) -WorkingDirectory $root

if ($When -eq "Startup") {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  # S4U: runs whether or not the user is signed in, no password stored.
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
}

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force `
  -Description "Aurora media server, kept alive by its keeper (scripts\keeper.js). Stop it with: node scripts\keeper.js --stop" | Out-Null

Write-Host "Installed the '$TaskName' task: the keeper starts at $($When.ToLower()) as $me."
Write-Host "  node:    $Node"
Write-Host "  folder:  $root"

# The old way of starting with Windows would now start a second keeper (it
# notices and leaves, but it is noise): point it out.
$startup = [Environment]::GetFolderPath("Startup")
$old = Get-ChildItem $startup -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object {
  try { (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName).TargetPath -like "*start-aurora.cmd" } catch { $false }
}
if ($old) { Write-Host "NOTE: remove the old startup shortcut, the task replaces it: $($old.FullName -join ', ')" }

Write-Host ""
Write-Host "Aurora is NOT started by this script. When the server that is running now can be interrupted:"
Write-Host "  1. stop it (close its window, or CTRL-C)"
Write-Host "  2. Start-ScheduledTask $TaskName"
Write-Host "  3. node scripts\keeper.js --status"
