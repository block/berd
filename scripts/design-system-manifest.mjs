import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sharedUiDir = path.join(repoRoot, "src/shared/ui");
const manifestPath = path.join(
  repoRoot,
  "src/features/design-system/generated/componentManifest.ts",
);

const sourceTokenNames = new Set([
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "muted",
  "muted-foreground",
  "hover",
  "hover-foreground",
  "secondary",
  "secondary-foreground",
  "primary",
  "primary-foreground",
  "border",
  "input",
  "ring",
]);

const colorUtilityPrefixes = new Set([
  "bg",
  "text",
  "border",
  "ring",
  "fill",
  "stroke",
]);

const statePrefixes = [
  "active:",
  "aria-",
  "data-",
  "disabled:",
  "focus:",
  "focus-visible:",
  "hover:",
  "open:",
];

const semanticTokenPrefixes = [
  "background-",
  "border-",
  "ring-",
  "shadow-",
  "status-",
  "text-",
];

function sortValues(values) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function getPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }

  return name.getText();
}

function getObjectProperty(objectLiteral, propertyName) {
  return objectLiteral.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      getPropertyName(property.name) === propertyName,
  );
}

function getObjectKeys(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) {
    return [];
  }

  return node.properties
    .filter(ts.isPropertyAssignment)
    .map((property) => getPropertyName(property.name));
}

function getStringValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  return null;
}

function collectStringsFromText(sourceText) {
  return Array.from(
    sourceText.matchAll(/(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g),
  ).map((match) => match[2]);
}

function splitClasses(strings) {
  return strings.flatMap((value) => value.split(/\s+/).filter(Boolean));
}

function getUtilityCore(className) {
  const parts = className.split(":");
  return parts[parts.length - 1];
}

function getColorUtilityToken(className) {
  const core = getUtilityCore(className);
  const match =
    /^(bg|text|border|ring|fill|stroke)-([a-z0-9-]+)(?:\/.+)?$/.exec(core);

  if (!match) {
    return null;
  }

  const [, prefix, token] = match;
  if (!colorUtilityPrefixes.has(prefix)) {
    return null;
  }

  return token;
}

function getTokenClasses(classes) {
  return sortValues(
    classes.filter((className) => {
      const token = getColorUtilityToken(className);
      return (
        sourceTokenNames.has(token ?? "") ||
        semanticTokenPrefixes.some((prefix) => token?.startsWith(prefix))
      );
    }),
  );
}

function getStateClasses(classes) {
  return sortValues(
    classes.filter((className) =>
      statePrefixes.some((prefix) => className.startsWith(prefix)),
    ),
  );
}

function getSourceTokenClasses(classes) {
  return sortValues(
    classes.filter((className) =>
      sourceTokenNames.has(getColorUtilityToken(className) ?? ""),
    ),
  );
}

function getDataSlots(sourceText) {
  return sortValues(
    Array.from(sourceText.matchAll(/data-slot=["']([^"']+)["']/g)).map(
      (match) => match[1],
    ),
  );
}

function getNamedExportEntries(sourceFile) {
  const exports = new Map();

  function addExport(name, kind) {
    exports.set(name, kind);
  }

  function visit(node) {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isVariableStatement(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node)) &&
      ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            addExport(declaration.name.text, "value");
          }
        }
      } else if (node.name) {
        addExport(
          node.name.text,
          ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)
            ? "type"
            : "value",
        );
      }
    }

    if (ts.isExportDeclaration(node) && node.exportClause) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          addExport(element.name.text, "value");
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return Array.from(exports.entries())
    .map(([name, kind]) => ({ name, kind }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isCvaCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "cva"
  );
}

