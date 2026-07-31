import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isColor } from "@asamuzakjp/css-color";
import postcss from "postcss";

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
  "accent-hover",
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
  /^surface-(?:composer(?:-(?:glass|hover|action(?:-(?:hover|active))?)?)?|chat-(?:composer(?:-hover)?|responding-pill-(?:bg|fg))|editor-panel|glass-(?:subtle|strong(?:-(?:hover|fg))?)|agent-tile-action-(?:bg|fg)(?:-hover)?)$/,
  /^surface-agent-profile-(?:bg|fg(?:-(?:80|muted|subtle|faint|placeholder))?|border|dot|control-bg(?:-hover)?|action-(?:fg|bg-hover))$/,
  /^message-user-bg$/,
  /^chip-(?:file|chat|project|agent|skill|automation)-(?:bg|fg)$/,
  /^skill-pill-fg$/,
  /^placeholder-composer$/,
  /^(?:success|warning|info)(?:-foreground)?$/,
  /^popover-inverse(?:-(?:foreground|muted-foreground|focus))?$/,
  /^clock-(?:face|mark|minute-hand|hand)$/,
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

// Semantic color tokens that are authored in `:root`/`.dark` but consumed with
// a raw `var(--token)` (pseudo-elements, the CSS Custom Highlight API, scoped
// palette blocks, arbitrary-value utilities, inline styles) instead of a
// bridged `bg-*`/`text-*`/`border-*` utility. They intentionally skip the
// `@theme inline` bridge because no utility class could ever use the generated
// color. Keep this in sync with the "Tokens Consumed In Raw CSS" table in
// docs/color-token-mapping.md (enforced by findRawCssDocSyncFindings).
const rawCssColorAllowlist = new Set([
  // ::selection pseudo-element
  "text-selection-bg",
  "text-selection-fg",
  // ::-webkit-scrollbar-thumb pseudo-element
  "scrollbar-thumb",
  "scrollbar-thumb-hover",
  // Sidebar row states, applied via arbitrary-value bg-[var(...)]
  "sidebar-row-hover",
  "sidebar-row-active",
  // Prototype nav text, applied via arbitrary-value text-[var(...)]
  // ::highlight(chat-search-match[-active]) Custom Highlight API ranges
  "chat-search-match-bg",
  "chat-search-match-fg",
  "chat-search-match-active-bg",
  "chat-search-match-active-fg",
  // .chat-context-panel-surface scoped palette block
  "chat-context-panel-bg",
  "chat-context-panel-fg",
  "chat-context-panel-muted-fg",
  "chat-context-panel-border",
  "chat-context-panel-accent",
  "chat-context-panel-accent-fg",
  "chat-context-panel-hover",
  // .chat-context-dropdown scoped block that remaps shadcn tokens
  "chat-context-dropdown-bg",
  "chat-context-dropdown-hover",
  "chat-context-dropdown-fg",
  "chat-context-dropdown-muted-fg",
  // Editor field surfaces (color-mix bases + arbitrary-value utilities)
  "surface-editor-panel-neutral",
  "surface-editor-control",
  "surface-editor-control-hover",
  "surface-editor-badge",
  "surface-color-picker-swatches",
  "text-editor-field-placeholder",
  "border-editor-divider",
  // Glass/overlay surfaces consumed via inline styles or arbitrary values
  "surface-popover-glass",
  "overlay-scrim",
  "overlay-search-scrim",
  "overlay-global-composer-shim",
  "overlay-global-composer-shim-peak",
  "overlay-global-composer-shim-clear",
  "ring-composer-glass-inner",
  "outline-composer-glass-outer",
  // SVG stroke consumed via an inline constant
  "project-glyph-fold-stroke",
  // Runtime project-tint hook (transparent default), set on wrappers
  "project-tint",
  // Dot-grid canvas color, consumed in a raw-CSS gradient
  "dot-color-base",
]);

// Color tokens that are intentionally theme-invariant: they carry a single
// value with no `.dark` override. Every other `:root` color token must have a
// matching `.dark` value. Documented in docs/color-token-mapping.md.
const darkPairingExemptTokens = new Set([
  "project-tint", // runtime hook, transparent until a project wrapper sets it
  "clock-hand", // second hand stays red in both themes
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
]);

const colorTokenMappingDocPath = path.join(
  repoRoot,
  "docs/color-token-mapping.md",
);
const rawCssDocStartMarker = "<!-- raw-css-color-tokens:start -->";
const rawCssDocEndMarker = "<!-- raw-css-color-tokens:end -->";

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
      hint: "Use a shadcn token utility like bg-accent, text-foreground, border-border, or an approved Berd extension.",
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
        hint: "Use a shadcn token name or add a narrow Berd extension to scripts/design-system-tokens.mjs and docs/color-token-mapping.md.",
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

