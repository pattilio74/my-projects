# Creates a Desktop shortcut that launches the Freshservice Ticket Report app.
$ErrorActionPreference = "Stop"

$appDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs      = Join-Path $appDir "launch-hidden.vbs"
$desktop  = [Environment]::GetFolderPath("Desktop")
$linkPath = Join-Path $desktop "Freshservice Ticket Report.lnk"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($linkPath)
# Launch via wscript + the hidden VBS so no console window appears.
$sc.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
$sc.Arguments        = '"' + $vbs + '"'
$sc.WorkingDirectory = $appDir
$sc.Description      = "Open the Freshservice Ticket Report app"

# Use Edge's icon if available, otherwise node's own icon.
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (Test-Path $edge) { $sc.IconLocation = "$edge,0" } else { $sc.IconLocation = "$node,0" }

$sc.Save()
Write-Output "Created shortcut: $linkPath"
Write-Output "Target: $($sc.TargetPath) $($sc.Arguments)"
