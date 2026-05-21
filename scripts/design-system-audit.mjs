import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDesignSystemManifest } from "./design-system-manifest.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const coveredComponents = [
  "Button",
  "Button Group",
  "Badge",
  "Alert",
  "Tabs",
  "Toggle Group",
  "Select",
  "Dropdown Menu",
];

const paletteUtilityPattern =
  /\b(?:bg|border|text|ring|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d{1,3})?\b/g;

const rawColorPattern =
  /(?<![A-Za-z0-9_-])(?:#[0-9A-Fa-f]{3,8}|rgba?\(|hsla?\()/g;

function getLineNumber(sourceText, index) {
  return sourceText.slice(0, index).split("\n").length;
}

function findMatches({ sourceText, pattern, source, label }) {
  return Array.from(sourceText.matchAll(pattern)).map((match) => ({
    source,
    line: getLineNumber(sourceText, match.index ?? 0),
    label,
    value: match[0],
  }));
}

function runAudit() {
  const manifest = buildDesignSystemManifest();
  const findings = [];
  for (const componentName of coveredComponents) {
    const item = manifest.find((component) => component.name === componentName);
    if (!item) {
      findings.push({
        source: "design-system manifest",
        line: 1,
        label: "missing covered component",
        value: componentName,
      });
      continue;
    }

    const sourcePath = path.join(repoRoot, item.source);
    const sourceText = fs.readFileSync(sourcePath, "utf8");

    findings.push(
      ...findMatches({
        sourceText,
        pattern: paletteUtilityPattern,
        source: item.source,
        label: "tailwind palette utility",
      }),
      ...findMatches({
        sourceText,
        pattern: rawColorPattern,
        source: item.source,
        label: "raw color value",
      }),
    );
  }

  if (findings.length > 0) {
    console.error("Design system audit failed:");
    for (const finding of findings) {
      console.error(
        `  - ${finding.source}:${finding.line} [${finding.label}] ${finding.value}`,
      );
    }
    process.exit(1);
  }

  console.log("Design system audit passed.");
}

runAudit();
