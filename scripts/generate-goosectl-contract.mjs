// Regenerates the goosectl contract artifacts from the authoritative
// command modules in src/features/goosectl/commands/impl/*.ts:
//
//   src-tauri/crates/goosectl/api-surface.json   (client-neutral wire surface:
//       groups → actions → description + fields + JSON Schema)
//   src-tauri/crates/goosectl/cli-surface.json   (CLI projection: noun/verb
//       tree + CLI-only prose)
//
// The goosectl crate embeds these files and builds its clap tree from them
// at startup, so after changing a command schema (or adding a command) run:
//
//   pnpm generate:goosectl-contract
//
// CI regenerates and fails on any diff (scripts/buildkite/js-checks.sh); the
// vitest freshness tests (apiSurface.test.ts / cliSurface.test.ts) hold the
// same property locally. All introspection logic lives in
// src/features/goosectl/commands/contract.ts — shared with those tests so the
// generator and the assertions cannot disagree.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const crateDir = path.join(repoRoot, "src-tauri/crates/goosectl");

const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);

const { createServer } = await import("vite");
// Mirror the app's vite resolution (the `@` alias and VITE_APP_VERSION
// define) so the pure command descriptor graph loads exactly as it does in
// the app and in vitest.
const server = await createServer({
  configFile: false,
  root: repoRoot,
  logLevel: "error",
  resolve: {
    alias: [{ find: "@", replacement: path.join(repoRoot, "src") }],
  },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(packageJson.version),
  },
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});

let api;
let surface;
try {
  const contract = await server.ssrLoadModule(
    "/src/features/goosectl/commands/contract.ts",
  );
  api = contract.buildApiSurfaceContract();
  surface = contract.buildCliSurfaceContract();
} finally {
  await server.close();
}

// Resolve the repo's biome binary (same pattern as
// scripts/design-system-manifest.mjs) so the emitted JSON matches the
// formatting the pre-commit hook would apply — CI's regenerate-and-diff
// check must be byte-stable.
const biomePackagePath = require.resolve("@biomejs/biome/package.json");
const biomePackage = JSON.parse(fs.readFileSync(biomePackagePath, "utf8"));
const biomeBinPath = path.join(
  path.dirname(biomePackagePath),
  biomePackage.bin.biome,
);

const checkMode = process.argv.includes("--check");

function render(fileName, contract) {
  // Format through the repo's biome so the bytes on disk are stable under
  // the pre-commit format hook. cwd pins biome's config discovery to the
  // repo's biome.json regardless of where the generator is invoked from.
  return execFileSync(
    biomeBinPath,
    ["format", `--stdin-file-path=${fileName}`],
    {
      input: `${JSON.stringify(contract, null, 2)}\n`,
      encoding: "utf8",
      cwd: repoRoot,
    },
  );
}

let stale = false;
for (const [fileName, contract] of [
  ["api-surface.json", api],
  ["cli-surface.json", surface],
]) {
  const target = path.join(crateDir, fileName);
  const rendered = render(fileName, contract);
  const existing = fs.existsSync(target)
    ? fs.readFileSync(target, "utf8")
    : null;
  if (rendered === existing) {
    continue;
  }
  if (checkMode) {
    stale = true;
    console.error(`stale: ${path.relative(repoRoot, target)}`);
  } else {
    fs.writeFileSync(target, rendered);
    console.log(`wrote ${path.relative(repoRoot, target)}`);
  }
}

if (stale) {
  console.error(
    "goosectl contract artifacts are out of date; run " +
      "`pnpm generate:goosectl-contract` and commit the result.",
  );
  process.exit(1);
}
