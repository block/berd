# Run sidecar staging as a native PowerShell child and propagate its exit state.
# Keeping this boundary in a script avoids just's in-process PowerShell shebang,
# where a successful .ps1 invocation can leave $LASTEXITCODE stale or unset.
param(
    [string]$StageScriptPath = (Join-Path $PSScriptRoot "Stage-Sidecar-Windows.ps1")
)

$ErrorActionPreference = "Stop"
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking
$env:GOOSE_BUILD_PROFILE = "debug"
Invoke-WindowsChildScript -ScriptPath $StageScriptPath -Label "Stage-Sidecar-Windows.ps1"
