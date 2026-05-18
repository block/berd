import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDesignSystemManifest } from "./design-system-manifest.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sectionsPath = path.join(
  repoRoot,
  "src/features/design-system/ui/designSystemSections.ts",
);
const viewPath = path.join(
  repoRoot,
  "src/features/design-system/ui/DesignSystemView.tsx",
);

function pageFunctionName(label) {
  return `${label.replace(/[^a-zA-Z0-9]+(.)/g, (_, character) =>
    character.toUpperCase(),
  )}Page`;
}

function getExplorerComponentLabels() {
  const sourceText = fs.readFileSync(sectionsPath, "utf8");
  const componentBlock =
    /DESIGN_SYSTEM_COMPONENT_SECTIONS[\s\S]*?=\s*\[([\s\S]*?)\];/.exec(
      sourceText,
    )?.[1];

  return Array.from(componentBlock?.matchAll(/label:\s*"([^"]+)"/g) ?? []).map(
    (match) => match[1],
  );
}

function getFunctionBlock(sourceText, functionName) {
  const start = sourceText.indexOf(`function ${functionName}(`);
  if (start === -1) {
    return "";
  }

  const next = sourceText.slice(start + 1).search(/\nfunction [A-Z]/);
  return next === -1
    ? sourceText.slice(start)
    : sourceText.slice(start, start + 1 + next);
}

function runCoverage() {
  const strict = process.argv.includes("--strict");
  const listMissing = !strict || process.argv.includes("--list-missing");
  const manifest = buildDesignSystemManifest().filter(
    (item) => !item.source.endsWith(".test.tsx"),
  );
  const manifestByName = new Map(manifest.map((item) => [item.name, item]));
  const viewSource = fs.readFileSync(viewPath, "utf8");
  const explorerLabels = getExplorerComponentLabels();
  const genericComponentPageBlock = getFunctionBlock(
    viewSource,
    "GenericComponentPage",
  );
  const genericComponentPageCoverage = {
    hasSpec: genericComponentPageBlock.includes("<ComponentSpec"),
    hasPlayground: genericComponentPageBlock.includes("<ComponentPlayground"),
    hasTokenDetails: genericComponentPageBlock.includes(
      "<ComponentTokenDetails",
    ),
  };
  const failures = [];

  const rows = explorerLabels.map((label) => {
    const functionName = pageFunctionName(label);
    const block = getFunctionBlock(viewSource, functionName);
    const manifestItem = manifestByName.get(label);
    const usesGenericPage = block.includes("<GenericComponentPage");
    const row = {
      label,
      source: manifestItem?.source ?? "missing manifest item",
      hasPage: block.length > 0,
      hasSpec:
        block.includes("<ComponentSpec") ||
        (usesGenericPage && genericComponentPageCoverage.hasSpec),
      hasPlayground:
        block.includes("<ComponentPlayground") ||
        (usesGenericPage && genericComponentPageCoverage.hasPlayground),
      hasTokenDetails:
        block.includes("<ComponentTokenDetails") ||
        (usesGenericPage && genericComponentPageCoverage.hasTokenDetails),
    };

    if (!manifestItem) {
      failures.push(`${label}: missing generated manifest item`);
    }
    if (!row.hasPage) {
      failures.push(`${label}: missing explorer page function ${functionName}`);
    }
    if (!row.hasSpec) {
      failures.push(`${label}: page should render ComponentSpec`);
    }
    if (!row.hasPlayground) {
      failures.push(`${label}: page should render ComponentPlayground`);
    }
    if (!row.hasTokenDetails) {
      failures.push(`${label}: page should render ComponentTokenDetails`);
    }

    return row;
  });

  const labelsInExplorer = new Set(explorerLabels);
  const notInExplorer = manifest
    .filter((item) => !labelsInExplorer.has(item.name))
    .map((item) => `${item.name} (${item.source})`);

  console.log("Design system explorer coverage:");
  for (const row of rows) {
    console.log(
      `  - ${row.label}: ${[
        row.hasPage ? "page" : "missing page",
        row.hasSpec ? "spec" : "missing spec",
        row.hasPlayground ? "playground" : "missing playground",
        row.hasTokenDetails ? "tokens" : "missing tokens",
      ].join(", ")}`,
    );
  }

  if (notInExplorer.length > 0 && listMissing) {
    console.log("\nShared UI components not yet in explorer navigation:");
    for (const item of notInExplorer) {
      console.log(`  - ${item}`);
    }
  } else if (notInExplorer.length > 0) {
    console.log(
      `\n${notInExplorer.length} shared UI components are not yet in explorer navigation. Run \`pnpm design-system:coverage\` for the list.`,
    );
  }

  if (strict && failures.length > 0) {
    console.error("\nDesign system explorer coverage failed:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  if (failures.length > 0) {
    console.warn(
      "\nCoverage gaps found. Run with --strict to fail on current explorer page gaps.",
    );
    return;
  }

  console.log("\nDesign system explorer coverage passed.");
}

runCoverage();
