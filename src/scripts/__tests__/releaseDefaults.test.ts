// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const releaseDefaultsRunner = resolve(
  repoRoot,
  "src/scripts/__tests__/fixtures/defaultBundledAgents.sh",
);

function runDefaultBundledAgents(buildKind: string) {
  return execFileSync("bash", [releaseDefaultsRunner, buildKind], {
    encoding: "utf8",
  });
}

describe("release bundled-agent defaults", () => {
  it.each([
    ["official", "block,builderbot"],
    ["custom", "builderbot"],
  ])("uses the %s build default", (buildKind, expected) => {
    expect(runDefaultBundledAgents(buildKind)).toBe(expected);
  });

  it("rejects an invalid build kind", () => {
    const result = spawnSync("bash", [releaseDefaultsRunner, "preview"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "invalid build_kind 'preview' (expected official or custom)",
    );
  });
});
