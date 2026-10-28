# install-memory.ps1 - (re)install the dsh-memory plugin into a dsh profile.
#
# Idempotent and self-healing: copies the plugin package from this workspace into
# the profile's node_modules and makes the profile patch (cordis.patch.yml) mount
# it exactly once, from the right template files. A previous version of this
# script appended a comment block every time it ran while the mount row was
# missing, so the repair path now rebuilds the block from the two template files
# instead of appending to whatever is already there.
#
# Use it again after any pnpm install that prunes hand-placed packages (for
# example `dsh plugin --profile web add <pkg>`).
#
# Usage:
#   pwsh -File install-memory.ps1                     # install / repair into the web profile
#   pwsh -File install-memory.ps1 -Profile web        # explicit profile
#   pwsh -File install-memory.ps1 -FilesOnly          # ship new code, leave the patch alone
#   pwsh -File install-memory.ps1 -Remove             # unmount and delete
#   pwsh -File install-memory.ps1 -Test               # run the offline suite
param(
    [switch]$Remove,
    [switch]$Test,
    [switch]$FilesOnly,
    [string]$Profile = 'web',
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell's Get-Content/Set-Content default to the ANSI code page, which
# silently mangles any non-ASCII text in the profile patch (this file rewrites a
# patch that carries Chinese comments). Every read and write here goes through
# explicit UTF-8 instead.
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Read-Text([string]$Path) { return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) }
function Write-Text([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text, $utf8) }

# Two supported layouts:
#   - a clone of the plugin repository, where this script sits beside lib/
#   - a workspace that keeps the plugin in a `dsh-memory/` subdirectory
# Detecting the first makes the published repository self-contained instead of
# requiring callers to know which shape they have.
$source = if (Test-Path (Join-Path $PSScriptRoot 'lib\index.js')) { $PSScriptRoot } else { Join-Path $PSScriptRoot 'dsh-memory' }
$profileDir = Join-Path $DshHome "profiles\$Profile"
$target = Join-Path $profileDir 'node_modules\dsh-memory'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'

