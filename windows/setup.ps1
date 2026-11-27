#!/usr/bin/env pwsh
# setup.ps1: deploy Duet Bridge to Cloudflare and wire this PC to it. Safe to run again.
# Before the first run: `npx wrangler login` (opens the browser to sign in to Cloudflare).
# This is the Windows counterpart of worker/setup.sh.

$ErrorActionPreference = 'Stop'

$Here = $PSScriptRoot
$Repo = Split-Path $Here -Parent
$WorkerDir = Join-Path $Repo 'worker'
$Config = Join-Path $Here 'config.toml'
$Example = Join-Path $Here 'config.example.toml'

function Fail([string]$message) {
    Write-Host "ERROR: $message" -ForegroundColor Red
    exit 1
}
function Good([string]$message) { Write-Host "OK  $message" -ForegroundColor Green }
function Note([string]$message) { Write-Host "  $message" -ForegroundColor DarkGray }

if (-not (Test-Path -LiteralPath $Config)) { Copy-Item -LiteralPath $Example -Destination $Config }

$TokenFile = Join-Path $HOME '.duet-bridge-token'
$PassFile = Join-Path $HOME '.duet-bridge-passphrase'

# ---- 1. Secrets, made once and kept in private files. Never printed. ----
# Windows has no umask; lock each file to this account instead.
function Protect-File([string]$path) {
    & icacls $path /inheritance:r /grant:r ("{0}:(R,W)" -f $env:USERNAME) | Out-Null
}

function New-UrlSafeToken([int]$bytes = 32) {
    $buffer = New-Object byte[] $bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# macOS reads /usr/share/dict/words; Windows has no such file, so the list ships here.
# Six words out of 128 is about 42 bits. Replace the file by hand if you want more.
$WORDS = ('able acid aged also arch area army atom aunt axis bake bald band bank barn base bath bead beam bean bear beat
beef bell belt bend best bike bird bite blue boat bold bolt bone book boot bore both bowl brave bread brick brief broom
brush buck bulk bunk burn bush cake calm camp cane card care cart case cash cast cave cell chain chair chalk charm chase
cheek chess chest chief child chin clay cliff climb clock cloth cloud coal coast coat code coin cold comb cone cook cool
cord cork corn cost couch cough crane crash cream crew crop crown curl curve cycle daisy dance dawn deal deck deep deer
desk dial diet dish dive dock door dose dove draft drain dream dress drift drum dusk dust duty eagle earth east edge').Split(
    [string[]]@("`r`n", "`n", ' '), [StringSplitOptions]::RemoveEmptyEntries)

function New-Passphrase([int]$count = 6) {
    (1..$count | ForEach-Object { $WORDS[[System.Security.Cryptography.RandomNumberGenerator]::GetInt32($WORDS.Length)] }) -join '-'
}

if (-not (Test-Path -LiteralPath $TokenFile) -or -not (Get-Item -LiteralPath $TokenFile).Length) {
    [System.IO.File]::WriteAllText($TokenFile, (New-UrlSafeToken), (New-Object System.Text.ASCIIEncoding))
}
if (-not (Test-Path -LiteralPath $PassFile) -or -not (Get-Item -LiteralPath $PassFile).Length) {
    [System.IO.File]::WriteAllText($PassFile, (New-Passphrase), (New-Object System.Text.ASCIIEncoding))
}
Protect-File $TokenFile
Protect-File $PassFile

$token = ([System.IO.File]::ReadAllText($TokenFile)).Trim()
$pass = ([System.IO.File]::ReadAllText($PassFile)).Trim()

# ---- 2. Deploy once to learn the public URL, then record it in wrangler.jsonc. ----
Push-Location $WorkerDir
try {
    & npm install --silent
    $out = (& npx wrangler deploy 2>&1 | Out-String)
    ($out -split "`n" | Select-Object -Last 5) | ForEach-Object { Note $_.TrimEnd() }
    # Not $matches: that name is PowerShell's own, set by every -match.
    $found = @([regex]::Matches($out, 'https://duet-bridge\.[a-z0-9-]+\.workers\.dev') |
            Where-Object { $_.Value -notmatch '\.example\.' })
    if (-not $found.Count) { Fail 'Could not read the Worker URL from the deploy output.' }
    $url = $found[$found.Count - 1].Value

    $wrangler = Join-Path $WorkerDir 'wrangler.jsonc'
    $text = [System.IO.File]::ReadAllText($wrangler)
    $text = [regex]::Replace($text, '"PUBLIC_URL":\s*"[^"]*"', ('"PUBLIC_URL": "' + $url + '"'))
    [System.IO.File]::WriteAllText($wrangler, $text)

    # ---- 3. Secrets into Cloudflare. A bulk file avoids stdin newline trouble on Windows. ----
    $bulk = Join-Path ([System.IO.Path]::GetTempPath()) ("duet-secrets-{0}.json" -f [guid]::NewGuid().ToString('N'))
    try {
        $json = [ordered]@{ BRIDGE_TOKEN = $token; OWNER_PASSPHRASE = $pass } | ConvertTo-Json
        [System.IO.File]::WriteAllText($bulk, $json, (New-Object System.Text.UTF8Encoding($false)))
        Protect-File $bulk
        & npx wrangler secret bulk $bulk | Out-Null
    }
    finally {
        if (Test-Path -LiteralPath $bulk) { Remove-Item -LiteralPath $bulk -Force }
    }

    # ---- 4. Redeploy with the real URL, and tell the runner where the bridge is. ----
    & npx wrangler deploy | Out-Null
}
finally { Pop-Location }

$cfgText = [System.IO.File]::ReadAllText($Config)
$cfgText = [regex]::Replace($cfgText, '(?m)^url\s*=\s*"[^"]*"', ('url = "' + $url + '"'))
[System.IO.File]::WriteAllText($Config, $cfgText)

# ---- 5. Check it answers. ----
try {
    Invoke-WebRequest -Uri "$url/" -UseBasicParsing -TimeoutSec 20 | Out-Null
    Good "Duet Bridge is live at $url/mcp"
}
catch { Write-Host "ERROR: $url did not answer" -ForegroundColor Red }

$runner = Join-Path (Join-Path $Repo 'mac') 'duet-bridge.py'
& python $runner status | Out-Null
if ($LASTEXITCODE -eq 0) { Good 'This PC can reach the bridge' }
else { Write-Host 'ERROR: the runner could not reach the bridge' -ForegroundColor Red }

Write-Host ''
Write-Host "Connector URL for claude.ai:  $url/mcp"
Write-Host "Passphrase is in $PassFile. Copy it with:  Get-Content '$PassFile' | Set-Clipboard"
Write-Host "Next: edit $Config (workspaces, MCP servers), then run windows\install.ps1."
