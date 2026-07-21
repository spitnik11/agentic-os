<#
.SYNOPSIS
    Launch Agentic OS and open it in the browser.

.DESCRIPTION
    Written to be double-clicked, so it recovers from the situations that
    actually happen rather than assuming a prepared environment:
      - dependencies not installed        -> installs them
      - no production build               -> builds it
      - the app is already running        -> just opens the browser
      - port 3000 taken by something else -> picks the next free port
      - the vault path is wrong           -> stops with a readable explanation

    Runs the production build, not the dev server: it starts faster, uses less
    memory, and does not rebuild on every file touch.

.PARAMETER Dev
    Run the development server instead (hot reload, slower).

.PARAMETER NoBrowser
    Start the server but do not open a browser window.
#>

[CmdletBinding()]
param(
    [switch] $Dev,
    [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
Set-Location $AppRoot

function Write-Step   { param($m) Write-Host "  $m" -ForegroundColor Gray }
function Write-Good   { param($m) Write-Host "  $m" -ForegroundColor Green }
function Write-Warn   { param($m) Write-Host "  $m" -ForegroundColor Yellow }
function Write-Bad    { param($m) Write-Host "  $m" -ForegroundColor Red }

function Stop-WithMessage {
    param([string] $Title, [string[]] $Lines)
    Write-Host ''
    Write-Bad $Title
    Write-Host ''
    foreach ($line in $Lines) { Write-Host "  $line" -ForegroundColor Gray }
    Write-Host ''
    # Only wait for a keypress when there is a real console to press one at.
    # A hidden or redirected host blocks forever on ReadKey, which turns a
    # readable error message into a silent hang.
    $interactive = -not [Console]::IsInputRedirected -and
                   $Host.Name -eq 'ConsoleHost' -and
                   $null -ne $Host.UI.RawUI
    if ($interactive) {
        Write-Host '  Press any key to close this window.' -ForegroundColor DarkGray
        try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 20 }
    } else {
        Start-Sleep -Seconds 3
    }
    exit 1
}

Clear-Host
Write-Host ''
Write-Host '  Agentic OS' -ForegroundColor White
Write-Host '  A visual command center for your Obsidian vault.' -ForegroundColor DarkGray
Write-Host ''

# --- Node ---------------------------------------------------------------------

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Stop-WithMessage 'Node.js is not installed, or is not on your PATH.' @(
        'Install the current LTS from https://nodejs.org and run this again.'
        'Agentic OS needs Node 22.5 or newer.'
    )
}

$nodeVersion = (& node --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion -split '\.')[0]
$nodeMinor = [int]($nodeVersion -split '\.')[1]
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 5)) {
    Stop-WithMessage "Node $nodeVersion is too old." @(
        'Agentic OS needs Node 22.5 or newer for the built-in SQLite module.'
        'Install the current LTS from https://nodejs.org.'
    )
}
Write-Good "Node $nodeVersion"

# --- Configuration ------------------------------------------------------------

if (-not (Test-Path '.env.local')) {
    if (Test-Path '.env.example') {
        Write-Warn 'No .env.local found; creating one from .env.example.'
        Copy-Item '.env.example' '.env.local'
        Stop-WithMessage 'Configuration needed before the first run.' @(
            'A .env.local file has just been created for you.'
            'Open it and set VAULT_ROOT to your vault folder, then run this again:'
            ''
            "  notepad `"$AppRoot\.env.local`""
        )
    }
    Stop-WithMessage 'No .env.local and no .env.example to copy.' @(
        'The application cannot start without knowing where your vault is.'
    )
}

# Read VAULT_ROOT so a bad path fails here, with an explanation, rather than
# surfacing as an opaque 500 in the browser.
$vaultRoot = $null
foreach ($line in Get-Content '.env.local') {
    if ($line -match '^\s*VAULT_ROOT\s*=\s*(.+?)\s*$') {
        $vaultRoot = $Matches[1].Trim('"').Trim("'")
    }
}
if (-not $vaultRoot) {
    Stop-WithMessage 'VAULT_ROOT is not set in .env.local.' @(
        "Open `"$AppRoot\.env.local`" and set it to your vault folder, e.g."
        '  VAULT_ROOT=C:\Users\you\Documents\MyVault'
    )
}
if (-not (Test-Path $vaultRoot)) {
    Stop-WithMessage 'The configured vault folder does not exist.' @(
        "VAULT_ROOT is set to: $vaultRoot"
        ''
        "Fix the path in `"$AppRoot\.env.local`" and run this again."
    )
}
Write-Good "Vault: $vaultRoot"

# --- Dependencies -------------------------------------------------------------

if (-not (Test-Path 'node_modules')) {
    Write-Step 'Installing dependencies (first run only, this takes a minute)...'
    & npm install --no-fund --no-audit 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage 'Dependency installation failed.' @(
            'Run this manually to see the error:'
            "  cd `"$AppRoot`""
            '  npm install'
        )
    }
    Write-Good 'Dependencies installed'
}

# --- Pick a port --------------------------------------------------------------

function Test-PortFree {
    param([int] $Port)
    # Ask the OS for actual listeners rather than trying to bind. On Windows a
    # bind to 127.0.0.1 succeeds even while another socket holds the same port
    # on the wildcard address, which is how Next.js listens - so a bind test
    # reports "free" for a port that is very much in use, and the launcher
    # starts a second server on top of the first.
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return ($null -eq $listeners -or $listeners.Count -eq 0)
}

