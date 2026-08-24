<#
.SYNOPSIS
    Adds "Send with Airlock" to the Windows right-click menu.

.DESCRIPTION
    Registers a per-user context-menu command and installs a small PowerShell
    handoff helper. Chromium filters undeclared filename suffixes before a PWA's
    launchQueue sees them, so the helper streams the selected file once over a
    random 127.0.0.1 address instead. Airlock stages the resulting File and its
    existing browser code performs all encryption and upload after Send.

    HKCU only: no administrator, and it uninstalls cleanly. Re-running points an
    existing entry at the launcher and Airlock origin that are current now.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install-context-menu.ps1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$Origin
)

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
#
# Newest wins, and newest is read from the directory rather than from the
# launcher: the launcher is a stub the browser copies, so every copy carries the
# stub's own date and they all tie. That tie matters, because an Airlock moved
# to a new address leaves the app installed at the old one behind, and picking
# the wrong one gives a menu entry that opens a server nobody is running.
$launcher = $roots |
    ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter 'Airlock.exe' -Recurse -File -ErrorAction SilentlyContinue } |
    Where-Object { $_.FullName -like '*Web Applications*' } |
    Sort-Object { $_.Directory.LastWriteTime } -Descending |
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

# Both halves of the app's address are in the launcher's own path, which is
# <User Data>\<profile>\Web Applications\_crx_<app id>\Airlock.exe. Read from
# there rather than asked for, so the entry cannot end up addressing a different
# profile's copy of the same app.
#
# The app id and profile are read from the launcher path rather than accepted as
# installer input. The context-menu helper later gives both back to the launcher
# with an in-scope URL; the selected filesystem path never appears on that
# browser command line.
$appId = $launcher.Directory.Name -replace '^_crx_', ''
$profile = $launcher.Directory.Parent.Parent.Name

# Chromium derives a PWA id by hashing the resolved manifest id twice and
# mapping the first 16 bytes to a-p. Airlock's manifest id is '/', so this lets
# the profile's own installed-site metrics identify the exact origin belonging
# to the launcher without guessing from a Tailscale hostname or port.
function Get-AirlockAppId([string]$ManifestId) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $first = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ManifestId))
        $second = $sha.ComputeHash($first)
    } finally {
        $sha.Dispose()
    }
    $alphabet = 'abcdefghijklmnop'
    $id = New-Object Text.StringBuilder
    foreach ($byte in $second[0..15]) {
        [void]$id.Append($alphabet[$byte -shr 4])
        [void]$id.Append($alphabet[$byte -band 15])
    }
    return $id.ToString()
}

function Normalize-AirlockOrigin([string]$Value) {
    try { $uri = [Uri]$Value } catch { throw "Airlock origin is not a valid URL: $Value" }
    if (-not $uri.IsAbsoluteUri) { throw "Airlock origin is not absolute: $Value" }
    $authority = $uri.GetLeftPart([UriPartial]::Authority)
    if ($uri.AbsoluteUri -ne "$authority/") {
        throw 'Airlock origin must contain only a scheme, host, and optional port.'
    }
    if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) {
        throw 'Airlock origin must use HTTPS, except on loopback.'
    }
    return "$authority/"
}

if ($Origin) {
    $airlockOrigin = Normalize-AirlockOrigin $Origin
    if ((Get-AirlockAppId $airlockOrigin) -ne $appId) {
        throw "The origin $airlockOrigin does not belong to the installed Airlock launcher $appId."
    }
} else {
    $preferences = Join-Path $launcher.Directory.Parent.Parent.FullName 'Preferences'
    $matches = @()
    if (Test-Path -LiteralPath $preferences) {
        try {
            $prefs = Get-Content -LiteralPath $preferences -Raw | ConvertFrom-Json
            foreach ($candidate in $prefs.web_apps.daily_metrics.PSObject.Properties) {
                if ($candidate.Value.installed -and
                    (Get-AirlockAppId $candidate.Name) -eq $appId) {
                    $matches += Normalize-AirlockOrigin $candidate.Name
                }
            }
        } catch {
            # The explicit -Origin path below is the recovery for a locked,
            # older, or otherwise unreadable browser preference file.
        }
    }
    $matches = @($matches | Select-Object -Unique)
    if ($matches.Count -ne 1) {
        throw 'Could not identify this installed app''s origin. Re-run with -Origin https://your-airlock-host:port'
    }
    $airlockOrigin = $matches[0]
}

$sourceBridge = Join-Path $PSScriptRoot 'context-menu-bridge.ps1'
if (-not (Test-Path -LiteralPath $sourceBridge -PathType Leaf)) {
    throw "The handoff helper is missing beside this installer: $sourceBridge"
}
$installDir = Join-Path $env:LOCALAPPDATA 'Airlock\Shell'
$installedBridge = Join-Path $installDir 'context-menu-bridge.ps1'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item -LiteralPath $sourceBridge -Destination $installedBridge -Force

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$command = "`"$powershell`" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$installedBridge`" -Launcher `"$($launcher.FullName)`" -Profile `"$profile`" -AppId $appId -Origin `"$airlockOrigin`" -FilePath `"%1`""

# The launcher is a stub the browser copies for every installed app, so its own
# first icon is the browser's, not Airlock's. Beside it the browser writes an
# .ico built from the app's manifest icons at every size the shell asks for,
# which is the mark this menu should carry. Falling back to the stub is still
# better than no entry, and it is what an older browser leaves behind.
$icon = Join-Path $launcher.DirectoryName 'Airlock.ico'
if (-not (Test-Path -LiteralPath $icon)) { $icon = "$($launcher.FullName),0" }

$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path)
try {
    $key.SetValue('', 'Send with Airlock')
    $key.SetValue('Icon', $icon)
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
Write-Host "  origin : $airlockOrigin"
Write-Host ""
Write-Host "The first right-click may ask whether Airlock can access devices on your"
Write-Host "local network. Choose Allow; the one-shot helper listens only on 127.0.0.1."
Write-Host ""
Write-Host "On Windows 11 the classic menu is behind 'Show more options', so that is"
Write-Host "where the entry appears. Shift+F10 opens it directly."
Write-Host ""
Write-Host "Remove it with .\uninstall-context-menu.ps1"
