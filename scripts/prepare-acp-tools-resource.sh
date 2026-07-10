#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
lock_file="${ACP_TOOLS_LOCK_FILE:-$repo_root/acp-tools.lock.json}"

# shellcheck source=lib/acp-node-wrapper.sh
source "$script_dir/lib/acp-node-wrapper.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/prepare-acp-tools-resource.sh [target-triple]

Stages locked ACP bridge binaries into resources/acp/bin so Tauri can bundle
them as application resources. The optional target triple defaults to the Rust
host target.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

target="${1:-}"
ensure_args=()
if [[ -n "$target" ]]; then
  ensure_args+=(--target "$target")
else
  target="$(rustc -vV | sed -n 's|host: ||p')"
fi
if [[ -z "$target" ]]; then
  echo "Could not determine rust host target." >&2
  exit 1
fi

cache_bin_dir="$("$script_dir/ensure-acp-tools.sh" ${ensure_args[@]+"${ensure_args[@]}"} --print-bin-dir)"
cache_root="$(dirname "$(dirname "$cache_bin_dir")")"
resource_root="$repo_root/resources/acp"
resource_bin_dir="$repo_root/resources/acp/bin"
resource_node_dir="$resource_root/node"
mkdir -p "$resource_bin_dir"

# Keep .gitkeep but refresh any staged tools from the lock.
find "$resource_bin_dir" -type f ! -name ".gitkeep" -delete
rm -rf "$resource_node_dir"
mkdir -p "$resource_node_dir"

# Manifest for the app's Node.js runtime doctor check, staged next to the
# bin dir so the app can resolve it as the bin dir's parent. Removed up
# front so github-only or bridge-less restricted builds ship no manifest
# and the doctor check stays silent.
node_runtime_manifest="$resource_root/node-runtime.json"
rm -f "$node_runtime_manifest"
node_runtime_entries=()

codesign_if_darwin() {
  local file="$1"
  if [[ "$(uname -s)" == "Darwin" ]] && command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$file" >/dev/null 2>&1 || true
  fi
}

while IFS=$'\t' read -r source id binary field4 field5 field6; do
  [[ -n "$source" ]] || continue
  case "$source" in
    github_release)
      file="$cache_bin_dir/$binary"
      if [[ ! -x "$file" ]]; then
        echo "Locked ACP tool missing from cache: $binary" >&2
        exit 1
      fi
      cp "$file" "$resource_bin_dir/$binary"
      chmod +x "$resource_bin_dir/$binary"
      codesign_if_darwin "$resource_bin_dir/$binary"
      ;;
    npm)
      package="$field4"
      version="$field5"
      node_engine="${field6:->=22}"
      install_dir="$cache_root/$target/$id/$version/npm"
      entrypoint="$install_dir/node_modules/$package/dist/index.js"
      if [[ ! -f "$entrypoint" ]]; then
        echo "Locked npm ACP tool missing from cache: $package@$version" >&2
        exit 1
      fi
      resource_package_dir="$resource_node_dir/$id"
      mkdir -p "$resource_package_dir"
      cp -R "$install_dir/." "$resource_package_dir/"
      resource_entrypoint="$resource_package_dir/node_modules/$package/dist/index.js"
      if [[ ! -f "$resource_entrypoint" ]]; then
        echo "Failed to stage npm ACP tool: $package@$version" >&2
        exit 1
      fi
      write_node_wrapper "$resource_bin_dir/$binary" "../node/$id/node_modules/$package/dist/index.js" "$node_engine"
      node_runtime_entries+=("$id"$'\t'"$binary"$'\t'"$node_engine"$'\t'"$(acp_required_node_major "$node_engine")")
      # Ad-hoc sign every Mach-O in the staged package, not just the main
      # CLIs: the codex native package also vendors executables like rg and
      # zsh, and unsigned nested Mach-Os are killed by Gatekeeper. Darwin
      # only, so Linux staging skips the file(1) scan.
      if [[ "$(uname -s)" == "Darwin" ]]; then
        while IFS= read -r -d '' candidate; do
          if file -b "$candidate" | grep -q "Mach-O"; then
            codesign_if_darwin "$candidate"
          fi
        done < <(find "$resource_package_dir" -type f -print0)
      fi
      ;;
    *)
      echo "Unsupported ACP tool source: $source" >&2
      exit 1
      ;;
  esac
done < <(node - "$lock_file" "$target" <<'NODE'
const fs = require("node:fs");
const [lockFile, target] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(lockFile, "utf8"));
for (const entry of data.tools ?? []) {
  if (entry.target !== target || typeof entry.binary !== "string") continue;
  const source = entry.source ?? "github_release";
  if (source === "github_release") {
    console.log([source, entry.id, entry.binary, entry.repo, entry.tag, entry.asset].join("\t"));
  } else if (source === "npm") {
    console.log([source, entry.id, entry.binary, entry.package, entry.version, entry.nodeEngine ?? ">=22"].join("\t"));
  } else {
    throw new Error(`Unsupported ACP tool source: ${source}`);
  }
}
NODE
)

# One manifest entry per npm-sourced bridge, each carrying its own required
# Node major, so bridges with different engine ranges surface distinct
# requirements in the doctor check.
if ((${#node_runtime_entries[@]} > 0)); then
  node -e '
const fs = require("node:fs");
const [manifestFile, ...entries] = process.argv.slice(1);
const tools = entries.map((line) => {
  const [id, binary, nodeEngine, requiredNodeMajor] = line.split("\t");
  return { id, binary, nodeEngine, requiredNodeMajor: Number(requiredNodeMajor) };
});
fs.writeFileSync(manifestFile, `${JSON.stringify({ tools }, null, 2)}\n`);
' "$node_runtime_manifest" ${node_runtime_entries[@]+"${node_runtime_entries[@]}"}
  echo "Wrote ACP Node runtime manifest: $node_runtime_manifest"
fi

echo "Staged ACP tools resource: $resource_bin_dir"