function parseSemanticTokenBlocks(globalsText) {
  const root = postcss.parse(globalsText, { from: globalsPath });
  const blocks = new Map([
    [":root", []],
    [".dark", []],
  ]);
  const nestedBlocks = [];

  root.walkRules((rule) => {
    const selectors = rule.selectors.map((selector) => selector.trim());
    for (const [selector, rules] of blocks) {
      if (!selectors.includes(selector)) {
        continue;
      }
      if (rule.parent?.type === "root") {
        rules.push(rule);
      } else {
        nestedBlocks.push({
          selector,
          line: rule.source?.start?.line ?? 1,
          parent: rule.parent?.name ? `@${rule.parent.name}` : "a nested rule",
        });
      }
    }
  });

  return {
    root: parseCustomProperties(blocks.get(":root")),
    dark: parseCustomProperties(blocks.get(".dark")),
    nestedBlocks,
  };
}

function parseCustomProperties(rules) {
  if (rules.length === 0) {
    return null;
  }

  const declarations = [];
  for (const rule of rules) {
    rule.each((node) => {
      if (node.type !== "decl" || !node.prop.startsWith("--")) {
        return;
      }
      declarations.push({
        name: node.prop.slice(2),
        value: node.value.trim(),
        line: node.source?.start?.line ?? 1,
      });
    });
  }
  return declarations;
}

function findDuplicateTokenFindings(declarations, blockLabel) {
  const findings = [];
  const firstByName = new Map();

  for (const declaration of declarations ?? []) {
    const first = firstByName.get(declaration.name);
    if (!first) {
      firstByName.set(declaration.name, declaration);
      continue;
    }

    findings.push({
      source: path.relative(repoRoot, globalsPath),
      line: declaration.line,
      label: `duplicate semantic token in ${blockLabel}`,
      value: `--${declaration.name}`,
      hint: `Remove this duplicate declaration. --${declaration.name} was first defined on line ${first.line}; later declarations silently override the governed value.`,
    });
  }

  return findings;
}

function declarationsByName(declarations) {
  return new Map(
    (declarations ?? []).map((declaration) => [declaration.name, declaration]),
  );
}

function parseStandaloneVar(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("var(") || !trimmed.endsWith(")")) {
    return null;
  }

  const body = trimmed.slice(4, -1);
  let depth = 0;
  let commaIndex = -1;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth < 0) {
        return null;
      }
    } else if (char === "," && depth === 0) {
      commaIndex = index;
      break;
    }
  }

  const name = body
    .slice(0, commaIndex === -1 ? body.length : commaIndex)
    .trim();
  if (!/^--[a-z0-9-]+$/i.test(name)) {
    return null;
  }

  return {
    name: name.slice(2),
    fallback:
      commaIndex === -1 ? null : body.slice(commaIndex + 1).trim() || null,
  };
}

