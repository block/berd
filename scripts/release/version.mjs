#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

export function parseSemver(value, label = "version") {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `${label} must be canonical SemVer without a leading v or build metadata: ${value}`,
    );
  }
  return {
    value,
    core: match.slice(1, 4),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareDigitStrings(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return compareDigitStrings(left, right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareSemver(leftValue, rightValue) {
  const left =
    typeof leftValue === "string"
      ? parseSemver(leftValue, "left version")
      : leftValue;
  const right =
    typeof rightValue === "string"
      ? parseSemver(rightValue, "right version")
      : rightValue;

  for (let index = 0; index < 3; index += 1) {
    const compared = compareDigitStrings(left.core[index], right.core[index]);
    if (compared !== 0) return compared;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const compared = compareIdentifiers(
      left.prerelease[index],
      right.prerelease[index],
    );
    if (compared !== 0) return compared;
  }
  return 0;
}

export function sameNumericVersion(leftValue, rightValue) {
  const left = parseSemver(leftValue, "left version");
  const right = parseSemver(rightValue, "right version");
  return left.core.join(".") === right.core.join(".");
}

function usage() {
  console.error(
    "Usage: version.mjs validate <version> | compare <left> <right> | at-least <version> <minimum>",
  );
  process.exit(2);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "validate" && args.length === 1) {
      parseSemver(args[0]);
      return;
    }
    if (command === "compare" && args.length === 2) {
      process.stdout.write(`${compareSemver(args[0], args[1])}\n`);
      return;
    }
    if (command === "at-least" && args.length === 2) {
      if (compareSemver(args[0], args[1]) < 0) {
        throw new Error(`${args[0]} is below the minimum version ${args[1]}`);
      }
      return;
    }
    usage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
