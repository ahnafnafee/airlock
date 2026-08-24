<#
.SYNOPSIS
    Hands one Explorer-selected file to the installed Airlock app.

.DESCRIPTION
    Chromium refuses to forward a filename suffix a PWA manifest did not name.
    This helper avoids that browser gate without becoming an uploader: it binds
    a random one-shot endpoint on 127.0.0.1, launches Airlock with that address,
    and streams the selected bytes only to Airlock's origin. The browser then
    stages the File and the normal Send button performs all encryption.

    Installed and invoked by install-context-menu.ps1. It is not intended to be
    run directly.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Launcher,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Profile,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$AppId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Origin,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$FilePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-HttpHeaders {
    param(
        [Parameter(Mandatory = $true)] [System.IO.Stream]$Stream,
        [Parameter(Mandatory = $true)] [string]$Status,
        [Parameter(Mandatory = $true)] [hashtable]$Headers
    )

    $lines = @("HTTP/1.1 $Status")
    foreach ($name in $Headers.Keys) {
        $lines += "$name`: $($Headers[$name])"
    }
    $wire = [Text.Encoding]::ASCII.GetBytes(($lines -join "`r`n") + "`r`n`r`n")
    $Stream.Write($wire, 0, $wire.Length)
    $Stream.Flush()
}

function Read-HttpRequest {
    param([Parameter(Mandatory = $true)] [System.IO.Stream]$Stream)

    $reader = New-Object System.IO.StreamReader(
        $Stream, [Text.Encoding]::ASCII, $false, 1024, $true)
    $line = $reader.ReadLine()
    if (-not $line) { return $null }

    $headers = @{}
    $count = $line.Length
    while ($true) {
        $header = $reader.ReadLine()
        if ($null -eq $header -or $header.Length -eq 0) { break }
        $count += $header.Length
        if ($count -gt 16384) { throw 'HTTP request headers were too large.' }
        $at = $header.IndexOf(':')
        if ($at -lt 1) { throw 'HTTP request header was malformed.' }
        $headers[$header.Substring(0, $at).Trim().ToLowerInvariant()] =
            $header.Substring($at + 1).Trim()
    }
    return @{ Line = $line; Headers = $headers }
}

if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
    throw "The installed Airlock launcher is missing: $Launcher"
}
if ($Profile.Contains('"')) { throw 'The browser profile name is invalid.' }

$resolved = (Resolve-Path -LiteralPath $FilePath -ErrorAction Stop).ProviderPath
if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "The selected path is not a file: $FilePath"
}

$originUri = [Uri]$Origin
$originText = $originUri.GetLeftPart([UriPartial]::Authority)
if (-not $originUri.IsAbsoluteUri -or $originUri.AbsoluteUri -ne "$originText/") {
    throw 'The Airlock origin must contain only a scheme, host, and optional port.'
}
if ($originUri.Scheme -ne 'https' -and
    -not ($originUri.Scheme -eq 'http' -and $originUri.IsLoopback)) {
    throw 'The Airlock origin must use HTTPS, except on loopback.'
}

$random = New-Object byte[] 32
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $generator.GetBytes($random)
} finally {
    $generator.Dispose()
}
$token = -join ($random | ForEach-Object { $_.ToString('x2') })

$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
$listener.Start(8)
$complete = $false
try {
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $bridgeURL = "http://127.0.0.1:$port/airlock-handoff/$token"
    $launchURL = "$originText/?handoff=$([Uri]::EscapeDataString($bridgeURL))"

    # ProcessStartInfo keeps the selected path out of a second command line. It
    # appears only when the browser asks the loopback endpoint for its bytes.
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Launcher
    $start.Arguments = "--profile-directory=`"$Profile`" --app-id=$AppId `"$launchURL`""
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($start)
    if ($process) { $process.Dispose() }

    # Five minutes covers a cold app that still needs to be unlocked. An
    # abandoned right-click expires by itself and leaves neither a listener nor
    # a copy of the plaintext behind.
    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    while (-not $complete -and [DateTime]::UtcNow -lt $deadline) {
        if (-not $listener.Pending()) {
            Start-Sleep -Milliseconds 100
            continue
        }

        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 10000
            $client.SendTimeout = 30000
            $stream = $client.GetStream()
            $request = Read-HttpRequest -Stream $stream
            if (-not $request) { continue }

            $parts = $request.Line.Split(' ')
            if ($parts.Length -ne 3 -or
                $parts[1] -ne "/airlock-handoff/$token" -or
                $request.Headers['origin'] -ne $originText) {
                Write-HttpHeaders -Stream $stream -Status '404 Not Found' -Headers @{
                    'Content-Length' = '0'
                    'Connection' = 'close'
                }
                continue
            }

            $cors = @{
                'Access-Control-Allow-Origin' = $originText
                'Access-Control-Allow-Methods' = 'POST, OPTIONS'
                'Access-Control-Allow-Headers' = 'X-Airlock-Handoff'
                'Access-Control-Allow-Private-Network' = 'true'
                'Vary' = 'Origin'
                'Connection' = 'close'
            }
            if ($parts[0] -eq 'OPTIONS') {
                $cors['Content-Length'] = '0'
                $cors['Access-Control-Max-Age'] = '60'
                Write-HttpHeaders -Stream $stream -Status '204 No Content' -Headers $cors
                continue
            }
            if ($parts[0] -ne 'POST' -or
                $request.Headers['x-airlock-handoff'] -ne $token) {
                Write-HttpHeaders -Stream $stream -Status '405 Method Not Allowed' -Headers @{
                    'Content-Length' = '0'
                    'Connection' = 'close'
                }
                continue
            }

            # Opening only after the authenticated request avoids holding a file
            # lock while the app starts or while a permission prompt is open.
            $file = New-Object IO.FileStream(
                $resolved, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
                $info = Get-Item -LiteralPath $resolved
                $nameBytes = [Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFileName($resolved))
                $encodedName = [Convert]::ToBase64String($nameBytes).TrimEnd('=').
                    Replace('+', '-').Replace('/', '_')
                $modified = ([DateTimeOffset]$info.LastWriteTimeUtc).ToUnixTimeMilliseconds()

                $cors['Access-Control-Expose-Headers'] =
                    'X-Airlock-Handoff, X-Airlock-Name, X-Airlock-Modified'
                $cors['Cache-Control'] = 'no-store'
                $cors['Content-Type'] = 'application/octet-stream'
                $cors['Content-Length'] = $file.Length.ToString([Globalization.CultureInfo]::InvariantCulture)
                $cors['X-Airlock-Handoff'] = $token
                $cors['X-Airlock-Name'] = $encodedName
                $cors['X-Airlock-Modified'] = $modified.ToString([Globalization.CultureInfo]::InvariantCulture)
                Write-HttpHeaders -Stream $stream -Status '200 OK' -Headers $cors
                $file.CopyTo($stream, 1048576)
                $stream.Flush()
                $complete = $true
            } finally {
                $file.Dispose()
            }
        } catch {
            # A scanner, canceled fetch, or closed window must not strand the
            # listener. Only a fully streamed authenticated response consumes
            # the token; otherwise the app's Try again action can reconnect.
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}

if (-not $complete) { exit 2 }
