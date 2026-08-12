import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const producer = path.join(repoRoot, "scripts", "e2e-run-contract.mjs");
const token = "0123456789abcdef0123456789abcdef";

function run(...args) {
  return JSON.parse(
    execFileSync(process.execPath, [producer, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  );
}

test("produces an isolated cross-platform contract and Tauri overlay", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "berd-e2e-contract-"));
  const runRoot = path.join(base, "run-123");
  const contract = run("--run-root", runRoot, "--driver-token", token);

  assert.equal(contract.BERD_E2E_MODE, "1");
  assert.equal(contract.BERD_E2E_RUN_ROOT, runRoot);
  assert.equal(contract.BERD_E2E_RUN_ID, "run-123");
  assert.equal(contract.APP_TEST_DRIVER_TOKEN, token);
  assert.equal(
    contract.APP_TEST_DRIVER_READY_FILE,
    path.join(runRoot, "app-test-driver.json"),
  );
  assert.deepEqual(
    JSON.parse(readFileSync(contract.TAURI_E2E_CONFIG, "utf8")),
    {
      identifier: "xyz.block.berd.e2e.run-123",
      productName: "Berd E2E (run-123)",
    },
  );
});

test("bootstraps provider selection and a run-scoped credential", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "berd-e2e-contract-"));
  const runRoot = path.join(base, "provider-run");
  const runtimeConfig = path.join(base, "runtime-config.json");
  writeFileSync(
    runtimeConfig,
    JSON.stringify({
      schemaVersion: 1,
      goose: {
        defaultModelProviderId: "openai",
        defaultModelId: "gpt-4o-mini",
        modelProviders: [
          {
            id: "openai",
            displayName: "OpenAI",
            setupMethod: "single_api_key",
            models: [{ id: "gpt-4o-mini", name: "GPT-4o mini" }],
          },
        ],
      },
      featureToggles: {},
    }),
  );

  const output = execFileSync(
    process.execPath,
    [
      producer,
      "--run-root",
      runRoot,
      "--driver-token",
      token,
      "--provider-id",
      "openai",
      "--model-id",
      "gpt-4o-mini",
      "--provider-key-env",
      "E2E_PROVIDER_TOKEN",
      "--runtime-config",
      runtimeConfig,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, E2E_PROVIDER_TOKEN: "short-lived-token" },
    },
  );
  const contract = JSON.parse(output);

  assert.match(
    readFileSync(path.join(runRoot, "goose", "config", "config.yaml"), "utf8"),
    /GOOSE_PROVIDER: "openai"[\s\S]*GOOSE_MODEL: "gpt-4o-mini"/,
  );
  assert.equal(
    readFileSync(path.join(runRoot, "goose", "config", "secrets.yaml"), "utf8"),
    'E2E_PROVIDER_TOKEN: "short-lived-token"\n',
  );
  assert.equal(
    readFileSync(contract.BERD_E2E_RUNTIME_CONFIG, "utf8"),
    readFileSync(runtimeConfig, "utf8"),
  );
  assert.doesNotMatch(output, /short-lived-token/);
});

test("rejects Apple-unsafe and root-mismatched run IDs", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "berd-e2e-contract-"));
  for (const args of [
    ["--run-root", path.join(base, "run_123"), "--driver-token", token],
    [
      "--run-root",
      path.join(base, "run-123"),
      "--run-id",
      "other",
      "--driver-token",
      token,
    ],
    [
      "--run-root",
      path.join(base, "run-123"),
      "--driver-token",
      token,
      "--runtime-config",
      "relative.json",
    ],
  ]) {
    const result = spawnSync(process.execPath, [producer, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
  }
});
