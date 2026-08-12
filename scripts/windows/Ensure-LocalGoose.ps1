param(
    [switch]$PrintBin,
    [switch]$CheckBin
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

try {
    Assert-WindowsHost
    Update-SessionPathFromRegistry
    $action = "Build"
    if ($CheckBin) {
        $action = "Check"
    }
    # Exit codes mirror scripts/ensure-local-goose.sh: in the default "auto"
    # mode a skipped/failed optional build exits 0 and a failed check exits 2;
    # set GOOSE_DEV_MODE=required (as Setup-Windows.ps1 does) to make any
    # failure fatal.
    $result = Invoke-EnsureLocalGoose -Action $action
    if ($PrintBin -and $result.Ready -and -not [string]::IsNullOrWhiteSpace($result.BinPath)) {
        Write-Output $result.BinPath
    }
    exit $result.ExitCode
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
