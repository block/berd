# Native Windows Verification

This lane is for native Windows dev-app verification. It does not replace the
Mac/Hermit flow, and it does not build a Windows installer yet.

The first Windows milestone is:

- install or diagnose native Windows prerequisites
- verify Block npm access
- build the pinned Goose backend natively
- launch the real Tauri dev app with `just dev-windows`

Native Berd provider sign-in is intentionally deferred on Windows. The app and
`doctor-windows` report this as a known gap.

## Fresh Machine Scope

Use normal PowerShell. You do not need a Visual Studio Developer PowerShell; the
Windows scripts load the Visual Studio build environment before running Cargo.

The repeatable entrypoint is `just`, but a completely fresh Windows machine
still needs two seed steps:

1. Install `just` once:

   ```powershell
   winget install --id Casey.Just -e
   ```

2. Get a Berd checkout. If Git is not installed yet, install it once:

   ```powershell
   winget install --id Git.Git -e
   ```

   Then clone or open the Berd repo. After you are in the repo,
   `bootstrap-windows` owns Git validation and repair like the other Windows
   prerequisites.

Open a fresh PowerShell after installing `just` or Git if the commands are not
visible on `PATH`.

## First Bootstrap

From the repo root:

```powershell
just bootstrap-windows
just bootstrap-windows install
```

`just bootstrap-windows` is check-only. It reports what is missing and prints
the exact remediation it expects.

`just bootstrap-windows install` installs missing prerequisites with WinGet and
may request one administrator prompt for Visual Studio Build Tools. Re-running
it is safe; installed tools are detected and reused.

Bootstrap installs or validates:

- Git and Git Bash
- Visual Studio Build Tools with MSVC C++ tools
- Microsoft Edge WebView2 Runtime
- Rust MSVC toolchain from `rust-toolchain.toml`
- `fnm`, Node, Corepack, and `pnpm@10.33.0`
- CMake
- LLVM/libclang
- jq
- Python
- Lefthook
- just

Bootstrap does not create or mutate Block npm configuration. If Block npm is
not already configured, bootstrap may warn that Corepack/pnpm or Block npm HTTPS
is not ready. Configure Block npm with the manual steps below, then rerun
`just bootstrap-windows install`.

On a truly fresh machine, npm is not available until this first install pass
installs Node through `fnm`. Configure Block npm after
`just bootstrap-windows install` has made `npm.cmd` available, before running
`just setup-windows`.

Open a fresh PowerShell after install mode if PATH changes are not visible.

## Block Npm And Artifactory Manual Setup

After the first bootstrap install pass, configure npm, pnpm, Corepack, and Node
TLS for the Block Artifactory npm mirror before running `setup-windows`. The
Windows bootstrap does not write these settings because they are
developer/corporate environment configuration, not Berd-owned tool state.

```text
%USERPROFILE%\.block-certs\root-certs.pem
https://global.block-artifacts.com/artifactory/api/npm/square-npm/
NPM_CONFIG_REGISTRY
NPM_CONFIG_CAFILE
NODE_EXTRA_CA_CERTS
COREPACK_NPM_REGISTRY
COREPACK_INTEGRITY_KEYS=0
```

Recommended manual setup:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.block-certs" | Out-Null

# Use the current Block/corporate root certificate bundle for your machine.
# Save it at:
#   $env:USERPROFILE\.block-certs\root-certs.pem

npm.cmd config set registry "https://global.block-artifacts.com/artifactory/api/npm/square-npm/"
npm.cmd config set cafile "$env:USERPROFILE\.block-certs\root-certs.pem"

[System.Environment]::SetEnvironmentVariable("NPM_CONFIG_REGISTRY", "https://global.block-artifacts.com/artifactory/api/npm/square-npm/", "User")
[System.Environment]::SetEnvironmentVariable("NPM_CONFIG_CAFILE", "$env:USERPROFILE\.block-certs\root-certs.pem", "User")
[System.Environment]::SetEnvironmentVariable("NODE_EXTRA_CA_CERTS", "$env:USERPROFILE\.block-certs\root-certs.pem", "User")
[System.Environment]::SetEnvironmentVariable("COREPACK_NPM_REGISTRY", "https://global.block-artifacts.com/artifactory/api/npm/square-npm/", "User")
[System.Environment]::SetEnvironmentVariable("COREPACK_INTEGRITY_KEYS", "0", "User")

$env:NPM_CONFIG_REGISTRY = "https://global.block-artifacts.com/artifactory/api/npm/square-npm/"
$env:NPM_CONFIG_CAFILE = "$env:USERPROFILE\.block-certs\root-certs.pem"
$env:NODE_EXTRA_CA_CERTS = "$env:USERPROFILE\.block-certs\root-certs.pem"
$env:COREPACK_NPM_REGISTRY = "https://global.block-artifacts.com/artifactory/api/npm/square-npm/"
$env:COREPACK_INTEGRITY_KEYS = "0"