if ($Test) {
    Push-Location $PSScriptRoot
    try {
        foreach ($suite in @('store.test.mjs', 'prompt-contract.check.mjs', 'activate.check.mjs')) {
            Write-Output "--- $suite"
            & node (Join-Path $source "test\$suite")
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        Write-Output '--- check-patch.mjs'
        & node (Join-Path $source 'test\check-patch.mjs') $patchPath
    } finally { Pop-Location }
    exit $LASTEXITCODE
}

function Backup-Patch {
    if (Test-Path $patchPath) {
        $backup = "$patchPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item $patchPath $backup -Force
        return $backup
    }
    return $null
}

# Remove the dsh-memory comment block, the mount row, and the row's config.
# A skipped line counts toward a budget so a malformed file cannot swallow the
# rest of the patch.
function Remove-MemoryBlock {
    param([string]$Content)
    $kept = New-Object System.Collections.Generic.List[string]
    $skipping = $false
    $budget = 0
    foreach ($line in ($Content -split "`r?`n")) {
        if ($skipping) {
            if ($line -match "name:\s*'dsh\-memory'") { $budget = 24; continue }
            if ($line -match '^\s*#') { continue }
            if ($budget -gt 0 -and ($line.Trim().Length -eq 0 -or $line -match '^\s{4,}\S')) {
                $budget--
                continue
            }
            $skipping = $false
        }
        if ($line -match '^\s*#\s*dsh\-memory') { $skipping = $true; continue }
        $kept.Add($line)
    }
    return (($kept -join "`n").TrimEnd() + "`n")
}

if ($Remove) {
    if (Test-Path $target) { Remove-Item $target -Recurse -Force; Write-Output "removed: $target" }
    if (Test-Path $patchPath) {
        $backup = Backup-Patch
        $cleaned = Remove-MemoryBlock -Content (Read-Text $patchPath)
        Write-Text $patchPath $cleaned
        Write-Output "patch cleaned (backup: $backup)"
    }
    exit 0
}

# ---------------------------------------------------------------------------
# 1. Copy the plugin into the profile.
# ---------------------------------------------------------------------------
if (-not (Test-Path (Join-Path $source 'lib\index.js'))) { throw "plugin source not found at $source" }
New-Item -ItemType Directory -Path (Join-Path $target 'lib') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $target 'test') -Force | Out-Null
foreach ($file in @('package.json', 'README.md', 'README.zh.md', 'cordis.patch.snippet.yml')) {
    Copy-Item (Join-Path $source $file) (Join-Path $target $file) -Force
}
foreach ($file in @('lib\index.js', 'lib\store.js', 'lib\render.js')) {
    Copy-Item (Join-Path $source $file) (Join-Path $target $file) -Force
}
Copy-Item (Join-Path $source 'test\*.mjs') (Join-Path $target 'test\') -Force
Write-Output "installed: $target"

# ---------------------------------------------------------------------------
# 2. Mount it in the profile patch, exactly once.
#
# Two safety gates, because this file is the user's own configuration and an
# earlier version of this script overwrote it:
#
#   -FilesOnly skips this step entirely, for the common case of shipping new
#   code to a profile whose mount row the user has already customized.
#
# Otherwise, a mount row that carries hand-written settings (bootUris, a custom
# storeDir, ...) is left ALONE. The template only knows the defaults, so
# rebuilding a customized row would silently drop those settings; the script
# says so and exits instead.
# ---------------------------------------------------------------------------
if ($FilesOnly) {
    Write-Output ''
    Write-Output 'FilesOnly: the profile patch was not touched.'
    Write-Output 'Restart dsh for the new code to load.'
    exit 0
}

if (-not (Test-Path $patchPath)) { throw "profile patch not found at $patchPath" }
$commentPath = Join-Path $source 'cordis.patch.snippet.yml'
$entryPath = Join-Path $source 'cordis.patch.entry.txt'
foreach ($file in @($commentPath, $entryPath)) {
    if (-not (Test-Path $file)) { throw "patch template not found at $file" }
}
$commentBlock = (Read-Text $commentPath).TrimEnd()
$entryBlock = (Read-Text $entryPath).TrimEnd()

$content = Read-Text $patchPath
$mounted = $content -match "name:\s*'dsh\-memory'"

# Keys a human is expected to edit. Their presence means the row is customized.
$handEdited = @('bootUris', 'storeDir', 'globalDomains', 'injectChars', 'workingLimit', 'pressureRatio', 'contextWindow')
$inRow = $false
$customized = @()
foreach ($line in ($content -split "`r?`n")) {
    if ($line -match "name:\s*'dsh\-memory'") { $inRow = $true; continue }
    if ($inRow) {
        if ($line -match '^\s{4,}\S') {
            foreach ($key in $handEdited) {
                if ($line -match "^\s+$key\s*:") { $customized += $key }
            }
            continue
        }
        $inRow = $false
    }
}
if ($mounted -and $customized.Count -gt 0) {
    Write-Output ''
    Write-Output "patch NOT touched: the dsh-memory row carries hand-written settings ($($customized -join ', '))."
    Write-Output "Rebuilding it from the template would drop them, so this run only refreshed the plugin files."
    Write-Output "The row's defaults are documented in $entryPath; the code is already in place - just restart dsh."
    exit 0
}

$body = Remove-MemoryBlock -Content $content
$backup = Backup-Patch

if ($body.Trim() -eq '[]') { $body = '' }
$next = ($body.TrimEnd() + "`n`n" + $commentBlock + "`n" + $entryBlock + "`n").TrimStart("`n")
Write-Text $patchPath $next

if ($mounted) { Write-Output "patch refreshed (mount row rebuilt from the template): $patchPath" }
else { Write-Output "patch updated (dsh-memory mounted): $patchPath" }
Write-Output "backup: $backup"

Write-Output ''
Write-Output 'Done. Next steps:'
Write-Output "  1. reload the dsh Web page (or restart 'dsh web') so the tools are mounted"
Write-Output "  2. open a NEW conversation: an existing one keeps the tool list it started with"
Write-Output '  3. ask the agent to write its core memories, then put those URIs in bootUris'
Write-Output "     (edit $patchPath; the patch layer is live-reloaded)"
