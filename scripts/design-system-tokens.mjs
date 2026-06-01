import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const srcRoot = path.join(repoRoot, "src");
const globalsPath = path.join(repoRoot, "src/shared/styles/globals.css");

const deletedTokenFamilies = [
  ["background-default", "bg-background or --background"],
  ["text-default", "text-foreground or --foreground"],
  ["background-alt", "bg-accent or --accent"],
  ["background-hover", "bg-accent or --accent"],
  ["text-hover", "text-accent-foreground or --accent-foreground"],
  ["background-muted", "bg-muted or --muted"],
  ["text-muted", "text-muted-foreground or --muted-foreground"],
  ["background-medium", "bg-secondary or --secondary"],
  ["background-primary", "bg-primary or --primary"],
  ["text-on-primary", "text-primary-foreground or --primary-foreground"],
  ["background-danger-strong", "bg-destructive or --destructive"],
  [
    "text-on-danger-strong",
    "text-destructive-foreground or --destructive-foreground",
  ],
  ["background-danger", "bg-destructive/10 or --destructive"],
  ["text-danger", "text-destructive or --destructive"],
  ["background-success", "bg-success/10"],
  ["background-warning", "bg-warning/10"],
  ["background-info", "bg-info/10"],
  ["surface-card", "bg-card or --card"],
  ["surface-user-bubble", "bg-message-user-bg or --message-user-bg"],
  ["surface-overlay", "bg-popover or --popover"],
  ["background-popover", "bg-popover or --popover"],
  ["text-on-popover", "text-popover-foreground or --popover-foreground"],
  ["border-default", "border-border or --border"],
  ["border-soft-divider", "border-border/70 or --border"],
  ["border-soft", "border-border/80 or --border"],
  ["border-strong", "border-border or --border"],
  ["border-focus", "border-ring or --ring"],
  ["ring-focus", "ring-ring or --ring"],
  ["sidebar-nav-bg-hover", "bg-sidebar-accent or --sidebar-accent"],
  ["sidebar-nav-bg-selected", "bg-sidebar-accent or --sidebar-accent"],
  ["sidebar-nav-fg", "text-sidebar-foreground or --sidebar-foreground"],
  [
    "sidebar-nav-font-weight-light",
    "font-normal or --sidebar-nav-font-weight (400)",
  ],
  ["surface-chrome", "bg-sidebar or --sidebar"],
  ["surface-tile", "bg-accent or --accent"],
  ["surface-button", "bg-accent or --accent"],
  ["surface-install", "bg-canvas-base or --canvas-base"],
  ["text-subtle", "text-muted-foreground or --muted-foreground"],
  ["text-alt", "text-muted-foreground or --muted-foreground"],
  ["text-title", "text-foreground or --foreground"],
  ["text-placeholder", "placeholder:text-muted-foreground"],
  ["text-inverse", "text-primary-foreground or --primary-foreground"],
  ["text-on-secondary", "text-secondary-foreground"],
  ["background-inverse", "bg-primary"],
  ["brand-foreground", "primary-foreground"],
  ["ui-warning-bg", "bg-warning/10"],
  ["ui-warning", "text-warning"],
];

const paletteUtilityPattern =
  /\b(?:[a-z-]+:|\[[^\]]+\]:)*(?:bg|border|text|ring|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d{1,3})?\b/g;

const allowedBridgeNames = new Set([
  "accent",
  "accent-foreground",
  "background",
  "border",
  "card",
  "card-foreground",
  "destructive",
  "destructive-foreground",
  "foreground",
  "input",
  "muted",
  "muted-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "ring",
  "secondary",
  "secondary-foreground",
  "sidebar",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-ring",
]);

const allowedBridgePatterns = [
  /^canvas-(?:base|project-tint)$/,
  /^app-top-bar-control-fg(?:-disabled)?$/,
  /^sidebar-section-action-(?:bg|fg)(?:-hover)?$/,
  /^surface-(?:composer(?:-glass|-hover)?|editor-panel|glass-strong(?:-(?:hover|fg))?)$/,
  /^surface-agent-profile-(?:bg|fg(?:-(?:80|muted|subtle|faint|placeholder))?|border|dot|control-bg(?:-hover)?|action-(?:fg|bg-hover))$/,
  /^message-user-bg$/,
  /^chip-(?:file|chat|project|agent|skill|automation)-(?:bg|fg)$/,
  /^skill-pill-fg$/,
  /^placeholder-composer$/,
  /^(?:success|warning|info)(?:-foreground)?$/,
  /^popover-inverse(?:-(?:foreground|muted-foreground))?$/,
  /^clock-(?:face|mark|hand)$/,
  /^sticky-note-(?:warm|cool|rose|blue|lavender|peach|foreground|muted)$/,
  /^dark-(?:04|10|40)$/,
  /^status-(?:added|deleted|modified)$/,
  /^chart-[1-5]$/,
];

const allowedBridgeTargets = new Map([
  ["placeholder-composer", "text-placeholder-composer"],
]);

