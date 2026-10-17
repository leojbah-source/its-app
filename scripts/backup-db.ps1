# ============================================================================
# backup-db.ps1  —  TalentHub / Indian Talent Scan  database backup
#
# Takes a full, compressed snapshot of the PRODUCTION database using pg_dump.
# Run this BEFORE every deploy, and at the START and END of each event day.
#
# ONE-TIME SETUP
#   1. In the Render dashboard open the its-app (production) Postgres database.
#   2. Copy its "External Database URL" (starts with postgres://...).
#   3. Set it as an environment variable so it is NOT stored in the project:
#        setx PROD_DATABASE_URL "postgres://....external...."
#      Close and reopen PowerShell after running setx the first time.
#
# RUN
#   cd C:\ITS-APP
#   powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
#
# The dump is written to  C:\ITS-APP\backups\its-prod-YYYYMMDD-HHMMSS.dump
# (the backups folder is git-ignored, so backups are never pushed to GitHub).
# ============================================================================

$ErrorActionPreference = "Stop"

$dbUrl = $env:PROD_DATABASE_URL
if ([string]::IsNullOrWhiteSpace($dbUrl)) {
    Write-Host "PROD_DATABASE_URL is not set." -ForegroundColor Red
    Write-Host "Set it once with:  setx PROD_DATABASE_URL `"<Render External Database URL>`"" -ForegroundColor Yellow
    Write-Host "then close and reopen PowerShell and run this again."
    exit 1
}

# Find pg_dump (on PATH, or the usual PostgreSQL install locations)
$pgDump = "pg_dump"
if (-not (Get-Command $pgDump -ErrorAction SilentlyContinue)) {
    $candidate = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_dump.exe" -ErrorAction SilentlyContinue |
                 Sort-Object FullName -Descending | Select-Object -First 1
    if ($candidate) { $pgDump = $candidate.FullName }
    else {
        Write-Host "pg_dump was not found. Install the PostgreSQL client tools, or add pg_dump to PATH." -ForegroundColor Red
        exit 1
    }
}

$backupDir = Join-Path $PSScriptRoot "..\backups"
$backupDir = [System.IO.Path]::GetFullPath($backupDir)
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outFile = Join-Path $backupDir "its-prod-$stamp.dump"

Write-Host "Backing up production database to:" -ForegroundColor Cyan
Write-Host "  $outFile"
Write-Host "Using: $pgDump"

# -Fc = custom compressed format (restore with pg_restore). --no-owner/--no-acl
# keep the dump portable to a fresh database.
& $pgDump --format=custom --no-owner --no-acl --file="$outFile" "$dbUrl"

if ($LASTEXITCODE -ne 0) {
    Write-Host "Backup FAILED (pg_dump exit code $LASTEXITCODE)." -ForegroundColor Red
    if (Test-Path $outFile) { Remove-Item $outFile -Force }
    exit $LASTEXITCODE
}

$sizeMB = [math]::Round((Get-Item $outFile).Length / 1MB, 2)
Write-Host "Backup complete: $outFile ($sizeMB MB)" -ForegroundColor Green

# Keep the 30 most recent backups; delete older ones to save space.
$all = Get-ChildItem (Join-Path $backupDir "its-prod-*.dump") | Sort-Object LastWriteTime -Descending
if ($all.Count -gt 30) {
    $all | Select-Object -Skip 30 | ForEach-Object {
        Write-Host "Removing old backup: $($_.Name)" -ForegroundColor DarkGray
        Remove-Item $_.FullName -Force
    }
}
