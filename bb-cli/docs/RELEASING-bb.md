# Building `bb`

`bb-cli` owns the Rust `bb` binary. It no longer owns standalone app,
installer, archive, DMG, MSI, package, or platform-specific distribution.
Goose.app bundles the `bb` binary and manages the `/usr/local/bin/bb` command
link from the app.

The Homebrew-backed `sq` command-pack release path is separate and documented in
`docs/RELEASING-sq.md`.

## Local Build

Build the release binary:

```bash
source ./bin/activate-hermit
cargo build --locked --release --bin bb
```

Or use the Justfile alias:

```bash
source ./bin/activate-hermit
just build-bb-release
```

Smoke-check the built CLI:

```bash
target/release/bb --version
target/release/bb --help
```

## Goose Integration

Goose packages `bb` by copying a built binary into the app resources during the
Goose bundle flow. In the parent app repo, this is handled by:

```text
scripts/prepare-bb-cli-resource.sh
```

The packaged app exposes the command from:

```text
Goose.app/Contents/Resources/bb
```

Goose.app owns installing or repairing:

```text
/usr/local/bin/bb -> /Applications/Goose.app/Contents/Resources/bb
```

## Ownership

Do not add standalone `bb` app, installer, platform archive, DMG, MSI, package,
or Homebrew distribution back to this package. Distribution flows through
Goose.app.

When changing `bb`, update and merge the version in `Cargo.toml`, run the normal
`bb-cli` checks, and validate the Goose bundle path that consumes the binary.
