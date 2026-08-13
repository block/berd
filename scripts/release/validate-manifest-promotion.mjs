#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { compareSemver, parseSemver } from "./version.mjs";

const [candidatePath, currentPath] = process.argv.slice(2);
if (!candidatePath || !currentPath) {
  console.error(
    "Usage: validate-manifest-promotion.mjs <candidate-latest.json> <current-latest.json>",
  );
  process.exit(2);
}

try {
  const [candidateBytes, currentBytes] = await Promise.all([
    readFile(candidatePath),
    readFile(currentPath),
  ]);
  const candidate = JSON.parse(candidateBytes);
  const current = JSON.parse(currentBytes);
  parseSemver(candidate.version, "candidate manifest version");
  parseSemver(current.version, "current manifest version");
  const compared = compareSemver(candidate.version, current.version);
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
