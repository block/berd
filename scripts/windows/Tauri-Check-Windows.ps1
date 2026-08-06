$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = 0
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Update-SessionPathFromRegistry
Assert-MsvcEnvironment
Set-Location (Join-Path (Get-BerdRepoRoot) "src-tauri")

$env:CARGO_TARGET_DIR = Get-TauriCargoTargetDir
$env:TAURI_CONFIG = '{"bundle":{"externalBin":[]}}'
Write-WindowsDevInfo "Using Tauri Cargo target dir: $env:CARGO_TARGET_DIR"

Invoke-CheckedCommand -FilePath "cargo" -ArgumentList @("check") -Label "cargo check"
Invoke-CheckedCommand -FilePath "cargo" -ArgumentList @("check", "--features", (Get-BerdAppFeatures)) -Label "cargo check app features"
Invoke-CheckedCommand -FilePath "cargo" -ArgumentList @("check", "-p", "berdctl") -Label "cargo check -p berdctl"

Write-Host ""
Write-Host "Windows Tauri check passed." -ForegroundColor Green
