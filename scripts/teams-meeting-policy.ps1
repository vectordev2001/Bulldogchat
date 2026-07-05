# teams-meeting-policy.ps1
# Idempotently applies the Bulldog "external guests skip the lobby" policy to a
# Microsoft 365 tenant's Global (Org-wide default) Teams meeting policy, plus the
# tenant-wide anonymous-join switch.
#
# Why this exists: Bulldog Chat sets `lobbyBypassSettings.scope = "everyone"` on
# every scheduled Teams meeting it creates via Graph. But tenant-level meeting
# policies silently override that per-meeting setting at join time, so an
# externally-invited guest ends up back in the lobby even though the meeting's
# own settings say otherwise. This script sets the four tenant-level knobs that
# have to line up for the per-meeting setting to actually take effect.
#
# Requirements
#   - Microsoft Teams PowerShell module 6.x or newer
#     Install-Module -Name MicrosoftTeams -Scope CurrentUser
#   - A Teams Administrator (or Global Administrator) account for the tenant
#
# Usage
#   pwsh ./scripts/teams-meeting-policy.ps1                            # applies to Global policy
#   pwsh ./scripts/teams-meeting-policy.ps1 -PolicyName "BulldogOpen"  # applies to a named policy
#   pwsh ./scripts/teams-meeting-policy.ps1 -WhatIf                    # dry run, no changes
#
# Idempotent: safe to run multiple times; only writes the values that have
# drifted. Emits a summary of what changed vs what was already correct so you
# can drop it into a runbook.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter()]
  [string]$PolicyName = "Global",

  [Parameter()]
  [switch]$SkipTenantSettings
)

$ErrorActionPreference = "Stop"

function Write-Section($msg) {
  Write-Host ""
  Write-Host "=== $msg ===" -ForegroundColor Cyan
}

function Ensure-Module {
  $mod = Get-Module -ListAvailable -Name MicrosoftTeams | Select-Object -First 1
  if (-not $mod) {
    throw "MicrosoftTeams PowerShell module is not installed. Run: Install-Module -Name MicrosoftTeams -Scope CurrentUser"
  }
  Write-Host "MicrosoftTeams module version: $($mod.Version)" -ForegroundColor DarkGray
  Import-Module MicrosoftTeams -ErrorAction Stop
}

function Ensure-Connected {
  try {
    $ctx = Get-CsTenant -ErrorAction Stop
    Write-Host "Connected to tenant: $($ctx.DisplayName) ($($ctx.TenantId))" -ForegroundColor Green
  } catch {
    Write-Host "Not connected. Launching Connect-MicrosoftTeams..." -ForegroundColor Yellow
    Connect-MicrosoftTeams -ErrorAction Stop | Out-Null
    $ctx = Get-CsTenant
    Write-Host "Connected to tenant: $($ctx.DisplayName) ($($ctx.TenantId))" -ForegroundColor Green
  }
}

# The exact set of settings that must be true for an anonymously-joined
# external guest to reach a Bulldog-created Teams meeting without hitting
# the lobby. Keep this dictionary in sync with the ensureLobbyBypass logic
# in server/teams/lobbyBypass.ts.
$desiredPolicy = @{
  AutoAdmittedUsers                   = "Everyone"
  AllowPSTNUsersToBypassLobby         = $true
  AllowAnonymousUsersToJoinMeeting    = $true
  AllowAnonymousUsersToStartMeeting   = $true
  # Nice-to-have: lets anonymous participants use meeting apps (transcript
  # download, whiteboard, etc.). Not required for lobby bypass but a common
  # ask so we set it consistently.
  AllowMeetNow                        = $true
}

Ensure-Module
Ensure-Connected

Write-Section "Reading current $PolicyName meeting policy"
$current = Get-CsTeamsMeetingPolicy -Identity $PolicyName -ErrorAction Stop

$changes = @{}
$noChanges = @()
foreach ($key in $desiredPolicy.Keys) {
  $want = $desiredPolicy[$key]
  $have = $current.$key
  if ($have -ne $want) {
    $changes[$key] = @{ From = $have; To = $want }
  } else {
    $noChanges += $key
  }
}

if ($noChanges.Count -gt 0) {
  Write-Host "Already correct:" -ForegroundColor DarkGreen
  foreach ($k in $noChanges) { Write-Host "  $k = $($current.$k)" -ForegroundColor DarkGreen }
}

if ($changes.Count -eq 0) {
  Write-Host "No changes needed for $PolicyName." -ForegroundColor Green
} else {
  Write-Section "Applying $($changes.Count) change(s) to $PolicyName"
  foreach ($k in $changes.Keys) {
    Write-Host ("  {0}: {1} -> {2}" -f $k, $changes[$k].From, $changes[$k].To) -ForegroundColor Yellow
  }
  $splat = @{ Identity = $PolicyName }
  foreach ($k in $changes.Keys) { $splat[$k] = $changes[$k].To }

  if ($PSCmdlet.ShouldProcess("Set-CsTeamsMeetingPolicy -Identity $PolicyName", "apply changes")) {
    Set-CsTeamsMeetingPolicy @splat
    Write-Host "Applied." -ForegroundColor Green
  }
}

if (-not $SkipTenantSettings) {
  Write-Section "Checking tenant-wide meeting settings"
  # Tenant-level anonymous-join is a separate cmdlet; the per-policy setting
  # cannot override it if this is off.
  $tenant = Get-CsTeamsMeetingConfiguration -ErrorAction Stop
  if ($tenant.DisableAnonymousJoin -eq $true) {
    Write-Host "Tenant has DisableAnonymousJoin=TRUE. Flipping to FALSE." -ForegroundColor Yellow
    if ($PSCmdlet.ShouldProcess("Set-CsTeamsMeetingConfiguration -DisableAnonymousJoin `$false", "apply")) {
      Set-CsTeamsMeetingConfiguration -DisableAnonymousJoin $false
      Write-Host "Applied." -ForegroundColor Green
    }
  } else {
    Write-Host "Tenant anonymous-join is already enabled (DisableAnonymousJoin=$($tenant.DisableAnonymousJoin))." -ForegroundColor DarkGreen
  }
}

Write-Section "Summary"
Write-Host "Policy propagation typically takes 30-60 min. Microsoft says up to 24 h."
Write-Host "Verify with a fresh scheduled meeting after ~1 h; external guests should skip the lobby."
Write-Host ""
Write-Host "Re-run this script safely any time: it's idempotent." -ForegroundColor DarkGray
