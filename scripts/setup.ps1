<#
.SYNOPSIS
    Idempotent setup and verification for the Burkham Wickmont Operations Console repository.

.DESCRIPTION
    Verifies the local toolchain, git configuration, required repository files, and the GitHub
    remote. Safe to run repeatedly — it creates only what is missing and never overwrites
    existing content.

.PARAMETER Verify
    Check only. Report status and exit non-zero on any failure without changing anything.

.EXAMPLE
    pwsh -File scripts/setup.ps1
    pwsh -File scripts/setup.ps1 -Verify
#>
[CmdletBinding()]
param(
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$failures = @()
$warnings = @()

function Write-Head($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  [ ok ] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [warn] $text" -ForegroundColor Yellow; $script:warnings += $text }
function Write-Bad($text)  { Write-Host "  [fail] $text" -ForegroundColor Red;   $script:failures += $text }

Write-Head 'Toolchain'
$tools = [ordered]@{
    'git'    = 'git --version'
    'gh'     = 'gh --version'
    'node'   = 'node --version'
    'npm'    = 'npm --version'
    'psql'   = 'psql --version'
}
foreach ($name in $tools.Keys) {
    if (Get-Command $name -ErrorAction SilentlyContinue) {
        $version = (Invoke-Expression $tools[$name] | Select-Object -First 1)
        Write-Ok "$name — $version"
    } else {
        Write-Bad "$name not found on PATH"
    }
}

Write-Head 'Local services'
foreach ($svc in @('postgresql-x64-17', 'Memurai')) {
    $service = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if ($null -eq $service)             { Write-Warn "$svc not installed" }
    elseif ($service.Status -ne 'Running') { Write-Warn "$svc installed but $($service.Status)" }
    else                                { Write-Ok "$svc running" }
}

Write-Head 'Git repository'
if (-not (Test-Path (Join-Path $repoRoot '.git'))) {
    if ($Verify) { Write-Bad 'not a git repository' }
    else { git -C $repoRoot init -b main | Out-Null; Write-Ok 'initialized git repository' }
} else {
    Write-Ok "git repository present (branch: $(git -C $repoRoot rev-parse --abbrev-ref HEAD))"
}

$expectedEmail = 'ivannextlevel@yahoo.com'
$actualEmail = git -C $repoRoot config user.email
if ($actualEmail -ne $expectedEmail) {
    if ($Verify) { Write-Bad "git user.email is '$actualEmail', expected '$expectedEmail'" }
    else { git -C $repoRoot config user.email $expectedEmail; Write-Ok "set git user.email to $expectedEmail" }
} else {
    Write-Ok "git user.email — $actualEmail"
}

Write-Head 'Required files'
$required = @(
    'CLAUDE.md'
    'README.md'
    'CHANGELOG.md'
    '.gitignore'
    'docs/reference/blueprint-v2.md'
    'docs/reference/specifications-v2.md'
    '.claude/commands/impl-feature.md'
    '.claude/commands/test-suite.md'
    '.claude/commands/deploy-prod.md'
    '.claude/commands/code-review.md'
    '.claude/commands/api-test.md'
)
foreach ($rel in $required) {
    if (Test-Path (Join-Path $repoRoot $rel)) { Write-Ok $rel } else { Write-Bad "missing: $rel" }
}

Write-Head 'Secret hygiene'
$tracked = git -C $repoRoot ls-files
$leaked = $tracked | Where-Object { $_ -match '(^|/)\.env$|\.env\.(local|production)$|\.pem$|\.key$' }
if ($leaked) { foreach ($f in $leaked) { Write-Bad "secret-shaped file is tracked: $f" } }
else { Write-Ok 'no secret-shaped files tracked' }

Write-Head 'GitHub remote'
$remote = git -C $repoRoot remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0 -or -not $remote) {
    Write-Warn 'no origin remote configured — run: gh repo create navigreen311/Burkham-Wickmont-Operations-Console --private --source . --remote origin'
    $global:LASTEXITCODE = 0
} else {
    Write-Ok "origin — $remote"
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        $status = gh auth status 2>&1 | Out-String
        if ($status -match 'Logged in') { Write-Ok 'gh authenticated' } else { Write-Warn 'gh not authenticated — run: gh auth login' }
    }
}

Write-Head 'Summary'
Write-Host "  failures: $($failures.Count)   warnings: $($warnings.Count)"
if ($failures.Count -gt 0) {
    Write-Host "`nSetup incomplete:" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
Write-Host "`nSetup verified." -ForegroundColor Green
exit 0
