import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../../..");
const justfilePath = join(repo, "justfile");
const installScriptPath = join(repo, "scripts/install-lefthook.sh");
const tempDirs = [];

function runHook(root, env = {}) {
  return spawnSync(join(root, "install-lefthook"), [], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function hookFixture({
  git = "directory",
  local = false,
  localStatus = 0,
  pathTool = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "berd-setup-tooling-"));
  tempDirs.push(root);
  const localBin = join(root, "bin");
  const pathBin = join(root, "path-bin");
  const calls = join(root, "lefthook-calls");

  const installScript = join(root, "install-lefthook");
  await Promise.all([
    mkdir(localBin),
    mkdir(pathBin),
    copyFile(installScriptPath, installScript),
    git === "directory"
      ? mkdir(join(root, ".git"))
      : git === "file"
        ? writeFile(
            join(root, ".git"),
            "gitdir: ../main/.git/worktrees/linked\n",
          )
        : Promise.resolve(),
  ]);
  await Promise.all([
    chmod(installScript, 0o755),
    symlink(process.env.BASH ?? "/bin/bash", join(pathBin, "bash")),
  ]);

  const writeHook = async (path, label, status = 0) => {
    await writeFile(
      path,
      `#!/bin/sh\nprintf '%s %s\\n' '${label}' "$*" > "$LEFTHOOK_CALLS"\nexit ${status}\n`,
    );
    await chmod(path, 0o755);
  };
  await Promise.all([
    local && writeHook(join(localBin, "lefthook"), "local", localStatus),
    pathTool && writeHook(join(pathBin, "lefthook"), "path"),
  ]);

  return { root, calls, pathBin };
}

async function callsFor(path) {
  return readFile(path, "utf8").catch(() => "");
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("setup tooling regressions", () => {
  it("uses the SDK's direct build commands through the pnpm setup recipe", async () => {
    const [sdkPackage, justfile] = await Promise.all([
      readFile(join(repo, "sdk/package.json"), "utf8"),
      readFile(justfilePath, "utf8"),
    ]);

    expect(JSON.parse(sdkPackage).scripts.build).toBe(
      "tsx generate-schema.ts && tsc",
    );
    expect(justfile).toMatch(
      /_setup-dev-deps:\n {4}pnpm install\n {4}cd sdk && pnpm build\n/,
    );
    expect(justfile).toMatch(
      /_install-lefthook:\n {4}\.\/scripts\/install-lefthook\.sh\n/,
    );
  });

  it("prefers the repository-local lefthook shim over PATH", async () => {
    const fixture = await hookFixture({ local: true, pathTool: true });
    const result = runHook(fixture.root, {
      LEFTHOOK_CALLS: fixture.calls,
      PATH: fixture.pathBin,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(await callsFor(fixture.calls)).toBe("local install --force\n");
  });

  it("does not mask repository-local lefthook failures", async () => {
    const fixture = await hookFixture({
      local: true,
      localStatus: 42,
      pathTool: true,
    });
    const result = runHook(fixture.root, {
      LEFTHOOK_CALLS: fixture.calls,
      PATH: fixture.pathBin,
    });

    expect(result.status).toBe(42);
    expect(await callsFor(fixture.calls)).toBe("local install --force\n");
  });

  it("falls back to a lefthook executable on PATH", async () => {
    const fixture = await hookFixture({ pathTool: true });
    const result = runHook(fixture.root, {
      LEFTHOOK_CALLS: fixture.calls,
      PATH: fixture.pathBin,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(await callsFor(fixture.calls)).toBe("path install --force\n");
  });

  it("fails with actionable guidance when lefthook is unavailable", async () => {
    const fixture = await hookFixture();
    const result = runHook(fixture.root, {
      PATH: fixture.pathBin,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/lefthook not found/i);
    expect(result.stderr).toContain("source ./bin/activate-hermit");
    expect(result.stderr).toContain("install lefthook");
  });

  it("skips hook installation for a linked worktree", async () => {
    const fixture = await hookFixture({
      git: "file",
      local: true,
      pathTool: true,
    });
    const result = runHook(fixture.root, {
      LEFTHOOK_CALLS: fixture.calls,
      PATH: fixture.pathBin,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "Skipping lefthook install in Git worktree",
    );
    expect(await callsFor(fixture.calls)).toBe("");
  });

  it("installs hooks before building managed Goose", async () => {
    const justfile = await readFile(justfilePath, "utf8");

    expect(justfile).toMatch(
      /setup: _setup-dev-deps\n {4}just _install-lefthook\n {4}GOOSE_DEV_MODE=required \.\/scripts\/ensure-local-goose\.sh\n/,
    );
  });
});
