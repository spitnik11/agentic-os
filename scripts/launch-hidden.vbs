' Launch Agentic OS with no console window.
'
' A shortcut that points at powershell.exe always shows a console, and
' -WindowStyle Hidden on the shortcut still flashes one briefly before hiding
' it. Running the script through WScript with intWindowStyle 0 shows nothing at
' all, which is what a desktop application should do.
'
' Because there is then no console to read, the PowerShell script is passed
' -Silent, which makes it report problems in a message box instead of writing
' them to a window nobody can see.
'
' Usage:
'   wscript.exe launch-hidden.vbs            launch the desktop app
'   wscript.exe launch-hidden.vbs -Web       launch browser mode instead

Option Explicit

Dim shell, fso, scriptDir, psScript, command, extraArgs, i

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = fso.BuildPath(scriptDir, "start-desktop.ps1")

If Not fso.FileExists(psScript) Then
    MsgBox "Cannot find start-desktop.ps1 in:" & vbCrLf & vbCrLf & scriptDir & _
           vbCrLf & vbCrLf & "The application files may have been moved.", _
           vbCritical, "Agentic OS"
    WScript.Quit 1
End If

' Pass through any arguments the shortcut supplied, such as -Web.
extraArgs = ""
For i = 0 To WScript.Arguments.Count - 1
    extraArgs = extraArgs & " " & WScript.Arguments(i)
Next

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & _
          psScript & """ -Silent" & extraArgs

' 0 = hidden window, False = do not wait for it to finish.
shell.Run command, 0, False
