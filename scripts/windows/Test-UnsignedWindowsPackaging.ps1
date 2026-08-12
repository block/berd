$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("berd-unsigned-windows-test-" + [System.Guid]::NewGuid().ToString("N"))
$oldTargetDir = $env:BERD_TAURI_CARGO_TARGET_DIR
$workflow = Get-Content -Raw (Join-Path $repoRoot ".github/workflows/unsigned-desktop-build.yml")
if (-not $workflow.Contains("`$target = Join-Path `$env:LOCALAPPDATA 'berd-dev\cargo-target'")) {
    throw "Unsigned Windows workflow does not resolve the managed Goose Cargo target from the runner process environment."
}
if (-not $workflow.Contains('"GOOSE_DEV_CARGO_TARGET_DIR=$target" >> $env:GITHUB_ENV')) {
    throw "Unsigned Windows workflow does not publish the resolved Goose target for subsequent steps."
}
if (-not $workflow.Contains('path: ${{ env.GOOSE_DEV_CARGO_TARGET_DIR }}')) {
    throw "Unsigned Windows workflow cache does not consume the resolved managed Goose target."
}
if (-not $workflow.Contains('key: goose-cargo-${{ runner.os }}-rust-1.94.1-${{ hashFiles(''goose-backend.lock.json'') }}')) {
    throw "Unsigned Windows workflow cache key is not bound to OS, Rust 1.94.1, and goose-backend.lock.json."
}
$moduleSource = Get-Content -Raw (Join-Path $PSScriptRoot "WindowsDev.psm1")
foreach ($requiredCheck in @("Test-GooseStamp", "Get-FileSha256 -Path `$BinPath", "Get-GitHead -Repo `$paths.Repo")) {
    if ($moduleSource -notmatch [regex]::Escape($requiredCheck)) {
        throw "Managed Goose cache validation lost required check: $requiredCheck"
    }
}
try {
    $env:BERD_TAURI_CARGO_TARGET_DIR = Join-Path $tempRoot "cargo-target"
    $nsisDir = Join-Path $env:BERD_TAURI_CARGO_TARGET_DIR "x86_64-pc-windows-msvc\release\bundle\nsis"
    New-Item -ItemType Directory -Force -Path $nsisDir | Out-Null
    $fixture = Join-Path $nsisDir "Berd_test_x64-setup.exe"
    [System.IO.File]::WriteAllBytes($fixture, [byte[]](1, 2, 3))

    $relativeOutput = "release/windows-test/Berd-unsigned-setup.exe"
    & (Join-Path $PSScriptRoot "Collect-UnsignedWindowsInstaller.ps1") -OutputPath $relativeOutput
    $output = Join-Path $repoRoot $relativeOutput
    if (-not (Test-Path -LiteralPath $output -PathType Leaf)) {
        throw "Collector did not create $output"
    }
    if (-not [System.Linq.Enumerable]::SequenceEqual([byte[]][System.IO.File]::ReadAllBytes($output), [byte[]][System.IO.File]::ReadAllBytes($fixture))) {
        throw "Collected installer does not match the NSIS output"
    }

    Remove-Item -LiteralPath $fixture -Force
    try {
        & (Join-Path $PSScriptRoot "Collect-UnsignedWindowsInstaller.ps1") -OutputPath $relativeOutput
        throw "Collector accepted a missing installer"
    } catch {
        if ($_.Exception.Message -notmatch "produced 0 NSIS installers") { throw }
    }

    [System.IO.File]::WriteAllBytes($fixture, [byte[]](1, 2, 3))
    [System.IO.File]::WriteAllBytes((Join-Path $nsisDir "Berd_duplicate_x64-setup.exe"), [byte[]](4, 5, 6))
    try {
        & (Join-Path $PSScriptRoot "Collect-UnsignedWindowsInstaller.ps1") -OutputPath $relativeOutput
        throw "Collector accepted ambiguous installers"
    } catch {
        if ($_.Exception.Message -notmatch "produced 2 NSIS installers") { throw }
    }
    Write-Host "PASS unsigned Windows installer collection"
} finally {
    $env:BERD_TAURI_CARGO_TARGET_DIR = $oldTargetDir
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $repoRoot "release/windows-test") -Recurse -Force -ErrorAction SilentlyContinue
}
