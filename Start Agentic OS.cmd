@echo off
REM Convenience launcher for anyone who prefers a .cmd in the project folder.
REM The desktop shortcut runs the same script.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-app.ps1" %*
