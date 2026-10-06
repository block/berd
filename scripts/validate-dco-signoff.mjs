#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function authorIdentity() {
  const ident = git("var", "GIT_AUTHOR_IDENT");
  const match = ident.match(/^(.* <[^<>]+>) \d+ [+-]\d{4}$/);
  if (!match) {
    throw new Error(`could not parse Git author identity: ${ident}`);
  }
  return match[1];
}

function signedOffByIdentities(messagePath) {
  const trailers = git("interpret-trailers", "--parse", "--", messagePath);
  return trailers
    .split("\n")
    .map((line) => line.match(/^Signed-off-by:\s*(.+)$/i)?.[1].trim())
    .filter(Boolean);
}

const messagePath = process.argv[2];
if (!messagePath) {
  console.error("usage: validate-dco-signoff.mjs <commit-message-file>");
  process.exit(2);
}

try {
  const author = authorIdentity();
  if (!signedOffByIdentities(messagePath).includes(author)) {
    console.error(
      `DCO sign-off required: add exactly "Signed-off-by: ${author}".`,
    );
    console.error(
      "Retry the commit with `git commit --signoff` or add that trailer in your commit editor.",
    );
    process.exit(1);
  }
} catch (error) {
  console.error(`Unable to validate DCO sign-off: ${error.message}`);
  process.exit(1);
}
