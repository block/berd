import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const integration = {
  GOOSE_BIN: "/tmp/goose",
  GOOSE_SOURCE_DIR: "/tmp/goose-source",
  GOOSE_EXPECTED_COMMIT: "a".repeat(40),
};

for (const missing of [
  "all",
  "GOOSE_SOURCE_DIR",
  "GOOSE_EXPECTED_COMMIT",
  "GOOSE_BIN",
  "none",
]) {
  test(`capacity project selection with ${missing} missing`, () => {
    const env = { ...process.env, ...integration };
    if (missing === "all") {
      for (const key of Object.keys(integration)) delete env[key];
    } else if (missing !== "none") {
      delete env[missing];
    }
    const output = execFileSync(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", "--list"],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.equal(output.includes("[capacity-errors]"), missing === "none");
    assert.ok(output.includes("[smoke]"));
  });
}

test("a binary override alone does not enable the capacity project", () => {
  const env = { ...process.env, GOOSE_BIN: integration.GOOSE_BIN };
  delete env.GOOSE_SOURCE_DIR;
  delete env.GOOSE_EXPECTED_COMMIT;
  const output = execFileSync(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", "--list"],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.ok(!output.includes("[capacity-errors]"));
});