const requiredGlobalTokens = [
  [
    "text-app-top-bar-title",
    "Top bar breadcrumbs use this token for their title size.",
  ],
  [
    "text-app-top-bar-title-leading",
    "Top bar breadcrumbs use this token for their compact line height.",
  ],
  [
    "text-app-top-bar-icon",
    "Top bar icon buttons use this token to size glyphs inside the chrome control.",
  ],
  [
    "text-app-top-bar-title-compact",
    "Responsive top bar breadcrumbs use this token at compact widths.",
  ],
];

function listSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") {
        return [];
      }
      return listSourceFiles(entryPath);
    }

    return /\.(?:ts|tsx|css)$/.test(entry.name) ? [entryPath] : [];
  });
}

function getLineNumber(sourceText, index) {
  return sourceText.slice(0, index).split("\n").length;
}

function isAllowedBridgeName(name) {
  return (
    allowedBridgeNames.has(name) ||
    allowedBridgePatterns.some((pattern) => pattern.test(name))
  );
}

function findDeletedTokenMatches(sourceText, relativePath) {
  return deletedTokenFamilies.flatMap(([tokenFamily, replacement]) => {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9-])${tokenFamily}(?![A-Za-z0-9-])`,
      "g",
    );
    return Array.from(sourceText.matchAll(pattern)).map((match) => ({
      source: relativePath,
      line: getLineNumber(sourceText, match.index ?? 0),
      label: "deleted token family",
      value: tokenFamily,
      hint: `Use ${replacement}.`,
    }));
  });
}

function findPaletteUtilityMatches(sourceText, relativePath) {
  return Array.from(sourceText.matchAll(paletteUtilityPattern)).map(
    (match) => ({
      source: relativePath,
      line: getLineNumber(sourceText, match.index ?? 0),
      label: "raw Tailwind palette utility",
      value: match[0],
      hint: "Use a shadcn token utility like bg-accent, text-foreground, border-border, or an approved Goose extension.",
    }),
  );
}

function getThemeInlineBlock(sourceText) {
  const start = sourceText.indexOf("@theme inline");
  if (start === -1) {
    return "";
  }

  const openBrace = sourceText.indexOf("{", start);
  if (openBrace === -1) {
    return "";
  }

  let depth = 0;
  for (let index = openBrace; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return sourceText.slice(openBrace + 1, index);
      }
    }
  }

  return "";
}

function findBridgeMatches(sourceText) {
  const themeBlock = getThemeInlineBlock(sourceText);
  return Array.from(
    themeBlock.matchAll(
      /--color-([a-z0-9-]+):\s*var\(\s*--([a-z0-9-]+)\s*\)\s*;/g,
    ),
  ).map((match) => ({
    name: match[1],
    target: match[2],
    index: match.index ?? 0,
    block: themeBlock,
  }));
}

function findBridgeFindings(sourceText) {
  const bridgeMatches = findBridgeMatches(sourceText);
  const findings = [];

  for (const bridge of bridgeMatches) {
    if (!isAllowedBridgeName(bridge.name)) {
      findings.push({
        source: path.relative(repoRoot, globalsPath),
        line: getLineNumber(bridge.block, bridge.index),
        label: "unapproved Tailwind color bridge",
        value: `--color-${bridge.name}`,
        hint: "Use a shadcn token name or add a narrow Goose extension to scripts/design-system-tokens.mjs and docs/color-token-mapping.md.",
      });
      continue;
    }

    const expectedTarget = allowedBridgeTargets.get(bridge.name) ?? bridge.name;
    if (bridge.target !== expectedTarget) {
      findings.push({
        source: path.relative(repoRoot, globalsPath),
        line: getLineNumber(bridge.block, bridge.index),
        label: "unexpected Tailwind color bridge target",
        value: `--color-${bridge.name}: var(--${bridge.target})`,
        hint: `Expected --color-${bridge.name} to map to --${expectedTarget}.`,
      });
    }
  }

  return findings;
}

function findRequiredGlobalTokenFindings(sourceText) {
  return requiredGlobalTokens
    .filter(([token]) => {
      const tokenPattern = new RegExp(`--${token}\\s*:`);
      return !tokenPattern.test(sourceText);
    })
    .map(([token, hint]) => ({
      source: path.relative(repoRoot, globalsPath),
      line: 1,
      label: "missing required global token",
      value: `--${token}`,
      hint,
    }));
}

function runTokenCheck() {
  const findings = [];
  const sourceFiles = listSourceFiles(srcRoot);

  for (const sourceFile of sourceFiles) {
    const sourceText = fs.readFileSync(sourceFile, "utf8");
    const relativePath = path.relative(repoRoot, sourceFile);
    findings.push(...findDeletedTokenMatches(sourceText, relativePath));

    if (!sourceFile.endsWith(".css")) {
      findings.push(...findPaletteUtilityMatches(sourceText, relativePath));
    }
  }

  const globalsText = fs.readFileSync(globalsPath, "utf8");
  findings.push(...findRequiredGlobalTokenFindings(globalsText));
  findings.push(...findBridgeFindings(globalsText));

  if (findings.length > 0) {
    console.error("Design system token contract failed:");
    for (const finding of findings) {
      console.error(
        `  - ${finding.source}:${finding.line} [${finding.label}] ${finding.value}`,
      );
      console.error(`    ${finding.hint}`);
    }
    process.exit(1);
  }

  console.log("Design system token contract passed.");
}

runTokenCheck();
