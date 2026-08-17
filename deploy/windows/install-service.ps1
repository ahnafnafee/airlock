<#
.SYNOPSIS
    Registers Airlock as a logon task for the current user.

.DESCRIPTION
    A scheduled task, not a Windows service. Two reasons:

    1. Register-ScheduledTask -AtLogOn succeeds without elevation, while
       schtasks /sc onlogon is refused. This script therefore runs from an
       ordinary prompt.
    2. A real Windows service would need both elevation and the Service
       Control Manager protocol implemented inside airlock.exe. A plain
       console binary registered as a service starts, never reports back to
       the SCM, and is killed with error 1053 after the timeout. Airlock does
       not speak that protocol, so it is not offered as a service.

    The task runs airlock.exe with an explicit --port and an absolute --data.
    The path is absolute because a scheduled task does not inherit a shell's
    working directory: it starts in System32, and a relative data directory
    there creates a fresh salt and an empty store, which looks like data loss
    rather than a path mistake.

.PARAMETER ExePath
    Full path to airlock.exe. Defaults to the binary next to the repository
    root, two levels above this script.

.PARAMETER DataDir
    Data directory, made absolute before it is written into the task. The
    default mirrors the Windows default in defaultDataDir() in main.go, so an
    existing store is found rather than a second one created. Change one and
    the other has to move with it.

.PARAMETER Port
    HTTPS port on the tailnet address. 443 is the default the server uses.
    Pass 4443 on a machine where something already holds 443.

.PARAMETER TaskName
    Name of the registered task.

.EXAMPLE
    .\install-service.ps1 -Port 4443
#>
[CmdletBinding()]
param(
    [string]$ExePath,
    [string]$DataDir,
    [int]$Port = 443,
    [string]$TaskName = 'Airlock'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ExePath) {
    $ExePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'airlock.exe'
}
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    throw "airlock.exe not found at $ExePath. Build it with 'go build -o airlock.exe .' or pass -ExePath."
}
$ExePath = (Resolve-Path -LiteralPath $ExePath).ProviderPath

if (-not $DataDir) {
    $DataDir = Join-Path $env:LOCALAPPDATA 'Airlock'
}
if (-not (Test-Path -LiteralPath $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}
$DataDir = (Resolve-Path -LiteralPath $DataDir).ProviderPath

if ($Port -lt 1 -or $Port -gt 65535) {
    throw "Port $Port is not a TCP port."
}

# Bind-test before registering. netsh and Get-NetTCPConnection both report the
# listener table, and neither reports the case that actually bites on Windows:
# a holder using SO_EXCLUSIVEADDRUSE, which Winsock refuses with access denied
# rather than address in use. Only an actual bind answers the question.
#
# ExclusiveAddressUse is set on purpose, and it is load-bearing rather than
# decorative. Without it a wildcard test bind succeeds while another process
# holds the same port on a single address, which is precisely the case this
# script exists to catch. It also biases the test the safe way: exclusive can
# refuse a port the server would have got, and the cost of that is a second
# port number, while the opposite error registers a task that can never start.
function Test-BindFree {
    param(
        [Parameter(Mandatory)][string]$Address,
        [Parameter(Mandatory)][int]$TcpPort
    )
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($Address), $TcpPort)
        $listener.ExclusiveAddressUse = $true
        $listener.Start()
        return $null
    } catch {
        return $_.Exception.GetBaseException().Message
    } finally {
        if ($null -ne $listener) { $listener.Stop() }
    }
}

# Host mode binds the machine's own tailnet addresses, not the wildcard, so the
# tailnet addresses are the ones worth testing. Ask tailscale for them.
$targets = @()
$approximate = $false
$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if ($tailscale) {
    $ips = & $tailscale.Source ip 2>$null
    if ($LASTEXITCODE -eq 0 -and $ips) {
        # Keep only what actually parses as an address. A warning line or a
        # future change of output format would otherwise reach Parse and be
        # reported as a busy port, refusing an install for the wrong reason.
        $targets = @($ips | ForEach-Object { $_.Trim() } |
            Where-Object { [System.Net.IPAddress]::TryParse($_, [ref]$null) })
    }
}
if ($targets.Count -eq 0) {
    # No tailnet address to test, so test the wildcard instead. An exclusive
    # wildcard bind conflicts with a bind on any single address, so this can
    # report busy where the tailnet address alone would have been free. It
    # never reports free where the tailnet address is busy, which is the
    # direction that matters.
    $targets = @('0.0.0.0')
    $approximate = $true
}

foreach ($target in $targets) {
    $failure = Test-BindFree -Address $target -TcpPort $Port
    if ($failure) {
        $advice = if ($Port -eq 443) {
            "Something already holds port 443 on this machine. 'tailscale serve' is the usual answer. Re-run with -Port 4443."
        } else {
            "Something already holds port $Port on this machine. Re-run with a different -Port."
        }
        if ($approximate) {
            $advice += " The test used the wildcard address because no tailnet address could be read from tailscale, so it is the pessimistic answer."
        }
        throw "Cannot bind ${target}:${Port}. $failure`n$advice`nNothing was registered."
    }
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$arguments = '--port {0} --data "{1}"' -f $Port, $DataDir

$action = New-ScheduledTaskAction -Execute $ExePath -Argument $arguments -WorkingDirectory (Split-Path -Parent $ExePath)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Description 'Airlock encrypted transfer, started at logon.' `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Force | Out-Null

Write-Host ""
Write-Host "Registered the scheduled task '$TaskName'."
Write-Host "  runs   : $ExePath $arguments"
Write-Host "  as     : $user"
Write-Host "  starts : at logon"
Write-Host ""
Write-Host "Start it now without logging out:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "Then open https://<this-machine>.<your-tailnet>.ts.net:$Port/ from any device on your tailnet."
Write-Host ""
Write-Host "Known limitation, stated because it is the point of an Interactive principal:"
Write-Host "  Interactive is what lets this register without elevation, and the behavior to"
Write-Host "  expect from it is that Airlock lives inside your logged-on session. It starts at"
Write-Host "  logon, and it is not expected to survive logoff, so the queue would be unreachable"
Write-Host "  while nobody is signed in. That last part was not tested here, so treat it as the"
Write-Host "  documented expectation rather than a measured result: if uptime across logoff"
Write-Host "  matters to you, verify it on your own machine before relying on it."
Write-Host "  Running before anyone logs in is a different install: one elevated registration"
Write-Host "  with a service-account principal, which this script deliberately does not do."
Write-Host ""
Write-Host "Remove it with .\uninstall-service.ps1"
