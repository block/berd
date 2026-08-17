// Regenerates the berdctl contract artifacts from the authoritative
// command modules in src/features/berdctl/commands/impl/*.ts:
//
//   src-tauri/crates/berdctl/api-surface.json   (client-neutral wire surface:
//       groups → actions → description + fields + JSON Schema)
//   src-tauri/crates/berdctl/cli-surface.json   (CLI projection: noun/verb
//       tree + CLI-only prose)
//
// The berdctl crate embeds these files and builds its clap tree from them
// at startup, so after changing a command schema (or adding a command) run:
//
//   pnpm generate:berdctl-contract
//
// CI regenerates and fails on any diff (`just berdctl-contract-check`); the
// vitest freshness tests (apiSurface.test.ts / cliSurface.test.ts) hold the
// same property locally. All introspection logic lives in
// src/features/berdctl/commands/contract.ts — shared with those tests so the
// generator and the assertions cannot disagree.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const crateDir = path.join(repoRoot, "src-tauri/crates/berdctl");

const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);

async function loadContracts({ feedbackEnabled, automationsEnabled }) {
  // Mirror the app's vite resolution (the `@` alias and build-feature defines)
  // so each generated projection comes from the exact renderer registry that
  // its build will dispatch.
  const server = await createServer({
    configFile: false,
    root: repoRoot,
    logLevel: "error",
    resolve: {
      alias: [{ find: "@", replacement: path.join(repoRoot, "src") }],
    },
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(packageJson.version),
      "import.meta.env.VITE_FEEDBACK": JSON.stringify(
        feedbackEnabled ? "1" : "0",
      ),
      "import.meta.env.VITE_AUTOMATIONS": JSON.stringify(
        automationsEnabled ? "1" : "0",
      ),
    },
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });

  try {
    const contract = await server.ssrLoadModule(
      "/src/features/berdctl/commands/contract.ts",
    );
    return {
      api: contract.buildApiSurfaceContract(),
      surface: contract.buildCliSurfaceContract(),
    };
  } finally {
    await server.close();
  }
}

// One variant per gate combination: the gates are independent renderer
// build flags, and the embedded CLI artifacts must never advertise a group
// the matching renderer build filters out of TOOL_GROUPS.
const publicContracts = await loadContracts({
  feedbackEnabled: false,
  automationsEnabled: false,
});
const feedbackContracts = await loadContracts({
  feedbackEnabled: true,
  automationsEnabled: false,
});
const automationsContracts = await loadContracts({
  feedbackEnabled: false,
  automationsEnabled: true,
});
const blockContracts = await loadContracts({
  feedbackEnabled: true,
  automationsEnabled: true,
});

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
  ["api-surface.json", publicContracts.api],
  ["cli-surface.json", publicContracts.surface],
  ["api-surface-feedback.json", feedbackContracts.api],
  ["cli-surface-feedback.json", feedbackContracts.surface],
  ["api-surface-automations.json", automationsContracts.api],
  ["cli-surface-automations.json", automationsContracts.surface],
  ["api-surface-block.json", blockContracts.api],
  ["cli-surface-block.json", blockContracts.surface],
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
    "berdctl contract artifacts are out of date; run " +
      "`pnpm generate:berdctl-contract` and commit the result.",
  );
  process.exit(1);
}
