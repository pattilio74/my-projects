$appDir   = $PSScriptRoot
$target   = Join-Path $appDir 'open-customer-sla.cmd'
$desktop  = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop 'Customer SLA.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath       = $target
$shortcut.WorkingDirectory = $appDir
$shortcut.Description       = 'Freshservice Customer SLA Dashboard'
$shortcut.WindowStyle       = 7   # minimized launcher window
$shortcut.IconLocation      = "$env:SystemRoot\System32\SHELL32.dll,13"
$shortcut.Save()

if (Test-Path $linkPath) {
  Write-Output "SHORTCUT_CREATED: $linkPath"
} else {
  Write-Output "SHORTCUT_FAILED"
}
