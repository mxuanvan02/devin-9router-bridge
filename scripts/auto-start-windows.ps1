# Auto-start: Windows

# Run this in PowerShell as the current user (no admin needed)

param(
    [string]$InstallDir = "$env:USERPROFILE\.devin-9router-bridge",
    [string]$NodeBin = "node"
)

$ErrorActionPreference = "Stop"

# Configurable ports (override via environment variables)
$glmProxyPort = if ($env:GLM_PROXY_PORT) { $env:GLM_PROXY_PORT } else { "20130" }
$routerPort = if ($env:ROUTER_PORT) { $env:ROUTER_PORT } else { "20128" }
$windsurfPort = if ($env:WINDSURF_PORT) { $env:WINDSURF_PORT } else { "8083" }

$TaskName = "Devin9RouterBridge-glm-proxy"
$LogDir = "$env:USERPROFILE\.devin-9router-bridge\logs"
$LogFile = "$LogDir\glm-proxy.log"
$ErrFile = "$LogDir\glm-proxy.error.log"

New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.devin-9router-bridge\logs" | Out-Null

# Remove existing task if present
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Create scheduled task that runs at logon and stays running
$Action = New-ScheduledTaskAction `
    -Execute $NodeBin `
    -Argument "`"$InstallDir\glm-proxy.js`" $glmProxyPort $routerPort"

$Trigger = New-ScheduledTaskTrigger -AtLogOn

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365)

$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Devin 9Router Bridge — glm-proxy (Anthropic to GLM-5.2 tool-call bridge)" | Out-Null

# Start it now
Start-ScheduledTask -TaskName $TaskName

Write-Host "x Auto-start configured (Windows Task Scheduler)" -ForegroundColor Green
Write-Host "  Task: $TaskName"
Write-Host "  Log:  $LogFile"
Write-Host ""
Write-Host "To stop:  Stop-ScheduledTask -TaskName '$TaskName'"
Write-Host "To start: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "To check: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "To remove: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
