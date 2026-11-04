import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyGooseTestBinary } from "./goose-test-provenance.mjs";

async function withBuild(run) {
  const source = await mkdtemp(join(tmpdir(), "goose-test-provenance-"));
  try {
    const binary = join(source, "goose");
    const bytes = "expected build bytes";
    await writeFile(binary, bytes);
    const git = (...args) =>
      execFileSync("git", ["-C", source, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      }).trim();
    git("init", "--quiet");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "source",
    );
    await run({
      GOOSE_BIN: binary,
      GOOSE_SOURCE_DIR: source,
      GOOSE_EXPECTED_COMMIT: git("rev-parse", "HEAD"),
      GOOSE_EXPECTED_SHA256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

test("matching source and independently recorded binary digest proceed", () =>
  withBuild(async (env) => {
    const result = await verifyGooseTestBinary(env);
    assert.equal(result.commit, env.GOOSE_EXPECTED_COMMIT);
    assert.equal(result.digest, env.GOOSE_EXPECTED_SHA256);
    assert.equal(result.binary, env.GOOSE_BIN);
  }));

test("expected source paired with another executable is rejected", () =>
  withBuild(async (env) => {
    await writeFile(env.GOOSE_BIN, "unrelated build bytes");
    await assert.rejects(
      verifyGooseTestBinary(env),
      /Goose binary digest mismatch/,
    );
  }));

test("missing binary provenance is rejected", () =>
  withBuild(async (env) => {
    delete env.GOOSE_EXPECTED_SHA256;
    await assert.rejects(verifyGooseTestBinary(env), /GOOSE_EXPECTED_SHA256/);
  }));

test("a different source commit is rejected", () =>
  withBuild(async (env) => {
    env.GOOSE_EXPECTED_COMMIT = "0".repeat(40);
    await assert.rejects(verifyGooseTestBinary(env), /Goose source must match/);
  }));
