// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
const mainSource = readFileSync(
  fileURLToPath(new URL("../main.tsx", import.meta.url)),
  "utf8",
);
const appShellPath = fileURLToPath(new URL("./AppShell.tsx", import.meta.url));
const importFromPattern =
  /^\s*import\s+(?!type\b)[\s\S]*?\s+from\s+["']([^"']+)["'];?/gm;
const exportFromPattern =
  /^\s*export\s+(?!type\b)[\s\S]*?\s+from\s+["']([^"']+)["'];?/gm;
const sideEffectImportPattern = /^\s*import\s+["']([^"']+)["'];?/gm;

function resolveLocalModule(fromFile: string, specifier: string) {
  if (specifier.startsWith("@/")) {
    return resolveModulePath(path.join(SRC_ROOT, specifier.slice(2)));
  }
  if (specifier.startsWith(".")) {
    return resolveModulePath(path.resolve(path.dirname(fromFile), specifier));
  }
  return null;
}

function resolveModulePath(basePath: string) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ];
  return (
    candidates.find(
      (candidate) =>
        (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) &&
        existsSync(candidate),
    ) ?? null
  );
}

function localValueSpecifiers(source: string) {
  const specifiers = new Set<string>();
  for (const pattern of [
    importFromPattern,
    exportFromPattern,
    sideEffectImportPattern,
  ]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match != null) {
      specifiers.add(match[1]);
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

function collectStaticValueImportGraph(entry: string) {
  const visited = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    const source = readFileSync(current, "utf8");
    for (const specifier of localValueSpecifiers(source)) {
      const resolved = resolveLocalModule(current, specifier);
      if (resolved && !visited.has(resolved)) {
        pending.push(resolved);
      }
    }
  }

  return visited;
}

describe("main entrypoint berdctl bridge loading", () => {
  it("loads the berdctl bridge dynamically from the main-window branch only", () => {
    expect(mainSource).not.toContain(
      'import { BerdctlBridge } from "@/features/berdctl"',
    );
    expect(mainSource).toContain(
      'import("@/features/berdctl/bridge/BerdctlBridge")',
    );

    const sessionBranchStart = mainSource.indexOf("} else if (sessionId) {");
    const mainBranchStart = mainSource.indexOf("} else {", sessionBranchStart);
    expect(sessionBranchStart).toBeGreaterThan(-1);
    expect(mainBranchStart).toBeGreaterThan(sessionBranchStart);

    const sessionBranch = mainSource.slice(sessionBranchStart, mainBranchStart);
    const mainBranch = mainSource.slice(mainBranchStart);
    expect(sessionBranch).not.toContain("<OptionalBerdctlBridge />");
    expect(mainBranch).toContain("<BackgroundQueuedMessageDrain />");
    expect(mainBranch).toContain("<OptionalBerdctlBridge />");
  });

  it("mounts the background queued-message drain unconditionally", () => {
    expect(mainSource).toContain(
      'import { BackgroundQueuedMessageDrain } from "@/features/chat/ui/BackgroundQueuedMessageDrain"',
    );
    expect(mainSource).not.toContain("OptionalBackgroundQueuedMessageDrain");
  });

  it("reports a failed dynamic bridge import without boot-failing the app", () => {
    expect(mainSource).toContain(
      'console.error("Failed to load berdctl bridge:"',
    );
    expect(mainSource).toContain(
      'reportRendererError("berdctl_bridge_load_failed", error)',
    );
  });

  it("keeps AppShell's static graph away from berdctl bridge and command execution", () => {
    const graph = collectStaticValueImportGraph(appShellPath);

    for (const forbidden of [
      "features/berdctl/bridge/BerdctlBridge.tsx",
      "features/berdctl/bridge/lifecycle.ts",
      "features/berdctl/commands/registry.ts",
    ]) {
      expect(graph.has(path.join(SRC_ROOT, forbidden)), forbidden).toBe(false);
    }
  });
});
