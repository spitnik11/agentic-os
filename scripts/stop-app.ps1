<#
.SYNOPSIS
    Stop the running Agentic OS server.

.DESCRIPTION
    Works from the socket rather than the process tree.

    npm spawns the real server through an intermediate cmd.exe that Windows
    reparents, so the node process actually holding the port is often not a
    descendant of the PID the launcher recorded. Walking down that tree kills
    the wrapper, leaves the server running, and reports success - which is
    worse than failing loudly.

    So: find whatever is listening, confirm over HTTP that it is Agentic OS
    before touching it, kill it, then verify the port has actually gone quiet.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
Set-Location $AppRoot

Write-Host ''
Write-Host '  Stopping Agentic OS' -ForegroundColor White
Write-Host ''

$PORTS = 3000..3005

function Test-IsAgenticOs {
    param([int] $Port)
    try {
        $res = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 2 -ErrorAction Stop
        return ($null -ne $res.vault -and $null -ne $res.status)
    } catch {
        return $false
    }
}

function Get-ListenerPids {
    param([int] $Port)
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) { return @() }
    return @($conns | Select-Object -ExpandProperty OwningProcess -Unique)
}

# Ancestors worth cleaning up: the cmd.exe and npm wrappers that launched our
# server. Identified by their command line referencing this app, never by name
# alone, so an unrelated process is never a candidate.
function Get-OurAncestors {
    param([int] $ProcessId)
    $found = @()
    $current = $ProcessId
    for ($depth = 0; $depth -lt 4; $depth++) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
        if (-not $proc -or -not $proc.ParentProcessId) { break }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue
        if (-not $parent) { break }
        $cmd = [string]$parent.CommandLine
        $isOurs = $cmd -and (
            $cmd -like "*$AppRoot*" -or
            $cmd -like '*next*start*' -or
            $cmd -like '*next*dev*' -or
            $cmd -like '*run*start*' -or
            $cmd -like '*run*dev*'
        )
        if (-not $isOurs) { break }
        $found += [int]$parent.ProcessId
        $current = [int]$parent.ProcessId
    }
    return $found
}

$killed = [System.Collections.Generic.HashSet[int]]::new()

foreach ($port in $PORTS) {
    if (-not (Test-IsAgenticOs $port)) { continue }

    Write-Host "  Found Agentic OS on port $port." -ForegroundColor Gray

    foreach ($listenerPid in (Get-ListenerPids $port)) {
        # Clean up the wrappers as well, so no orphaned cmd.exe is left behind.
        $targets = @($listenerPid) + (Get-OurAncestors $listenerPid)
        foreach ($target in $targets) {
            try {
                Stop-Process -Id $target -Force -ErrorAction Stop
                [void]$killed.Add([int]$target)
            } catch {
                # Already gone, or not ours to stop.
            }
        }
    }
}

# Also clear the PID the launcher recorded, in case it is a wrapper that no
# longer holds the port.
$pidFile = Join-Path $AppRoot '.server.pid'
if (Test-Path $pidFile) {
    $recorded = (Get-Content $pidFile -Raw).Trim()
    if ($recorded -match '^\d+$') {
        try {
            Stop-Process -Id ([int]$recorded) -Force -ErrorAction Stop
            [void]$killed.Add([int]$recorded)
        } catch {
            # Expected when the launcher's wrapper has already exited.
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# --- Verify, rather than assume ----------------------------------------------

$stillUp = @()
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    Start-Sleep -Milliseconds 400
    $stillUp = @($PORTS | Where-Object { Test-IsAgenticOs $_ })
    if ($stillUp.Count -eq 0) { break }
}

Write-Host ''
if ($stillUp.Count -eq 0) {
    if ($killed.Count -gt 0) {
        Write-Host "  Stopped (PID $(($killed | Sort-Object) -join ', '))." -ForegroundColor Green
    } else {
        Write-Host '  Agentic OS was not running.' -ForegroundColor Gray
    }
} else {
    Write-Host "  Could not stop the server on port $($stillUp -join ', ')." -ForegroundColor Red
    Write-Host '  Find and stop it manually with:' -ForegroundColor Gray
    Write-Host "    Get-NetTCPConnection -LocalPort $($stillUp[0]) -State Listen | " -NoNewline -ForegroundColor DarkGray
    Write-Host 'ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }' -ForegroundColor DarkGray
}

Write-Host ''
Start-Sleep -Seconds 2
