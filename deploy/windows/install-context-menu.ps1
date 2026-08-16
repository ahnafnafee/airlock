<#
.SYNOPSIS
    Adds "Send with Airlock" to the right-click menu for every file type.

.DESCRIPTION
    A browser-only product cannot install a shell extension and should not try.
    What it can do is register a per-user context-menu command pointing at the
    launcher Chrome or Edge already creates when the PWA is installed. That
    launcher takes a file path and hands it to the app's launchQueue, the same
    path the Open with menu uses, so the file is staged in the Send view and
    waits for a destination.

    Nothing is shipped but a registry key. A helper that uploaded straight from
    the shell would need the passphrase, and it would become a second
    implementation of the encryption, which is the same reason there is no
    native client.

    HKCU only: no administrator, and it uninstalls cleanly. Re-running points an
    existing entry at the launcher that is current now.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install-context-menu.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$roots = @(
    "$env:LOCALAPPDATA\Google\Chrome\User Data",
    "$env:LOCALAPPDATA\Microsoft\Edge\User Data",
    "$env:LOCALAPPDATA\Chromium\User Data"
) | Where-Object { Test-Path -LiteralPath $_ }

if (-not $roots) {
    throw "No Chrome, Edge or Chromium profile found. Install Airlock as an app first."
}

# Scoped to the browser profile directories rather than a disk sweep. The
# launcher is written to <profile>\Web Applications\<app>\Airlock.exe, so a
# match anywhere else is some other Airlock.exe and is not what this points at.
# Newest wins, because a profile that installed the app more recently is the one
# whose launcher is current.
$launcher = $roots |
    ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter 'Airlock.exe' -Recurse -File -ErrorAction SilentlyContinue } |
    Where-Object { $_.FullName -like '*Web Applications*' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $launcher) {
    throw "Airlock is not installed as an app yet. Open it in Chrome or Edge, install it from the address bar, then run this again."
}

# The class key that means "every file" is literally named *, and that is a
# wildcard to every PowerShell path cmdlet: Set-ItemProperty on this path writes
# to each Classes subkey that matches, and Remove-Item deletes all of them. Only
# New-Item takes it literally, and it has no -LiteralPath to say so with. The
# .NET registry API has no wildcard semantics at all, so it is what this uses.
#
# uninstall-context-menu.ps1 restates this path on purpose, so either script can
# be run on its own. Renaming the key means editing both.
$path = 'Software\Classes\*\shell\Airlock'
$command = "`"$($launcher.FullName)`" `"%1`""

$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path)
try {
    $key.SetValue('', 'Send with Airlock')
    $key.SetValue('Icon', "$($launcher.FullName),0")
} finally {
    $key.Close()
}

$verb = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("$path\command")
try {
    $verb.SetValue('', $command)
} finally {
    $verb.Close()
}

Write-Host ""
Write-Host "Installed. Right-click any file and choose 'Send with Airlock'."
Write-Host "  key    : HKCU\$path"
Write-Host "  runs   : $command"
Write-Host ""
Write-Host "On Windows 11 the classic menu is behind 'Show more options', so that is"
Write-Host "where the entry appears. Shift+F10 opens it directly."
Write-Host ""
Write-Host "Remove it with .\uninstall-context-menu.ps1"
