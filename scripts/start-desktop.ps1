<#
.SYNOPSIS
    Launch Agentic OS as a desktop application.

.DESCRIPTION
    Starts the native window. The Electron main process owns the server: it
    picks a free loopback port, waits for the health check, then shows the
    window, and tears the server down again on quit.

    Because Electron bundles its own Node (24.x, which includes node:sqlite),
    this does not depend on a system Node install at runtime - only on the
    dependencies already in node_modules.

.PARAMETER Web
    Run the old browser mode instead: start the server and open a browser tab.
#>

[CmdletBinding()]
param(
    [switch] $Web,

    # Set when launched from the desktop shortcut, which runs this with no
    # console attached. Progress output goes nowhere, so problems are reported
    # in a message box instead of to a window nobody can see.
    [switch] $Silent
)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
Set-Location $AppRoot

if ($Web) {
    & (Join-Path $PSScriptRoot 'start-app.ps1')
    return
}

function Write-Step { param($m) Write-Host "  $m" -ForegroundColor Gray }
function Write-Good { param($m) Write-Host "  $m" -ForegroundColor Green }

# Suppress progress chatter when there is no console to print it to.
# This must come *after* the definitions above: PowerShell keeps the last
# definition of a function name, so overriding first would have no effect.
if ($Silent) {
    function Write-Step { param($m) }
    function Write-Good { param($m) }
}

function Stop-WithMessage {
    param([string] $Title, [string[]] $Lines)

    if ($Silent) {
        # No console exists, so a failure would otherwise be completely
        # invisible: the user double-clicks the icon and nothing happens.
        $body = ($Lines -join "`r`n")
        try {
            $wshell = New-Object -ComObject WScript.Shell
            # 16 = critical icon, 0 = OK button only.
            $null = $wshell.Popup($body, 0, "Agentic OS - $Title", 16)
        } catch {
            # If even that fails there is nothing useful left to try.
        }
        exit 1
    }

    Write-Host ''
    Write-Host "  $Title" -ForegroundColor Red
    Write-Host ''
    foreach ($line in $Lines) { Write-Host "  $line" -ForegroundColor Gray }
    Write-Host ''
    $interactive = -not [Console]::IsInputRedirected -and $Host.Name -eq 'ConsoleHost'
    if ($interactive) {
        Write-Host '  Press any key to close this window.' -ForegroundColor DarkGray
        try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 15 }
    } else {
        Start-Sleep -Seconds 3
    }
    exit 1
}

if (-not $Silent) {
    Clear-Host
    Write-Host ''
    Write-Host '  Agentic OS' -ForegroundColor White
    Write-Host '  Starting the desktop application...' -ForegroundColor DarkGray
    Write-Host ''
}

# --- Prerequisites ------------------------------------------------------------

if (-not (Test-Path (Join-Path $AppRoot 'node_modules'))) {
    Write-Step 'Installing dependencies (first run only, this takes a few minutes)...'
    & npm install --no-fund --no-audit 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage 'Dependency installation failed.' @(
            'Run this manually to see the error:', "  cd `"$AppRoot`"", '  npm install'
        )
    }
}

if (-not (Test-Path (Join-Path $AppRoot 'node_modules\electron'))) {
    Stop-WithMessage 'Electron is not installed.' @(
        'Run this to install it:', "  cd `"$AppRoot`"", '  npm install'
    )
}

if (-not (Test-Path (Join-Path $AppRoot '.env.local'))) {
    if (Test-Path (Join-Path $AppRoot '.env.example')) {
        Copy-Item (Join-Path $AppRoot '.env.example') (Join-Path $AppRoot '.env.local')
    }
    Stop-WithMessage 'Configuration needed before the first run.' @(
        'A .env.local file has been created for you.'
        'Open it and set VAULT_ROOT to your vault folder, then start again:'
        "  notepad `"$AppRoot\.env.local`""
    )
}

# --- Already running? ---------------------------------------------------------

$existing = Get-Process | Where-Object {
    $_.ProcessName -like '*electron*' -and $_.MainWindowTitle -eq 'Agentic OS'
} | Select-Object -First 1

if ($existing) {
    Write-Good 'Agentic OS is already open.'
    # The app holds a single-instance lock, so launching again just focuses it.
    Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction SilentlyContinue
    try { [Microsoft.VisualBasic.Interaction]::AppActivate($existing.Id) } catch { }
    Start-Sleep -Seconds 2
    exit 0
}

# --- Build if needed ----------------------------------------------------------

$buildId = Join-Path $AppRoot '.next\BUILD_ID'
$needsBuild = -not (Test-Path $buildId)

if (-not $needsBuild) {
    $buildTime = (Get-Item $buildId).LastWriteTime
    $newer = Get-ChildItem -Path 'src' -Recurse -File -ErrorAction SilentlyContinue |
             Where-Object { $_.LastWriteTime -gt $buildTime } | Select-Object -First 1
    if ($newer) {
        Write-Step 'Source has changed since the last build; rebuilding.'
        $needsBuild = $true
    }
}

if ($needsBuild) {
    Write-Step 'Building (this takes a few seconds)...'
    & npm run build 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage 'The build failed.' @(
            'Run this manually to see the error:', "  cd `"$AppRoot`"", '  npm run build'
        )
    }
    Write-Good 'Build complete'
} else {
    Write-Good 'Build is up to date'
}

# --- Launch -------------------------------------------------------------------

Write-Step 'Opening the application window...'

$electron = Join-Path $AppRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
    Stop-WithMessage 'The Electron binary is missing.' @(
        'Reinstall it with:', "  cd `"$AppRoot`"", '  npm install electron --save-dev'
    )
}

# Detached so the window survives this console closing.
# Do NOT pass -WindowStyle Hidden here: Electron is a GUI application, and
# hiding it suppresses the app window itself while the process keeps running
# and holds the single-instance lock - which then makes every later launch
# quit immediately with no visible symptom.
Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $AppRoot

# Wait for the window so failures surface here rather than as a silent no-op.
$appeared = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $win = Get-Process | Where-Object {
        $_.ProcessName -like '*electron*' -and $_.MainWindowTitle -eq 'Agentic OS'
    } | Select-Object -First 1
    if ($win) { $appeared = $true; break }
}

if ($appeared) {
    if (-not $Silent) {
        Write-Host ''
        Write-Good 'Agentic OS is open.'
        Write-Host ''
        Write-Host '  The window runs independently; this console can close.' -ForegroundColor DarkGray
        Start-Sleep -Seconds 3
    }
    exit 0
} else {
    Stop-WithMessage 'The window did not appear.' @(
        'The application may have reported a configuration problem in a dialog.'
        'For a full diagnosis run:'
        "  cd `"$AppRoot`"; npm run doctor"
        ''
        'To see startup output directly:'
        "  cd `"$AppRoot`"; npm run desktop"
    )
}
