// Scaffolds a new berdctl command: `just new-command <noun> <verb>`.
//
// Stamps out everything mechanical — the colocated command module, the
// registry assembly line, the commands.test.ts fixture, the Rust
// minimal-invocation entry — and regenerates the contract artifacts. What
// remains is the authored surface: the zod schema, the implementation, the
// help prose (summary/description/helpFooter and per-field .describe(), all
// in the module), and the behavior tests. The help gate
// (`cargo test -p berdctl`) FAILS until the TODO prose is written.
//
// All validation (arguments, every insertion anchor, the generator
// environment) runs BEFORE the first write, so a refusal never leaves a
// half-scaffolded tree. Refuses verbs that already exist and nouns it cannot
// extend mechanically. New nouns (groups), multi-word verbs, and
// verb↔action divergence (like `info`) are out of scope for the scaffold:
// do those by hand per .agents/skills/berdctl-new-command/SKILL.md.

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

const [noun, verb] = process.argv.slice(2);

function die(message) {
  console.error(`new-berdctl-command: ${message}`);
  console.error("No files were written.");
  process.exit(1);
}

if (!noun || !verb) {
  die(
    "usage: just new-command <noun> <verb>   (e.g. just new-command session export)",
  );
}
// Single lowercase word only: the verb becomes the registry action, the
// cli-surface verb key, AND the clap subcommand name, and clap kebab-cases
// multi-word variants — a snake_case verb would generate a CLI tree that can
// never match the contract. Multi-word verbs need the by-hand path (a
// cli.verbs override in the registry).
if (!/^[a-z][a-z0-9]*$/.test(verb)) {
  die(
    `verb "${verb}" must be a single lowercase word; multi-word verbs need ` +
      "a cli.verbs override done by hand per " +
      ".agents/skills/berdctl-new-command/SKILL.md",
  );
}
if (verb === "help") {
  die("`help` is clap's auto-generated subcommand and cannot be a verb");
}

const surfacePath = path.join(
  repoRoot,
  "src-tauri/crates/berdctl/cli-surface.json",
);
const surface = JSON.parse(fs.readFileSync(surfacePath, "utf8"));
const nounSpec = surface.nouns[noun];
if (!nounSpec) {
  die(
    `unknown noun "${noun}" (known: ${Object.keys(surface.nouns).join(", ")}). ` +
      "Adding a whole new noun/group is a design decision — do it by hand per " +
      ".agents/skills/berdctl-new-command/SKILL.md",
  );
}
if (
  Object.entries(nounSpec.verbs).some(
    ([cliVerb, spec]) => cliVerb !== spec.action,
  )
) {
  die(
    `the "${noun}" noun maps CLI verbs onto differently-named actions; the ` +
      "scaffold only handles verb == action. Add the command by hand per " +
      ".agents/skills/berdctl-new-command/SKILL.md",
  );
}
if (nounSpec.verbs[verb]) {
  die(`\`berdctl ${noun} ${verb}\` already exists; pick a different verb`);
}

