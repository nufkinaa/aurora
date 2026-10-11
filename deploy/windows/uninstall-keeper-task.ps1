# Remove the Scheduled Task that starts Aurora's keeper (run elevated).
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-keeper-task.ps1
#
# Aurora is stopped cleanly first (stores saved, viewers told). Nothing else
# is touched: data\, the logs and start-aurora.cmd stay as they are.
param([string]$TaskName = "Aurora")
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Host "There is no '$TaskName' task."; exit 0 }

Push-Location $root
try { & node scripts\keeper.js --stop } catch { Write-Host "The keeper could not be asked to stop: $_" } finally { Pop-Location }

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed the '$TaskName' task. Start Aurora by hand with start-aurora.cmd."
