<#
.SYNOPSIS
    Removes the "Send with Airlock" right-click entry.

.DESCRIPTION
    Deletes the per-user key and the copied loopback handoff script written by
    install-context-menu.ps1. The app, browser launcher, and transfers already
    sent are unaffected.

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

$removed = $false
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path)
if ($key) {
    $key.Close()
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($path)
    $removed = $true
}

$installDir = Join-Path $env:LOCALAPPDATA 'Airlock\Shell'
$helper = Join-Path $installDir 'context-menu-bridge.ps1'
if (Test-Path -LiteralPath $helper -PathType Leaf) {
    Remove-Item -LiteralPath $helper -Force
    $removed = $true
}
if ((Test-Path -LiteralPath $installDir -PathType Container) -and
    -not (Get-ChildItem -LiteralPath $installDir -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $installDir
}

if ($removed) {
    Write-Host "Removed the Airlock context menu and its loopback handoff helper."
} else {
    Write-Host "Nothing to remove."
}
