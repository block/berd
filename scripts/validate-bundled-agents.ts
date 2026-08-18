#!/usr/bin/env tsx
// Build-time validator for bundled agent Markdown files.
//
// Ensures every agent that ships inside the app bundle has the frontmatter
// contract the runtime seeder expects:
//   - YAML frontmatter delimited by `--- ... ---` at the top of the file
//   - `name` and `description` fields
//   - an `avatar` ref in `app-avatar:<id>` form so the renderer can warm it
//   - `metadata.berdBundled: true` so updates/re-seeds behave like the other
//     bundled agents
//
// Run via pnpm exec: `pnpm exec tsx scripts/validate-bundled-agents.ts <path>...`
// Exits 0 on success, 1 on any validation failure, 2 on usage error.

import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const APP_AVATAR_REF_RE = /^app-avatar:[a-z0-9][a-z0-9_-]{0,63}$/;
const BUNDLED_SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface BundledAgentFrontmatter {
  name?: unknown;
  description?: unknown;
  avatar?: unknown;
  metadata?: {
    berdBundled?: unknown;
    berdBundledSource?: unknown;
    [key: string]: unknown;
  };
}

const USAGE =
  "usage: pnpm exec tsx scripts/validate-bundled-agents.ts <agent.md>...";

function error(message: string, file?: string): string {
  return file ? `${file}: ${message}` : message;
}

export function validateBundledAgent(
  filePath: string,
  rawContents: string,
): string[] {
  const errors: string[] = [];

  if (!filePath.endsWith(".md")) {
    errors.push(
      error("bundled agent file must have a .md extension", filePath),
    );
  }

  const match = FRONTMATTER_RE.exec(rawContents);
  if (!match) {
    errors.push(
      error(
        "agent must start with a YAML frontmatter block delimited by `---`",
        filePath,
      ),
    );
    return errors;
  }

  let frontmatter: BundledAgentFrontmatter;
  try {
    frontmatter = YAML.parse(match[1]) as BundledAgentFrontmatter;
  } catch (yamlError) {
    errors.push(
      error(`invalid YAML frontmatter: ${String(yamlError)}`, filePath),
    );
    return errors;
  }

  if (
    !frontmatter ||
    typeof frontmatter !== "object" ||
    Array.isArray(frontmatter)
  ) {
    errors.push(error("agent frontmatter must be a YAML mapping", filePath));
    return errors;
  }

  if (typeof frontmatter.name !== "string" || frontmatter.name.trim() === "") {
    errors.push(
      error("frontmatter `name` is required and must be a string", filePath),
    );
  }

  if (
    typeof frontmatter.description !== "string" ||
    frontmatter.description.trim() === ""
  ) {
    errors.push(
      error(
        "frontmatter `description` is required and must be a string",
        filePath,
      ),
    );
  }

  if (
    typeof frontmatter.avatar !== "string" ||
    !APP_AVATAR_REF_RE.test(frontmatter.avatar)
  ) {
    errors.push(
      error(
        "frontmatter `avatar` is required and must be an `app-avatar:<id>` ref",
        filePath,
      ),
    );
  }

  const expectedSource = filePath.endsWith(".md")
    ? basename(filePath, ".md")
    : undefined;
  if (
    expectedSource !== undefined &&
    (typeof frontmatter.metadata?.berdBundledSource !== "string" ||
      !BUNDLED_SOURCE_RE.test(frontmatter.metadata.berdBundledSource) ||
      frontmatter.metadata.berdBundledSource !== expectedSource)
  ) {
    errors.push(
      error(
        `frontmatter metadata.berdBundledSource must equal filename stem \`${expectedSource}\``,
        filePath,
      ),
    );
  }

  if (frontmatter.metadata?.berdBundled !== true) {
    errors.push(
      error(
        "frontmatter must set `metadata.berdBundled: true` so the agent is treated as bundled",
        filePath,
      ),
    );
  }

  return errors;
}

export function validateBundledAgentFile(filePath: string): string[] {
  try {
    const contents = new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(filePath),
    );
    return validateBundledAgent(filePath, contents);
  } catch (readError) {
    return [error(`failed to read file: ${String(readError)}`, filePath)];
  }
}

function main(paths: string[]): number {
  if (paths.length === 0) {
    console.error(USAGE);
    return 2;
  }

  const allErrors: string[] = [];

  for (const filePath of paths) {
    const errors = validateBundledAgentFile(filePath);
    if (errors.length === 0) {
      console.log(`:white_check_mark: ${basename(filePath)}`);
    } else {
      allErrors.push(...errors);
    }
  }

  if (allErrors.length > 0) {
    console.error("Bundled agent validation failed:");
    for (const message of allErrors) {
      console.error(`  - ${message}`);
    }
    return 1;
  }

  return 0;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exit(main(process.argv.slice(2)));
}
