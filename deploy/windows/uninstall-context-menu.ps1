<#
.SYNOPSIS
    Removes the "Send with Airlock" right-click entry.

.DESCRIPTION
    Deletes the one per-user key install-context-menu.ps1 wrote. It touches
    nothing else: the app, its launcher and any transfers already sent are
    unaffected.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\uninstall-context-menu.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Restated from install-context-menu.ps1 on purpose, so either script can be run
# on its own. The * is a literal key name and a wildcard to every PowerShell path
# cmdlet, which would delete every match rather than this one, so the removal
# goes through the .NET registry API instead of Remove-Item.
$path = 'Software\Classes\*\shell\Airlock'

$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path)
if (-not $key) {
    Write-Host "Nothing to remove."
    return
}
$key.Close()

[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($path)
Write-Host "Removed. HKCU\$path is gone."
