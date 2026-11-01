# Install, update or check the Proteus skill for Claude Code on Windows.
# All logic lives in install.js; this only finds node and maps the switches.
# Windows blocks unsigned scripts by default, so run it as:
#
#   powershell -ExecutionPolicy Bypass -File install.ps1                     skills + agents for every repo
#   powershell -ExecutionPolicy Bypass -File C:\path\to\proteus\install.ps1 -Project
#                                  also set up the current repo: teams\ with linked skills and
#                                  the lead's autostart + guard hooks
#   ... -Project -Install -Confine fetch missing skills, hide them from the lead
#   ... -Project -Guest            guest mode, for a repo you do not own: teams\ and the lead's docs
#                                  outside the repo (-NoGuest: install into the repo)
#   ... -Update                    move this checkout to the newest verified signed release, reinstall, refresh the current repo
#   ... -AutoUpdate                let sessions do that update (-NoAutoUpdate: stop)
#   ... -Doctor [-Fix]             check the setup; -Fix applies the safe local fixes
#   ... -Harness codex             any of the above for Codex CLI instead of Claude Code
#   ... -Migrate [-DryRun] [-Scan <dir>,<dir>]   move every repo still on 1.x to the Claude Code plugin
#   ... -PluginSetup [-OnlyHere] [-DryRun]   what /proteus:setup runs: this repo, then every other 1.x repo
#   ... -PluginSetup -Local   or -Project -Local: keep the project on this machine, no code host (docs/local-mode.md)
#   ... -Export <owner/repo> [-Yes] [-Public]   move a local-mode repo to an empty repo on a code host; without -Yes, only the plan
#
# Or skip PowerShell entirely: node C:\path\to\proteus\install.js --project
param([switch]$Project, [switch]$Install, [switch]$Confine, [switch]$Update,
      [switch]$Doctor, [switch]$Fix, [switch]$AutoUpdate, [switch]$NoAutoUpdate, [string]$Harness,
      [string[]]$Scan, [switch]$Guest, [switch]$NoGuest,
      [switch]$Migrate, [switch]$PluginSetup, [switch]$OnlyHere, [switch]$DryRun, [switch]$Local,
      [string]$Export, [switch]$Yes, [switch]$Public)

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "node not found; install Node 22.5+, open a new terminal, and re-run:"
    Write-Host "  winget install OpenJS.NodeJS.LTS"
    exit 1
}
$flags = @()
if ($Project)      { $flags += "--project" }
if ($Install)      { $flags += "--install" }
if ($Confine)      { $flags += "--confine" }
if ($Update)       { $flags += "--update" }
if ($Doctor)       { $flags += "--doctor" }
if ($Fix)          { $flags += "--fix" }
if ($AutoUpdate)   { $flags += "--auto-update" }
if ($NoAutoUpdate) { $flags += "--no-auto-update" }
if ($Harness)      { $flags += "--harness", $Harness }
foreach ($d in $Scan) { $flags += "--scan", $d }
if ($Migrate)      { $flags += "--migrate" }
if ($PluginSetup)  { $flags += "--plugin-setup" }
if ($OnlyHere)     { $flags += "--only-here" }
if ($Local)        { $flags += "--local" }
if ($Export)       { $flags += "--export", $Export }
if ($Yes)          { $flags += "--yes" }
if ($Public)       { $flags += "--public" }
if ($DryRun)       { $flags += "--dry-run" }
if ($Guest)        { $flags += "--guest" }
if ($NoGuest)      { $flags += "--no-guest" }
& node (Join-Path $PSScriptRoot "install.js") @flags
exit $LASTEXITCODE
