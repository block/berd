import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export async function verifyGooseTestBinary(env = process.env) {
  const binary = env.GOOSE_BIN;
  const source = env.GOOSE_SOURCE_DIR;
  const expected = env.GOOSE_EXPECTED_COMMIT;
  const expectedDigest = env.GOOSE_EXPECTED_SHA256;
  if (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error(
      "Set GOOSE_EXPECTED_SHA256 to the independently recorded build digest.",
    );
  }
  if (!binary || !isAbsolute(binary) || !source || !expected) {
    throw new Error(
      "Set absolute GOOSE_BIN, GOOSE_SOURCE_DIR and full GOOSE_EXPECTED_COMMIT to the tested Goose build and source.",
    );
  }
  const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert.equal(
    commit,
    expected,
    "Goose source must match the explicit test pin",
  );
  const digest = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  assert.equal(digest, expectedDigest, "Goose binary digest mismatch");
  return { binary, commit, digest };
}
