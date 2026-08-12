param(
    [string]$OutputPath = "release/windows/Berd-unsigned-setup.exe"
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

$targetDir = Get-TauriCargoTargetDir
$nsisDir = Join-Path $targetDir "x86_64-pc-windows-msvc/release/bundle/nsis"
$installers = @(Get-ChildItem -LiteralPath $nsisDir -Filter "*-setup.exe" -File)
if ($installers.Count -ne 1) {
    throw "Windows bundle produced $($installers.Count) NSIS installers under $nsisDir; expected exactly one."
}

$outputFullPath = [System.IO.Path]::GetFullPath((Join-Path (Get-BerdRepoRoot) $OutputPath))
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outputFullPath) | Out-Null
Copy-Item -LiteralPath $installers[0].FullName -Destination $outputFullPath -Force
if (-not (Test-Path -LiteralPath $outputFullPath -PathType Leaf)) {
    throw "Windows installer copy did not produce $outputFullPath"
}
Write-Host "Collected unsigned Windows installer: $outputFullPath"