function Test-IsAgenticOs {
    param([int] $Port)
    try {
        $res = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 3 -ErrorAction Stop
        return ($null -ne $res.vault -and $null -ne $res.status)
    } catch {
        return $false
    }
}

$port = 3000

# Ask the app itself first. If it answers, it is already running and starting a
# second copy would put two servers on the same database and the same vault.
foreach ($candidate in 3000..3005) {
    if (Test-IsAgenticOs $candidate) {
        Write-Good "Agentic OS is already running on port $candidate."
        if (-not $NoBrowser) { Start-Process "http://localhost:$candidate" }
        Write-Host ''
        Write-Host "  Opened http://localhost:$candidate" -ForegroundColor White
        Write-Host '  This window will close in a moment.' -ForegroundColor DarkGray
        Start-Sleep -Seconds 3
        exit 0
    }
}

if (-not (Test-PortFree $port)) {
    Write-Warn 'Port 3000 is in use by something else; looking for a free port.'
    $port = 3001
    while ($port -lt 3020 -and -not (Test-PortFree $port)) { $port++ }
    if ($port -ge 3020) {
        Stop-WithMessage 'No free port found between 3000 and 3019.' @(
            'Close whatever is using those ports and try again.'
        )
    }
    Write-Good "Using port $port"
}

# --- Build (production mode only) --------------------------------------------

if (-not $Dev) {
    $buildId = Join-Path $AppRoot '.next\BUILD_ID'
    $needsBuild = -not (Test-Path $buildId)

    if (-not $needsBuild) {
        # Rebuild when source is newer than the last build, so an edited file is
        # not silently ignored.
        $buildTime = (Get-Item $buildId).LastWriteTime
        $newer = Get-ChildItem -Path 'src' -Recurse -File -ErrorAction SilentlyContinue |
                 Where-Object { $_.LastWriteTime -gt $buildTime } |
                 Select-Object -First 1
        if ($newer) {
            Write-Step 'Source has changed since the last build; rebuilding.'
            $needsBuild = $true
        }
    }

    if ($needsBuild) {
        Write-Step 'Building the application (this takes a few seconds)...'
        & npm run build 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Stop-WithMessage 'The build failed.' @(
                'Run this manually to see the error:'
                "  cd `"$AppRoot`""
                '  npm run build'
            )
        }
        Write-Good 'Build complete'
    } else {
        Write-Good 'Build is up to date'
    }
}

# --- Start --------------------------------------------------------------------

$mode = if ($Dev) { 'development' } else { 'production' }
Write-Step "Starting the server in $mode mode..."

$npmCmd = if ($Dev) { 'dev' } else { 'start' }
$logFile = Join-Path $AppRoot 'devserver.log'

$proc = Start-Process -FilePath 'npm.cmd' `
    -ArgumentList @('run', $npmCmd, '--', '-p', $port) `
    -WorkingDirectory $AppRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError (Join-Path $AppRoot 'devserver.err.log') `
    -PassThru

# Record the PID so the stop script does not have to guess.
$proc.Id | Set-Content (Join-Path $AppRoot '.server.pid')

# --- Wait for it to answer ----------------------------------------------------

Write-Step 'Waiting for the server to come up...'
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) { break }
    if (Test-IsAgenticOs $port) { $ready = $true; break }
}

if (-not $ready) {
    $tail = ''
    if (Test-Path $logFile) { $tail = (Get-Content $logFile -Tail 12) -join "`n  " }
    $errTail = ''
    $errFile = Join-Path $AppRoot 'devserver.err.log'
    if (Test-Path $errFile) { $errTail = (Get-Content $errFile -Tail 12) -join "`n  " }
    Stop-WithMessage 'The server did not start.' @(
        'Last output:'
        "  $tail"
        "  $errTail"
        ''
        'Run this for a full diagnosis:'
        "  cd `"$AppRoot`"; npm run doctor"
    )
}

# --- Report -------------------------------------------------------------------

$health = Invoke-RestMethod -Uri "http://localhost:$port/api/health" -TimeoutSec 5

Write-Host ''
Write-Good  'Agentic OS is running.'
Write-Host ''
Write-Host  "    Address    http://localhost:$port" -ForegroundColor White
Write-Host  "    Mode       $mode / private vault" -ForegroundColor Gray
Write-Host  "    Vault      $($health.vault.path)" -ForegroundColor Gray
Write-Host  "    Indexed    $($health.vault.indexedRecords) records" -ForegroundColor Gray
Write-Host  "    Database   $($health.database.location)" -ForegroundColor Gray
Write-Host  "    AI         $(if ($health.ai.enabled) { 'enabled' } else { 'off - everything runs locally, no cost' })" -ForegroundColor Gray
Write-Host  "    Health     http://localhost:$port/api/health" -ForegroundColor Gray
Write-Host ''
Write-Host  '  To stop it later, double-click "Stop Agentic OS", or run:' -ForegroundColor DarkGray
Write-Host  "    cd `"$AppRoot`"; .\scripts\stop-app.ps1" -ForegroundColor DarkGray
Write-Host ''

if (-not $NoBrowser) { Start-Process "http://localhost:$port" }

Write-Host '  This window can be closed; the app keeps running.' -ForegroundColor DarkGray
Start-Sleep -Seconds 4
