// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { validateBundledAgentFile } from "../../../scripts/validate-bundled-agents";
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

  it("always includes the valid public starter set", () => {
    const tauriConfig = JSON.parse(
      readFileSync(resolve(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
    );
    const agentDirectory = resolve(repoRoot, "distro/agents");
    const agentFiles = readdirSync(agentDirectory)
      .filter((name) => name.endsWith(".md"))
      .sort();

    expect(tauriConfig.bundle.resources["../distro"]).toBe("distro");
    expect(agentFiles).toEqual(
      expect.arrayContaining([
        "agt-builder.md",
        "berdy.md",
        "choosey.md",
        "copycat.md",
        "pushback.md",
        "tinker.md",
        "wildcard.md",
      ]),
    );
    for (const fileName of agentFiles) {
      expect(
        validateBundledAgentFile(resolve(agentDirectory, fileName)),
      ).toEqual([]);
    }
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
