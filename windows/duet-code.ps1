#!/usr/bin/env pwsh
# duet-code.ps1: start Claude Code with a live line to Claude Duet. Type it in place of `claude`.
#   duet-code                          a new window that Duet can see and talk to
#   duet-code --name "Weekly review"   the same, with the name Duet sees
#   duet-code --session <id> ...       take over a Duet session (open_on_mac runs this)
#   duet-code --dir <folder> ...       start in that folder
# Any other arguments go to `claude` unchanged.
# Settings: url and token_file in config.toml next to this script.
# install.ps1 puts a duet-code.cmd shim on your PATH, so you can type duet-code anywhere.
# The first launch shows a warning screen about development channels. Choose
# "I am using this for local development". The channel is built in this repo, not an outside download.

$ErrorActionPreference = 'Stop'

$Here = $PSScriptRoot
$Repo = Split-Path $Here -Parent

function Fail([string]$message) {
    Write-Host "ERROR: $message" -ForegroundColor Red
    exit 1
}

# ---- arguments: take ours, hand the rest to claude ----
$Name = ''
$Session = ''
$i = 0
while ($i -lt $args.Count) {
    $flag = [string]$args[$i]
    if ($flag -eq '--name') { $Name = [string]$args[$i + 1]; $i += 2 }
    elseif ($flag -eq '--session') { $Session = [string]$args[$i + 1]; $i += 2 }
    elseif ($flag -eq '--dir') { Set-Location -LiteralPath ([string]$args[$i + 1]); $i += 2 }
    else { break }
}
$Rest = @()
if ($i -lt $args.Count) { $Rest = $args[$i..($args.Count - 1)] }

# ---- settings ----
$Config = if ($env:DUET_BRIDGE_CONFIG) { $env:DUET_BRIDGE_CONFIG } else { Join-Path $Here 'config.toml' }
if (-not (Test-Path -LiteralPath $Config)) {
    Fail "$Config not found. Run windows\setup.ps1, or copy config.example.toml to config.toml."
}

# One top-level value (before the first [section]) out of config.toml.
function Get-Conf([string]$Key) {
    $pattern = '^\s*' + [regex]::Escape($Key) + '\s*=\s*"([^"]*)"'
    foreach ($line in Get-Content -LiteralPath $Config) {
        if ($line -match '^\s*\[') { break }
        if ($line -match $pattern) { return $Matches[1] }
    }
    return ''
}

function Expand-Home([string]$path) {
    if ($path.StartsWith('~')) { return Join-Path $HOME $path.Substring(1).TrimStart('/', '\') }
    return $path
}

$Url = if ($env:DUET_BRIDGE_URL) { $env:DUET_BRIDGE_URL } else { Get-Conf 'url' }
$TokenFile = if ($env:DUET_BRIDGE_TOKEN_FILE) { $env:DUET_BRIDGE_TOKEN_FILE } else { Get-Conf 'token_file' }
if (-not $TokenFile) { $TokenFile = '~/.duet-bridge-token' }
$TokenFile = Expand-Home $TokenFile
if (-not $Url) { Fail "url is empty in $Config, so the bridge is not set up." }

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) { Fail 'node is not on PATH. Install Node 20 or newer.' }
$Node = $NodeCmd.Source

$ChannelDir = Join-Path $Repo 'channel'
$Channel = Join-Path $ChannelDir 'channel.mjs'
if (-not (Test-Path -LiteralPath (Join-Path $ChannelDir 'node_modules'))) {
    Push-Location $ChannelDir
    try { npm install --silent } finally { Pop-Location }
}

# ---- the server definition and the Stop hook, in private temp files ----
# Nothing in your global Claude config changes. The Stop hook sends a window back once
# if it answered a Duet message in the terminal only.
function Write-Json($value, [string]$path) {
    $json = $value | ConvertTo-Json -Depth 8
    # No BOM: Claude Code reads these as plain JSON.
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$stamp = [guid]::NewGuid().ToString('N')
$temp = [System.IO.Path]::GetTempPath()
$CfgPath = Join-Path $temp "duet-channel-$stamp.json"
$SettingsPath = Join-Path $temp "duet-settings-$stamp.json"

# A background copy of the window reads the same file, so it finds the same lock and stays quiet.
$channelEnv = [ordered]@{
    DUET_BRIDGE_URL        = $Url
    DUET_BRIDGE_TOKEN_FILE = $TokenFile
    DUET_LOCK_FILE         = "$CfgPath.lock"
}
if ($Session) { $channelEnv['DUET_SESSION_ID'] = $Session }
if ($Name) { $channelEnv['DUET_SESSION_NAME'] = $Name }

Write-Json ([ordered]@{
        mcpServers = [ordered]@{
            duet = [ordered]@{ type = 'stdio'; command = $Node; args = @($Channel); env = $channelEnv }
        }
    }) $CfgPath

# Remote Control off: with it on, Claude Code can move Duet windows into its background service
# about 30 s after a turn, and the moved session drops the channel flag, so Duet's messages go nowhere.
$hook = '"' + $Node + '" "' + (Join-Path $ChannelDir 'stop-hook.mjs') + '"'
Write-Json ([ordered]@{
        remoteControlAtStartup = $false
        hooks                  = [ordered]@{
            Stop = @(@{ hooks = @(@{ type = 'command'; command = $hook }) })
        }
    }) $SettingsPath

# The two Duet tools are pre-approved: a reply goes only to your own Duet.
$claudeArgs = @(
    '--mcp-config', $CfgPath,
    '--settings', $SettingsPath,
    '--allowedTools', 'mcp__duet__send_to_duet,mcp__duet__set_focus',
    '--dangerously-load-development-channels', 'server:duet'
)
if ($Name) { $claudeArgs += @('--name', $Name) }
if ($Rest.Count) { $claudeArgs += $Rest }

& claude @claudeArgs
exit $LASTEXITCODE
