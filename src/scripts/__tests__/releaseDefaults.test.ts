// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
    "official",
    "custom",
  ])("does not add release-only agents to %s builds by default", (buildKind) => {
    expect(runDefaultBundledAgents(buildKind)).toBe("");
  });

  it("always bundles Berdy from the distro resources", () => {
    const tauriConfig = JSON.parse(
      readFileSync(resolve(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
    );
    const berdy = readFileSync(
      resolve(repoRoot, "distro/agents/berdy.md"),
      "utf8",
    );

    expect(tauriConfig.bundle.resources["../distro"]).toBe("distro");
    expect(berdy).toContain("berdBundled: true");
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
