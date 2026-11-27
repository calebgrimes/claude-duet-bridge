#!/usr/bin/env pwsh
# install.ps1: keep the Duet Bridge runner on with a scheduled task (it starts at sign-in and
# restarts if it stops). Safe to run again. No administrator rights needed: the task is
# registered for you alone.
#   .\install.ps1            install and start
#   .\install.ps1 uninstall  stop and remove
#
# The task runs as you, interactively, which is what lets open_on_mac put a terminal
# window on your desktop. A task running as a service could not.

param([string]$Command = 'install')

$ErrorActionPreference = 'Stop'

$Here = $PSScriptRoot
$Repo = Split-Path $Here -Parent
$Runner = Join-Path (Join-Path $Repo 'mac') 'duet-bridge.py'
$TaskName = 'DuetBridgeServe'

function Fail([string]$message) {
    Write-Host "ERROR: $message" -ForegroundColor Red
    exit 1
}

function Note([string]$message) { Write-Host "  $message" -ForegroundColor DarkGray }
function Good([string]$message) { Write-Host "OK  $message" -ForegroundColor Green }

if ($Command -eq 'uninstall') {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Good "Removed the scheduled task $TaskName"
    }
    else {
        Note "No scheduled task named $TaskName"
    }
    Note 'The duet-code shim (if any) is left alone.'
    exit 0
}

if (-not (Test-Path -LiteralPath $Runner)) { Fail "Cannot find the runner at $Runner" }

# ---- the interpreter: prefer a windowless one, so the runner has no console of its own ----
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) { $pythonCmd = Get-Command py -ErrorAction SilentlyContinue }
if (-not $pythonCmd) { Fail 'Python is not on PATH. Install Python 3.11 or newer.' }
$python = $pythonCmd.Source
$pythonw = Join-Path (Split-Path $python -Parent) 'pythonw.exe'
if (Test-Path -LiteralPath $pythonw) {
    $exe = $pythonw
}
else {
    $exe = $python
    Note 'pythonw.exe not found, so the runner keeps a console window. Harmless.'
}

$version = & $python -c 'import sys;print("%d.%d" % sys.version_info[:2])'
if ([version]$version -lt [version]'3.11') { Fail "Python $version is too old; the runner needs 3.11 or newer (tomllib)." }

# ---- the task needs claude and node on PATH when it runs ----
foreach ($tool in 'claude', 'node') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Note "WARNING: $tool is not on PATH. The task inherits your user PATH, so sessions will fail until it is."
    }
}

$config = Join-Path $Here 'config.toml'
if (-not (Test-Path -LiteralPath $config)) {
    Note "No config.toml yet. Run windows\setup.ps1 first, or copy config.example.toml."
}

# ---- register ----
$action = New-ScheduledTaskAction -Execute $exe -Argument ('"{0}" serve' -f $Runner) -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 10 `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'Duet Bridge runner: polls the Worker for Claude Duet sessions, jobs and window requests.' `
    -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$logDefault = Join-Path $env:LOCALAPPDATA 'duet-bridge\duet-bridge.log'
Good "$TaskName is running (duet-bridge.py serve). Log: $logDefault"
Note ("Pause it:  New-Item -ItemType File '{0}\duet-bridge.OFF'" -f $Here)
Note ("Resume:    Remove-Item '{0}\duet-bridge.OFF'" -f $Here)
Note "Check it:  Get-ScheduledTask $TaskName | Get-ScheduledTaskInfo"

# ---- duet-code on your PATH, so you can type it in place of claude ----
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue)
if (-not $shell) { $shell = Get-Command powershell -ErrorAction SilentlyContinue }
$shim = Join-Path $HOME '.local\bin\duet-code.cmd'
$shimDir = Split-Path $shim -Parent
if (Test-Path -LiteralPath $shimDir) {
    $body = @"
@echo off
"$($shell.Source)" -NoLogo -ExecutionPolicy Bypass -File "$(Join-Path $Here 'duet-code.ps1')" %*
"@
    [System.IO.File]::WriteAllText($shim, $body, (New-Object System.Text.ASCIIEncoding))
    Good "Wrote the duet-code shim to $shim"
    if (($env:PATH -split ';') -notcontains $shimDir) {
        Note "$shimDir is not on this session's PATH; open a new terminal, or add it."
    }
}
else {
    Note "To type duet-code anywhere, create $shimDir and run this again."
}
