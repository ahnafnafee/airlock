<#
.SYNOPSIS
    Removes the Airlock logon task registered by install-service.ps1.

.DESCRIPTION
    Stops the task if it is running, then unregisters it. Needs no elevation,
    for the same reason the install does not: the task belongs to the user who
    registered it.

    Nothing under --data is touched. The store holds sealed chunks and the
    permanent salt every device's key derives from, so deleting it is a
    separate and irreversible decision, not a side effect of unregistering a
    task.

.PARAMETER TaskName
    Name of the task to remove. Must match the name used at install.

.EXAMPLE
    .\uninstall-service.ps1
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'Airlock'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "No scheduled task named '$TaskName'. Nothing to remove."
    return
}

if ($task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    Write-Host "Stopped '$TaskName'."
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed the scheduled task '$TaskName'."
Write-Host "The data directory was left alone. Delete it by hand if you mean to."