function getCvaMaps(sourceFile) {
  const maps = [];

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isCvaCall(node.initializer)
    ) {
      const config = node.initializer.arguments[1];
      const classNames = splitClasses(
        collectStringsFromText(node.initializer.getText(sourceFile)),
      );
      const variants = {};
      const defaultVariants = {};
      let compoundVariantCount = 0;

      if (config && ts.isObjectLiteralExpression(config)) {
        const variantsProperty = getObjectProperty(config, "variants");
        if (
          variantsProperty &&
          ts.isObjectLiteralExpression(variantsProperty.initializer)
        ) {
          for (const property of variantsProperty.initializer.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              ts.isObjectLiteralExpression(property.initializer)
            ) {
              variants[getPropertyName(property.name)] = getObjectKeys(
                property.initializer,
              );
            }
          }
        }

        const defaultVariantsProperty = getObjectProperty(
          config,
          "defaultVariants",
        );
        if (
          defaultVariantsProperty &&
          ts.isObjectLiteralExpression(defaultVariantsProperty.initializer)
        ) {
          for (const property of defaultVariantsProperty.initializer
            .properties) {
            if (ts.isPropertyAssignment(property)) {
              const value = getStringValue(property.initializer);
              if (value) {
                defaultVariants[getPropertyName(property.name)] = value;
              }
            }
          }
        }

        const compoundVariantsProperty = getObjectProperty(
          config,
          "compoundVariants",
        );
        if (
          compoundVariantsProperty &&
          ts.isArrayLiteralExpression(compoundVariantsProperty.initializer)
        ) {
          compoundVariantCount =
            compoundVariantsProperty.initializer.elements.length;
        }
      }

      maps.push({
        name: node.name.text,
        variants,
        defaultVariants,
        compoundVariantCount,
        tokenClasses: getTokenClasses(classNames),
        stateClasses: getStateClasses(classNames),
        sourceTokenClasses: getSourceTokenClasses(classNames),
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return maps;
}

function displayNameFromFile(fileName, exportEntries) {
  const preferredExport = exportEntries.find(
    (entry) =>
      entry.kind === "value" &&
      /^[A-Z]/.test(entry.name) &&
      !entry.name.endsWith("Props") &&
      !entry.name.endsWith("Context"),
  );

  if (preferredExport) {
    return preferredExport.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  }

  return fileName
    .replace(/\.tsx$/, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function buildDesignSystemManifest() {
  const files = fs
    .readdirSync(sharedUiDir)
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
    .sort((a, b) => a.localeCompare(b));

  return files.map((file) => {
    const absolutePath = path.join(sharedUiDir, file);
    const sourceText = fs.readFileSync(absolutePath, "utf8");
    const sourceFile = ts.createSourceFile(
      absolutePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const exportEntries = getNamedExportEntries(sourceFile);
    const exports = exportEntries.map((entry) => entry.name);
    const classNames = splitClasses(collectStringsFromText(sourceText));

    return {
      name: displayNameFromFile(file, exportEntries),
      source: path.relative(repoRoot, absolutePath),
      exports,
      slots: getDataSlots(sourceText),
      cva: getCvaMaps(sourceFile),
      tokenClasses: getTokenClasses(classNames),
      stateClasses: getStateClasses(classNames),
      sourceTokenClasses: getSourceTokenClasses(classNames),
    };
  });
}

export function renderDesignSystemManifest(manifest) {
  const source = `// Generated by scripts/design-system-manifest.mjs. Do not edit by hand.

export type DesignSystemCvaMap = {
  name: string;
  variants: Record<string, string[]>;
  defaultVariants: Record<string, string>;
  compoundVariantCount: number;
  tokenClasses: string[];
  stateClasses: string[];
  sourceTokenClasses: string[];
};

export type DesignSystemComponentManifestItem = {
  name: string;
  source: string;
  exports: string[];
  slots: string[];
  cva: DesignSystemCvaMap[];
  tokenClasses: string[];
  stateClasses: string[];
  sourceTokenClasses: string[];
};

export const designSystemComponentManifest = ${JSON.stringify(manifest, null, 2)} as const satisfies readonly DesignSystemComponentManifestItem[];
`;

  return execFileSync(
    "pnpm",
    [
      "exec",
      "biome",
      "format",
      "--stdin-file-path",
      "src/features/design-system/generated/componentManifest.ts",
    ],
    {
      cwd: repoRoot,
      input: source,
      encoding: "utf8",
    },
  );
}

function writeManifest({ check = false } = {}) {
  const rendered = renderDesignSystemManifest(buildDesignSystemManifest());
  const current = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, "utf8")
    : "";

  if (check) {
    if (current !== rendered) {
      console.error(
        "Design system manifest is stale. Run `pnpm design-system:generate`.",
      );
      process.exit(1);
    }

    console.log("Design system manifest is up to date.");
    return;
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, rendered);
  console.log(`Wrote ${path.relative(repoRoot, manifestPath)}.`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  writeManifest({ check: process.argv.includes("--check") });
}
