<#
.SYNOPSIS
    Create desktop shortcuts for Agentic OS.

.DESCRIPTION
    Creates "Agentic OS" and "Stop Agentic OS" on the Desktop, and optionally
    adds Agentic OS to the Start Menu so it appears in search.

    Shortcuts point at powershell.exe with -ExecutionPolicy Bypass scoped to the
    single launch, so this works without changing the machine's execution policy.

.PARAMETER StartMenu
    Also add a Start Menu entry.

.PARAMETER Remove
    Delete the shortcuts instead of creating them.
#>

[CmdletBinding()]
param(
    [switch] $StartMenu,
    [switch] $Remove
)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot

$desktop     = [Environment]::GetFolderPath('Desktop')
$startMenuDir = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'

$startLink = Join-Path $desktop 'Agentic OS.lnk'
$stopLink  = Join-Path $desktop 'Stop Agentic OS.lnk'
$menuLink  = Join-Path $startMenuDir 'Agentic OS.lnk'

if ($Remove) {
    foreach ($link in @($startLink, $stopLink, $menuLink)) {
        if (Test-Path $link) {
            Remove-Item $link -Force
            Write-Host "  Removed $link" -ForegroundColor Gray
        }
    }
    Write-Host '  Shortcuts removed.' -ForegroundColor Green
    return
}

$iconPath = Join-Path $AppRoot 'assets\agentic-os.ico'
if (-not (Test-Path $iconPath)) {
    Write-Warning "Icon not found at $iconPath; the shortcut will use the default PowerShell icon."
    $iconPath = $null
}

$shell = New-Object -ComObject WScript.Shell

function New-Shortcut {
    param(
        [string] $Path,
        [string] $ScriptName,
        [string] $Description,
        [string] $Arguments = ''
    )

    $sc = $shell.CreateShortcut($Path)
    $sc.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

    $scriptPath = Join-Path $AppRoot "scripts\$ScriptName"
    $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
    if ($Arguments) { $argList += " $Arguments" }

    $sc.Arguments        = $argList
    $sc.WorkingDirectory = $AppRoot
    $sc.Description      = $Description
    $sc.WindowStyle      = 1          # normal window, so messages are readable
    if ($iconPath) { $sc.IconLocation = "$iconPath,0" }
    $sc.Save()

    Write-Host "  Created: $Path" -ForegroundColor Green
}

Write-Host ''
Write-Host '  Installing Agentic OS shortcuts' -ForegroundColor White
Write-Host ''

New-Shortcut -Path $startLink -ScriptName 'start-app.ps1' `
    -Description 'Open Agentic OS - a visual command center for your Obsidian vault'

New-Shortcut -Path $stopLink -ScriptName 'stop-app.ps1' `
    -Description 'Stop the Agentic OS server'

if ($StartMenu) {
    if (-not (Test-Path $startMenuDir)) {
        New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
    }
    New-Shortcut -Path $menuLink -ScriptName 'start-app.ps1' `
        -Description 'Open Agentic OS - a visual command center for your Obsidian vault'
}

Write-Host ''
Write-Host '  Double-click "Agentic OS" on your desktop to start.' -ForegroundColor Gray
Write-Host '  The first launch builds the app, so it takes a little longer.' -ForegroundColor DarkGray
Write-Host ''