// Preflight: the final step re-runs the contract generator, and a broken
// environment (unbuilt SDK on a fresh checkout, stale contracts from
// uncommitted schema edits) must abort before anything is stamped.
try {
  execFileSync("pnpm", ["generate:berdctl-contract", "--check"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
} catch {
  die(
    "the contract generator cannot run cleanly (`pnpm " +
      "generate:berdctl-contract --check` failed). Fix the generator error; " +
      "if the contracts are stale, regenerate and commit them first.",
  );
}

const group = nounSpec.group;

function camel(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// Match the existing module naming: list verbs read over the (plural) group
// — listSessions — everything else targets one (singular) noun — getSession.
const moduleBase = verb === "list" ? `list${camel(group)}` : verb + camel(noun);
const commandName = `${moduleBase}Command`;
const modulePath = path.join(
  repoRoot,
  `src/features/berdctl/commands/impl/${moduleBase}.ts`,
);
if (fs.existsSync(modulePath)) {
  die(`${path.relative(repoRoot, modulePath)} already exists`);
}

// ── Stage 1: compute every edit; die before anything is written. ──────────

// 1. The command module skeleton (pre-formatted to the repo's biome style; a
// biome pass below keeps that honest).
const moduleSource = `import { z } from "zod/v4";

import { CommandError, defineCommand } from "../types";

const ${moduleBase}Schema = z
  .object({
    // TODO(scaffold): declare the wire fields — .describe() every field (it
    // becomes the flag's --help text) and put bounds on anything unbounded
    // (bounds in zod are the trust boundary; CLI help only mirrors them).
  })
  .strict();

export const ${commandName} = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  // TODO(scaffold): one-line summary for \`berdctl ${noun} --help\`'s verb
  // list.
  summary: "TODO",
  // TODO(scaffold): the visible side effect, stated plainly; \`--help\`
  // renders it as the body.
  description: "TODO",
  // TODO(scaffold): example invocation and result shape, rendered after the
  // options in --help.
  helpFooter: "TODO",
  schema: ${moduleBase}Schema,
  // TODO(scaffold): add a precheck refusal guard if the target can be
  // mid-run (see refuseRunningTarget in ../runtimeHelpers); delete this comment
  // otherwise.
  execute: async () => {
    // TODO(scaffold): implement through the app's existing stores/flows.
    throw new CommandError(
      "internal_error",
      "${noun} ${verb} is not implemented yet",
    );
  },
});
`;

// 2. Registry assembly: the import line (sorted among the impl imports) and
// the action entry (appended to the group's actions map).
const registryPath = path.join(
  repoRoot,
  "src/features/berdctl/commands/registry.ts",
);
let registry = fs.readFileSync(registryPath, "utf8");

const importLine = `import { ${commandName} } from "./impl/${moduleBase}";`;
const importRe = /^import \{ \w+Command \} from "\.\/impl\/(\w+)";$/gm;
const imports = [...registry.matchAll(importRe)];
if (imports.length === 0) {
  die("could not find the impl import block in registry.ts");
}
const insertAfter =
  [...imports].reverse().find((m) => m[1] < moduleBase) ?? null;
if (insertAfter) {
  registry = registry.replace(
    insertAfter[0],
    `${insertAfter[0]}\n${importLine}`,
  );
} else {
  registry = registry.replace(imports[0][0], `${importLine}\n${imports[0][0]}`);
}

const groupStart = registry.indexOf(`  ${group}: {`);
if (groupStart === -1) {
  die(`could not find group "${group}" in registry.ts`);
}
const actionsStart = registry.indexOf("actions: {", groupStart);
const actionsEnd = registry.indexOf("    },", actionsStart);
if (actionsStart === -1 || actionsEnd === -1) {
  die(`could not find the actions map for group "${group}" in registry.ts`);
}
registry = `${registry.slice(0, actionsEnd)}      ${verb}: ${commandName},\n${registry.slice(actionsEnd)}`;

// 3. commands.test.ts fixture stub: the totality test fails loudly without
// an entry; the stub keeps that test green so the remaining intentional
// failure is the help gate. Real behavior tests are still on you.
const testPath = path.join(
  repoRoot,
  "src/features/berdctl/__tests__/commands/commands.test.ts",
);
let testSource = fs.readFileSync(testPath, "utf8");
const fixtureAnchor = testSource.indexOf('      "info.get_context": {},');
if (fixtureAnchor === -1) {
  die("could not find the validArgs fixture map in commands.test.ts");
}
const fixtureLineEnd = testSource.indexOf("\n", fixtureAnchor) + 1;
testSource =
  testSource.slice(0, fixtureLineEnd) +
  `      // TODO(scaffold): minimal valid args for ${group}.${verb}, plus\n` +
  `      // behavior tests for its result shape and error codes.\n` +
  `      "${group}.${verb}": {},\n` +
  testSource.slice(fixtureLineEnd);

// 4. Rust minimal invocation (exercises the wire mapping). Valid while the
// schema has no required fields; update the flags when it does.
const mainPath = path.join(repoRoot, "src-tauri/crates/berdctl/src/main.rs");
let mainSource = fs.readFileSync(mainPath, "utf8");
const invocationAnchor = "            _ => return None,";
if (!mainSource.includes(invocationAnchor)) {
  die("could not find minimal_invocation in main.rs");
}
mainSource = mainSource.replace(
  invocationAnchor,
  `            // TODO(scaffold): add the required flags once the schema has them.\n` +
    `            ("${noun}", "${verb}") => vec![],\n${invocationAnchor}`,
);

// ── Stage 2: every edit validated; write them all. ────────────────────────

fs.writeFileSync(modulePath, moduleSource);
fs.writeFileSync(registryPath, registry);
fs.writeFileSync(testPath, testSource);
fs.writeFileSync(mainPath, mainSource);

// Keep the stamped TS byte-identical to what the pre-commit format hook and
// `just check` expect, so the only intentional CI failure is the help gate.
const biomePackagePath = require.resolve("@biomejs/biome/package.json");
const biomePackage = JSON.parse(fs.readFileSync(biomePackagePath, "utf8"));
const biomeBinPath = path.join(
  path.dirname(biomePackagePath),
  biomePackage.bin.biome,
);
execFileSync(
  biomeBinPath,
  ["format", "--write", modulePath, registryPath, testPath],
  { cwd: repoRoot, stdio: "pipe" },
);

// 5. Regenerate the contract artifacts from the now-registered module.
execFileSync("pnpm", ["generate:berdctl-contract"], {
  cwd: repoRoot,
  stdio: "inherit",
});

console.log(`
Scaffolded \`berdctl ${noun} ${verb}\` (${group}.${verb}). Authored work left:

  1. ${path.relative(repoRoot, modulePath)}
     — schema (bounds! .describe() every field), summary, description,
     helpFooter, precheck, execute. \`cargo test -p berdctl\` FAILS until
     the TODO prose is real.
  2. src/features/berdctl/__tests__/commands/commands.test.ts
     — real valid-args fixture + behavior tests
  3. The verb inventories: the group description and cli.about in
     registry.ts, the noun table in tree.rs (TOP_LEVEL_LONG_ABOUT — its pin
     is EXPECTED_TOP_LEVEL_HELP in src-tauri/crates/berdctl/src/main.rs,
     refreshed via dump_rendered_help_for_pin_update), and — if the
     one-paragraph overview changes — distro/skills/berdctl/SKILL.md
  4. Re-run \`pnpm generate:berdctl-contract\` after schema edits

Reviewer checklist (from .agents/skills/berdctl-new-command/SKILL.md):
  - Reversible? UI-visible? Within the global caps' assumptions?
  - Safety metadata correct (effect/visibility/destructive)?
  - Bounds in zod, not just help text?
  - precheck guard if the target can be mid-run?
  - Help reads like API docs (example, result shape, every error)?
  - No broker/bridge/dispatch diffs?
  - Wire-compatible, or PROTOCOL_VERSION bumped in both copies?
`);