function findMatchingParen(value, openParenIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openParenIndex; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function resolveEmbeddedVars(value, tokenValues, resolving = new Set()) {
  let resolved = "";
  let cursor = 0;
  const varPattern = /var\s*\(/gi;

  while (cursor < value.length) {
    varPattern.lastIndex = cursor;
    const match = varPattern.exec(value);
    if (!match) {
      resolved += value.slice(cursor);
      break;
    }

    resolved += value.slice(cursor, match.index);
    const openParenIndex = value.indexOf("(", match.index);
    const closeParenIndex = findMatchingParen(value, openParenIndex);
    if (closeParenIndex === -1) {
      return null;
    }

    const variable = parseStandaloneVar(
      value.slice(match.index, closeParenIndex + 1),
    );
    if (!variable) {
      return null;
    }

    let replacement = null;
    if (variable.name.startsWith("color-")) {
      replacement = "transparent";
    } else if (
      tokenValues.has(variable.name) &&
      !resolving.has(variable.name)
    ) {
      replacement = resolveEmbeddedVars(
        tokenValues.get(variable.name),
        tokenValues,
        new Set(resolving).add(variable.name),
      );
    }
    if (replacement === null && variable.fallback) {
      replacement = resolveEmbeddedVars(
        variable.fallback,
        tokenValues,
        resolving,
      );
    }
    if (replacement === null) {
      return null;
    }

    resolved += replacement;
    cursor = closeParenIndex + 1;
  }

  return resolved;
}

function makeColorClassifier(tokenValues) {
  function valueIsColor(value, resolving = new Set()) {
    const variableOnly = parseStandaloneVar(value);
    if (variableOnly) {
      if (
        variableOnly.name.startsWith("color-") ||
        tokenValues.has(variableOnly.name)
      ) {
        const resolved = resolveEmbeddedVars(value, tokenValues, resolving);
        return resolved !== null && isColor(resolved);
      }
      return variableOnly.fallback
        ? valueIsColor(variableOnly.fallback, resolving)
        : false;
    }

    const resolved = resolveEmbeddedVars(value, tokenValues, resolving);
    return resolved !== null && isColor(resolved);
  }

  function hasInvalidEmbeddedColorVar(value) {
    return (
      value.includes("var(") &&
      parseStandaloneVar(value) === null &&
      isColor(value) &&
      !valueIsColor(value)
    );
  }

  return { hasInvalidEmbeddedColorVar, valueIsColor };
}

function classifySemanticColors(declarations, inheritedDeclarations = []) {
  const declarationsMap = declarationsByName(declarations);
  const values = new Map(
    Array.from(
      declarationsByName(inheritedDeclarations),
      ([name, declaration]) => [name, declaration.value],
    ),
  );
  for (const [name, declaration] of declarationsMap) {
    values.set(name, declaration.value);
  }
  const classifier = makeColorClassifier(values);
  return {
    colors: new Map(
      Array.from(declarationsMap).filter(([, declaration]) =>
        classifier.valueIsColor(declaration.value),
      ),
    ),
    declarations: declarationsMap,
    invalidEmbeddedColorVars: Array.from(declarationsMap.values()).filter(
      (declaration) => classifier.hasInvalidEmbeddedColorVar(declaration.value),
    ),
  };
}

export function findSemanticTokenFindings(
  globalsText,
  {
    rawCssColorTokens = rawCssColorAllowlist,
    darkPairingExemptions = darkPairingExemptTokens,
  } = {},
) {
  let parsed;
  try {
    parsed = parseSemanticTokenBlocks(globalsText);
  } catch (error) {
    return [
      {
        source: path.relative(repoRoot, globalsPath),
        line: error.line ?? 1,
        label: "invalid semantic token CSS",
        value: error.reason ?? "globals.css",
        hint: "Fix the CSS syntax before validating the semantic color contract.",
      },
    ];
  }

  if (!parsed.root) {
    return [
      {
        source: path.relative(repoRoot, globalsPath),
        line: 1,
        label: "missing :root block",
        value: ":root",
        hint: "The token check expects a :root block of semantic tokens in globals.css.",
      },
    ];
  }
  if (!parsed.dark) {
    return [
      {
        source: path.relative(repoRoot, globalsPath),
        line: 1,
        label: "missing .dark block",
        value: ".dark",
        hint: "The token check expects a .dark block of semantic token overrides in globals.css.",
      },
    ];
  }

  const findings = [
    ...findDuplicateTokenFindings(parsed.root, ":root"),
    ...findDuplicateTokenFindings(parsed.dark, ".dark"),
    ...parsed.nestedBlocks.map((block) => ({
      source: path.relative(repoRoot, globalsPath),
      line: block.line,
      label: "conditional semantic token block",
      value: `${block.parent} ${block.selector}`,
      hint: "Keep semantic color declarations in the top-level :root and .dark blocks so the token contract has one unconditional source of truth.",
    })),
  ];
  const root = classifySemanticColors(parsed.root);
  const dark = classifySemanticColors(parsed.dark, parsed.root);
  for (const declaration of [
    ...root.invalidEmbeddedColorVars,
    ...dark.invalidEmbeddedColorVars,
  ]) {
    findings.push({
      source: path.relative(repoRoot, globalsPath),
      line: declaration.line,
      label: "semantic color contains non-color variable",
      value: `--${declaration.name}: ${declaration.value}`,
      hint: "Every var() reference inside a color function must resolve to a value that keeps the complete declaration a valid color.",
    });
  }
  const bridgedTargets = new Set(
    findBridgeMatches(globalsText).map((bridge) => bridge.target),
  );

  for (const [name, declaration] of root.colors) {
    if (!bridgedTargets.has(name) && !rawCssColorTokens.has(name)) {
      findings.push({
        source: path.relative(repoRoot, globalsPath),
        line: declaration.line,
        label: "ungoverned semantic color token",
        value: `--${name}`,
        hint: "Bridge it into @theme inline (--color-x: var(--x)) if a utility class authors the color, or add it to the raw-CSS allowlist in scripts/design-system-tokens.mjs and the 'Tokens Consumed In Raw CSS' table in docs/color-token-mapping.md.",
      });
    }

    if (darkPairingExemptions.has(name)) {
      if (dark.declarations.has(name)) {
        findings.push({
          source: path.relative(repoRoot, globalsPath),
          line: dark.declarations.get(name).line,
          label: "stale dark-pairing exemption",
          value: `--${name}`,
          hint: "This token now has a .dark override. Remove it from darkPairingExemptTokens so the light/dark pair is validated normally.",
        });
      }
      continue;
    }

    const darkDeclaration = dark.declarations.get(name);
    if (!darkDeclaration) {
      findings.push({
        source: path.relative(repoRoot, globalsPath),
        line: declaration.line,
        label: "semantic color token missing dark value",
        value: `--${name}`,
        hint: "Add a matching color value in the .dark block, or add the token to darkPairingExemptTokens in scripts/design-system-tokens.mjs if it is intentionally theme-invariant.",
      });
    } else if (!dark.colors.has(name)) {
      findings.push({
        source: path.relative(repoRoot, globalsPath),
        line: darkDeclaration.line,
        label: "semantic color token has non-color dark value",
        value: `--${name}: ${darkDeclaration.value}`,
        hint: "The .dark override must resolve to a color because its :root declaration is a semantic color token.",
      });
    }
  }

  for (const [name, declaration] of dark.colors) {
    if (!root.declarations.has(name)) {
      findings.push({
        source: path.relative(repoRoot, globalsPath),
        line: declaration.line,
        label: "semantic color token missing root value",
        value: `--${name}`,
        hint: "Define the semantic color token in :root before overriding it in .dark.",
      });
    } else if (!root.colors.has(name)) {
      findings.push({
        source: path.relative(repoRoot, globalsPath),
        line: declaration.line,
        label: "dark color token has non-color root value",
        value: `--${name}`,
        hint: "The :root declaration must resolve to a color because its .dark override is a semantic color token.",
      });
    }
  }

  for (const name of rawCssColorTokens) {
    if (!root.colors.has(name)) {
      findings.push({
        source: "scripts/design-system-tokens.mjs",
        line: 1,
        label: "stale raw-CSS allowlist entry",
        value: `--${name}`,
        hint: "This token is not a defined :root color token. Remove it from rawCssColorAllowlist (and docs/color-token-mapping.md) if it was deleted or renamed.",
      });
    }
  }

  for (const name of darkPairingExemptions) {
    if (!root.colors.has(name)) {
      findings.push({
        source: "scripts/design-system-tokens.mjs",
        line: 1,
        label: "stale dark-pairing exemption",
        value: `--${name}`,
        hint: "This token is not a defined :root color token. Remove it from darkPairingExemptTokens if it was deleted, renamed, or no longer resolves to a color.",
      });
    }
  }

  return findings;
}

export function findRawCssDocSyncFindings({
  docText: providedDocText,
  rawCssColorTokens = rawCssColorAllowlist,
} = {}) {
  const docRelativePath = path.relative(repoRoot, colorTokenMappingDocPath);
  let docText = providedDocText;
  if (docText === undefined) {
    try {
      docText = fs.readFileSync(colorTokenMappingDocPath, "utf8");
    } catch {
      return [
        {
          source: docRelativePath,
          line: 1,
          label: "missing color token mapping doc",
          value: docRelativePath,
          hint: "docs/color-token-mapping.md is the source of truth for the raw-CSS token list.",
        },
      ];
    }
  }

  const startIndex = docText.indexOf(rawCssDocStartMarker);
  const endIndex = docText.indexOf(rawCssDocEndMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return [
      {
        source: docRelativePath,
        line: 1,
        label: "missing raw-CSS token markers",
        value: `${rawCssDocStartMarker} … ${rawCssDocEndMarker}`,
        hint: "Wrap the machine-readable raw-CSS token list in docs/color-token-mapping.md between the raw-css-color-tokens:start/end markers.",
      },
    ];
  }

  const between = docText.slice(
    startIndex + rawCssDocStartMarker.length,
    endIndex,
  );
  const documentedTokens = new Set(
    between
      .split("\n")
      .map((line) => line.trim().match(/^--([a-z0-9-]+)$/)?.[1])
      .filter(Boolean),
  );

  const findings = [];
  for (const name of rawCssColorTokens) {
    if (!documentedTokens.has(name)) {
      findings.push({
        source: docRelativePath,
        line: getLineNumber(docText, startIndex),
        label: "raw-CSS token missing from docs",
        value: `--${name}`,
        hint: "Add this token to the raw-css-color-tokens list in docs/color-token-mapping.md so the doc matches scripts/design-system-tokens.mjs.",
      });
    }
  }
  for (const name of documentedTokens) {
    if (!rawCssColorTokens.has(name)) {
      findings.push({
        source: docRelativePath,
        line: getLineNumber(docText, startIndex),
        label: "documented raw-CSS token missing from allowlist",
        value: `--${name}`,
        hint: "Add this token to rawCssColorAllowlist in scripts/design-system-tokens.mjs, or remove it from docs/color-token-mapping.md.",
      });
    }
  }

  return findings;
}

export function runTokenCheck() {
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
  findings.push(...findSemanticTokenFindings(globalsText));
  findings.push(...findRawCssDocSyncFindings());

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTokenCheck();
}
