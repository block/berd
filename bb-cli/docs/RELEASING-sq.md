# Releasing the `sq` command pack

`berd/bb-cli` publishes an `sq` command pack as a single executable
module:

```text
sqbin/agent-tools.exoskeleton
```

The publishable contract is:

1. the executable lives under `sqbin/`
2. the executable uses the `.exoskeleton` suffix
3. the Homebrew formula installs `sqbin` into `prefix/"etc"`
4. the executable responds to `--describe-commands` with JSON that describes the command tree

This release path is specific to `sq` discovery through Homebrew. It is separate
from the `bb` CLI build path described in `docs/RELEASING-bb.md`.

## Tag Format

Use bare semver tags such as `0.1.0`.

Do not prefix releases with `v`. `../homebrew-formulas/sq-kgoose.rb` currently
uses `tag: version.to_s`, so `v0.1.0` would not match the formula's source tag.

## Local Verification

Before cutting a release:

```bash
cd bb-cli
source ./bin/activate-hermit
just check
just update-extensions-catalog
just build-sq
./sqbin/agent-tools.exoskeleton --describe-commands
./sqbin/agent-tools.exoskeleton --playpen baxen --help
./sqbin/agent-tools.exoskeleton --playpen baxen utils calculate --help
```

`just update-extensions-catalog` refreshes the checked-in root extension list
used by `sq`'s cached `--describe-commands` discovery path. Review and clean up
`extensions.yaml` before publishing.

## Automated Workflows

bb-cli checks are excluded from the root GitHub Actions workflow ahead of
removing the bundled CLI. Run them manually before release:

```bash
cd bb-cli
source ./bin/activate-hermit
just ci-lint
just ci-test
```

GitHub Actions `Bump Formula` runs on bare semver tags and `workflow_dispatch`
from the root workflow. It validates that the tag still matches
`bb-cli/Cargo.toml`, then dispatches `bump_formula` to
`squareup/homebrew-formulas`.

## One-Time GitHub Setup

For formula bumping to work, `berd` needs access to the Homebrew update
secrets:

1. `HOMEBREW_FORMULAS_APP_ID`
2. `HOMEBREW_FORMULAS_PRIVATE_KEY`

Per `homebrew-formulas`' maintainer docs, the repo also needs to be allowlisted
for `HOMEBREW_FORMULAS_PRIVATE_KEY`. Until those secrets are configured, the
`Bump Formula` workflow will fail fast with an explicit setup error.

## Release Flow

Once the version in `bb-cli/Cargo.toml` has been updated and merged:

```bash
git tag 0.1.0
git push origin 0.1.0
```

That tag push should:

1. make the source tag available to the Homebrew formula
2. trigger the formula bump automation in `squareup/homebrew-formulas`

If the formula update needs to be retried, rerun `Bump Formula` from the Actions
tab with the same semver tag. The workflow validates that the tag still matches
`bb-cli/Cargo.toml` before dispatching the bump.

## Homebrew Formula

The formula that publishes this command pack must keep installing `sqbin` into
`prefix/"etc"` so `sq` can discover it from the Homebrew keg.

The current shape in `../homebrew-formulas/sq-kgoose.rb` is:

```ruby
class SqKgoose < Formula
  version "0.1.0"
  stable do
    url "https://github.com/block/berd.git", tag: version.to_s
  end

  @sq_pack = {
    name: "agent-tools",
    desc: "Discover auth-backed tool extensions exposed through kGoose"
  }

  def install
    cd "bb-cli" do
      system "cargo", "build", "--release", "--locked"
      system "mkdir", "-p", "sqbin"
      system "cp", "target/release/agent-tools", "sqbin/agent-tools.exoskeleton"
      (prefix/"etc").install "sqbin"
    end
  end
end
```

If the formula changes later, preserve the final installed path under
`etc/sqbin`.