corepack.cmd prepare pnpm@10.33.0 --activate
```

`doctor-windows` and `setup-windows` verify HTTPS reachability to Block
Artifactory using Node with the configured certificate bundle.

If you see `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` or a Block npm HTTPS failure:

1. Connect to the Block VPN or proxy.
2. Confirm the cert bundle exists:

   ```powershell
   Test-Path "$env:USERPROFILE\.block-certs\root-certs.pem"
   ```

3. Confirm npm and pnpm point at the Block registry and cert:

   ```powershell
   npm.cmd config get registry
   npm.cmd config get cafile
   pnpm.cmd config get registry
   pnpm.cmd config get cafile
   ```

4. Replace `%USERPROFILE%\.block-certs\root-certs.pem` with the correct
   Block/corporate certificate bundle if local trust is still wrong.
5. Rerun bootstrap install if pnpm was not ready yet:

   ```powershell
   just bootstrap-windows install
   ```

6. Rerun doctor:

   ```powershell
   just doctor-windows
   ```

Do not work around TLS failures with `strict-ssl=false`.

For manual pnpm commands in PowerShell, prefer `pnpm.cmd ...`. Some Windows
machines block `pnpm.ps1` through PowerShell execution policy.

## Verify Readiness

After bootstrap install:

```powershell
just doctor-windows
```

Expected result:

- all required checks pass
- one warning is acceptable: native Windows sign-in is deferred

If doctor reports managed Goose is missing, continue with `setup-windows`.

## Setup

```powershell
just setup-windows
```

Setup:

- installs pnpm dependencies
- builds the vendored SDK
- installs hooks
- clones and builds the Goose backend pinned by `goose-backend.lock.json`

Managed Goose state lives in:

```text
%LOCALAPPDATA%\berd-dev\goose
%LOCALAPPDATA%\berd-dev\cargo-target
%LOCALAPPDATA%\berd-dev\stamp.json
```

The stamp records the repo, ref, commit, Cargo package, binary name, and
resolved `goose.exe` path. Re-running setup should reuse the build when those
values still match.

## Launch The Native App

```powershell
just dev-windows
```

`just dev-windows` launches native Tauri dev mode with Windows-native paths for:

- managed `goose.exe`
- built `berdctl.exe`

The bb CLI resource is not staged because the app only maps and resolves `bb`
on macOS today.

Expected result:

- Vite starts
- native `Berd.exe` launches from the Windows Tauri cargo target
- Goose ACP startup uses the managed `goose.exe`
- Goose serve reaches ready

Native provider sign-in may still be unavailable. That is expected for this
milestone.

## Validation Commands

Use these when changing the Windows lane or verifying a machine:

```powershell
just doctor-windows
just setup-windows
just tauri-check-windows
just test-windows-dev
```

`tauri-check-windows` runs Windows-native Rust/Tauri checks with external
sidecars disabled. `test-windows-dev` covers focused Windows script path, stamp,
and cleanup helpers.

## Cleanup And Reset

Cleanup is dry-run by default:

```powershell
just cleanup-windows
```

Default removal deletes Berd-local caches and generated repo setup/dev
artifacts. That includes root `node_modules`, root `.pnpm-store`, root `dist`,
`sdk\node_modules`, `sdk\dist`, and Lefthook-managed `pre-commit` and
`pre-push` hooks:

```powershell
just cleanup-windows remove -Yes
```

Everything beyond the default removal touches software shared with other
projects (global Node state, rustup toolchains, CMake, LLVM, Python, ...), so
those categories require a second acknowledgment: `-YesShared` in addition to
`-Yes`.

Node state covers Corepack's pnpm cache, an npm-global pnpm fallback if
bootstrap used it, fnm transient shell directories, and the fnm-managed Node
version pinned by this lane. Disabling Corepack shims and uninstalling
npm-global pnpm affects every repo on the machine that uses them:

```powershell
just cleanup-windows remove -Yes -YesShared -IncludeNodeState
```

Use `-All` to select every optional cleanup group except the WebView2 Runtime.
Block npm registry/certificate settings are not included because bootstrap does
not own corporate npm configuration:

```powershell
just cleanup-windows remove -All -Yes -YesShared
```

Shared developer tools can also be selected individually:

```powershell
just cleanup-windows remove -Yes -YesShared -IncludeNodeState -IncludeSharedTools -IncludeVisualStudioBuildTools
```

`-IncludeSharedTools` covers rustup (via `rustup self uninstall`, which also
removes `~\.cargo` and `~\.rustup`), fnm, CMake, LLVM/libclang, jq, Python,
just, and Lefthook. Git is intentionally retained because the Windows
onboarding lane still needs it to manage the checkout. Visual Studio Build
Tools is separate because uninstalling it is more disruptive and may require
elevation.

The WebView2 Runtime is OS-level infrastructure shared by Teams, Outlook, and
every other WebView2 app, so it is excluded from `-All` and only removed with
an explicit `-IncludeWebView2`:

```powershell
just cleanup-windows remove -Yes -YesShared -IncludeWebView2
```

## Troubleshooting

If `just` is not recognized, open a new PowerShell after installing it. WinGet
usually installs it under:

```text
%LOCALAPPDATA%\Microsoft\WinGet\Packages\Casey.Just_Microsoft.Winget.Source_8wekyb3d8bbwe\just.exe
```

If `pnpm` fails with `running scripts is disabled on this system`, use
`pnpm.cmd` for manual commands. The `just` recipes already run PowerShell with
execution-policy bypass where needed.

If MSVC or `link.exe` is missing, rerun:

```powershell
just bootstrap-windows install
```

Install mode may request an administrator prompt to repair Visual Studio Build
Tools with the C++ workload.

If managed Goose looks stale or dirty, reset the Berd-local Windows cache:

```powershell
just cleanup-windows remove -Yes
just setup-windows
```

If you want a full fresh-machine reset after testing, review the cleanup dry run
first, then run the full reset command from the cleanup section.
