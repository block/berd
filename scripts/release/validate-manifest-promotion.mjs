#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const [candidatePath, currentPath] = process.argv.slice(2);
if (!candidatePath || !currentPath) {
  console.error(
    "Usage: validate-manifest-promotion.mjs <candidate-latest.json> <current-latest.json>",
  );
  process.exit(2);
}

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

function parseSemver(value, label) {
  const match = semverPattern.exec(value);
  if (!match)
    throw new Error(`${label} has invalid canonical SemVer: ${value}`);
  return {
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

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const compared = compareDigitStrings(left.core[index], right.core[index]);
    if (compared !== 0) return compared;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
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

try {
  const [candidateBytes, currentBytes] = await Promise.all([
    readFile(candidatePath),
    readFile(currentPath),
  ]);
  const candidate = JSON.parse(candidateBytes);
  const current = JSON.parse(currentBytes);
  const compared = compareSemver(
    parseSemver(candidate.version, "candidate manifest"),
    parseSemver(current.version, "current manifest"),
  );
  if (compared < 0) {
    throw new Error(
      `refusing updater downgrade from ${current.version} to ${candidate.version}`,
    );
  }
  if (compared === 0) {
    candidate.pub_date = current.pub_date;
    const normalizedCandidate = `${JSON.stringify(candidate, null, 2)}\n`;
    const normalizedCurrent = `${JSON.stringify(current, null, 2)}\n`;
    if (normalizedCandidate !== normalizedCurrent) {
      throw new Error(
        `refusing non-idempotent replacement of updater version ${candidate.version}`,
      );
    }
    await writeFile(candidatePath, currentBytes);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
