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

function getExplorerComponentEntries() {
  const sourceText = fs.readFileSync(sectionsPath, "utf8");
  const componentBlocks = Array.from(
    sourceText.matchAll(
      /DESIGN_SYSTEM_(UNUSED_COMPONENT|COMPONENT)_SECTIONS[\s\S]*?=\s*\[([\s\S]*?)\];/g,
    ),
  ).map((match) => ({
    usage: match[1] === "UNUSED_COMPONENT" ? "unused" : "used",
    block: match[2],
  }));

  return componentBlocks.flatMap((componentBlock) =>
    Array.from(componentBlock.block.matchAll(/label:\s*"([^"]+)"/g)).map(
      (match) => ({
        label: match[1],
        usage: componentBlock.usage,
      }),
    ),
  );
}

function listSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(entryPath);
    }

    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
      ? [entryPath]
      : [];
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getProductImportUsage(manifest) {
  const ignoredPathParts = [
    `${path.sep}src${path.sep}features${path.sep}design-system${path.sep}`,
    `${path.sep}src${path.sep}shared${path.sep}ui${path.sep}`,
    `${path.sep}__tests__${path.sep}`,
  ];
  const sourceFiles = listSourceFiles(path.join(repoRoot, "src")).filter(
    (filePath) =>
      !filePath.endsWith(".test.ts") &&
      !filePath.endsWith(".test.tsx") &&
      !ignoredPathParts.some((ignoredPathPart) =>
        filePath.includes(ignoredPathPart),
      ),
  );
  const usageByName = new Map();

  for (const sourceFile of sourceFiles) {
    const sourceText = fs.readFileSync(sourceFile, "utf8");
    const relativeSourceFile = path.relative(repoRoot, sourceFile);

    for (const component of manifest) {
      const importPath = component.source
        .replace(/^src\/shared\/ui\//, "@/shared/ui/")
        .replace(/\.tsx$/, "");
      const importPattern = new RegExp(
        `from\\s+["']${escapeRegex(importPath)}["']|import\\s*\\(\\s*["']${escapeRegex(importPath)}["']\\s*\\)`,
      );

      if (!importPattern.test(sourceText)) {
        continue;
      }

      const usages = usageByName.get(component.name) ?? [];
      usages.push(relativeSourceFile);
      usageByName.set(component.name, usages);
    }
  }

  return usageByName;
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
  const explorerComponentEntries = getExplorerComponentEntries();
  const explorerLabels = explorerComponentEntries.map((entry) => entry.label);
  const productImportUsage = getProductImportUsage(manifest);
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

  for (const entry of explorerComponentEntries) {
    const usages = productImportUsage.get(entry.label) ?? [];
    if (entry.usage === "used" && usages.length === 0) {
      failures.push(
        `${entry.label}: listed under Components but no product imports were found`,
      );
    }
    if (entry.usage === "unused" && usages.length > 0) {
      failures.push(
        `${entry.label}: listed under Not used but imported by ${usages.join(
          ", ",
        )}`,
      );
    }
  }

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
