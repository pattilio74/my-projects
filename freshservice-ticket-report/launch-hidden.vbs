' Launches the Freshservice Ticket Report app with no visible console window.
' Runs launch-app.mjs (starts the server if needed, opens the app window).
Dim shell, fso, here, node, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)

' Prefer the default Node install location; fall back to PATH resolution.
node = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node"

cmd = """" & node & """ """ & here & "\launch-app.mjs"""
shell.CurrentDirectory = here
shell.Run cmd, 0, False   ' 0 = hidden window, False = don't wait
