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

async function devDepsFixture() {
  const root = await mkdtemp(join(tmpdir(), "berd-dev-deps-"));
  tempDirs.push(root);
  const scriptDir = join(root, "scripts");
  const sdkDir = join(root, "sdk");
  const fakePnpm = join(root, "fake-pnpm");
  const calls = join(root, "pnpm-calls");

  await Promise.all([
    mkdir(scriptDir),
    mkdir(join(sdkDir, "schema"), { recursive: true }),
    mkdir(join(sdkDir, "src"), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(
      join(repo, "scripts/ensure-dev-deps.sh"),
      join(scriptDir, "ensure-dev-deps.sh"),
    ),
    writeFile(join(root, "package.json"), '{"name":"fixture"}\n'),
    writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
    writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['.', 'sdk']\n"),
    writeFile(join(sdkDir, "package.json"), '{"name":"sdk"}\n'),
    writeFile(join(sdkDir, "tsconfig.json"), "{}\n"),
    writeFile(join(sdkDir, "generate-schema.ts"), "export {};\n"),
    writeFile(join(sdkDir, "schema/schema.json"), "{}\n"),
    writeFile(join(sdkDir, "src/index.ts"), "export {};\n"),
    writeFile(
      fakePnpm,
      `#!/bin/bash
set -euo pipefail
printf '%s:%s\\n' "$PWD" "$*" >> "${calls}"
if [[ "\${1:-}" == "install" ]]; then
  if [[ "\${PNPM_REWRITE_LOCK:-0}" == "1" ]] && ! grep -q autoInstallPeers pnpm-lock.yaml; then
    printf 'settings:\n  autoInstallPeers: true\n' >> pnpm-lock.yaml
  fi
  mkdir -p node_modules/.pnpm
  cp pnpm-lock.yaml node_modules/.pnpm/lock.yaml
  if [[ "\${PNPM_INSTALL_FAIL:-0}" == "1" ]]; then
    exit 43
  fi
elif [[ "\${1:-}" == "build" ]]; then
  mkdir -p dist
  touch dist/index.js dist/index.d.ts
  if [[ "\${PNPM_BUILD_FAIL:-0}" == "1" ]]; then
    exit 42
  fi
  touch dist/resolve-binary.js dist/resolve-binary.d.ts
fi
`,
    ),
  ]);
  await Promise.all([
    chmod(join(scriptDir, "ensure-dev-deps.sh"), 0o755),
    chmod(fakePnpm, 0o755),
  ]);

  const run = (args = [], env = {}) =>
    spawnSync(join(scriptDir, "ensure-dev-deps.sh"), args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PNPM_BIN: fakePnpm, ...env },
    });

  return { root, calls, run };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("setup tooling regressions", () => {
  it("routes full setup and incremental dev preparation through the dependency guard", async () => {
    const [sdkPackage, justfile, ensureDevDeps] = await Promise.all([
      readFile(join(repo, "sdk/package.json"), "utf8"),
      readFile(justfilePath, "utf8"),
      readFile(join(repo, "scripts/ensure-dev-deps.sh"), "utf8"),
    ]);

    expect(JSON.parse(sdkPackage).scripts.build).toBe(
      "tsx generate-schema.ts && tsc",
    );
    expect(justfile).toMatch(
      /_setup-dev-deps:\n {4}\.\/scripts\/ensure-dev-deps\.sh --force\n/,
    );
    expect(justfile).toMatch(
      /_ensure-dev-deps:\n {4}\.\/scripts\/ensure-dev-deps\.sh\n/,
    );
    expect(justfile).toMatch(
      /_install-lefthook:\n {4}\.\/scripts\/install-lefthook\.sh\n/,
    );
    expect(ensureDevDeps).toContain('"$pnpm_bin" install');
    expect(ensureDevDeps).toContain('"$pnpm_bin" build');
  });

  it("records dependency inputs after pnpm updates the lockfile", async () => {
    const fixture = await devDepsFixture();

    const initial = fixture.run([], { PNPM_REWRITE_LOCK: "1" });
    expect(initial.status, `${initial.stdout}\n${initial.stderr}`).toBe(0);

    await writeFile(fixture.calls, "");
    const warm = fixture.run();
    expect(warm.status, `${warm.stdout}\n${warm.stderr}`).toBe(0);
    expect(warm.stdout).toContain("skipping install");
    expect(warm.stdout).toContain("skipping build");
    expect(await callsFor(fixture.calls)).toBe("");
  });

  it("skips current dependencies and rebuilds only stale SDK inputs", async () => {
    const fixture = await devDepsFixture();

    const first = fixture.run();
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    expect(await callsFor(fixture.calls)).toBe(
      `${fixture.root}:install\n${join(fixture.root, "sdk")}:build\n`,
    );

    await writeFile(fixture.calls, "");
    const warm = fixture.run();
    expect(warm.status, `${warm.stdout}\n${warm.stderr}`).toBe(0);
    expect(warm.stdout).toContain("skipping install");
    expect(warm.stdout).toContain("skipping build");
    expect(await callsFor(fixture.calls)).toBe("");

    await writeFile(fixture.calls, "");
    await writeFile(
      join(fixture.root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n",
    );
    const dependencyChange = fixture.run();
    expect(
      dependencyChange.status,
      `${dependencyChange.stdout}\n${dependencyChange.stderr}`,
    ).toBe(0);
    expect(await callsFor(fixture.calls)).toBe(
      `${fixture.root}:install\n${join(fixture.root, "sdk")}:build\n`,
    );

    await writeFile(fixture.calls, "");
    await writeFile(
      join(fixture.root, "sdk/src/index.ts"),
      "export const changed = true;\n",
    );
    const sdkChange = fixture.run();
    expect(sdkChange.status, `${sdkChange.stdout}\n${sdkChange.stderr}`).toBe(
      0,
    );
    expect(await callsFor(fixture.calls)).toBe(
      `${join(fixture.root, "sdk")}:build\n`,
    );

    await writeFile(fixture.calls, "");
    const forced = fixture.run(["--force"]);
    expect(forced.status, `${forced.stdout}\n${forced.stderr}`).toBe(0);
    expect(await callsFor(fixture.calls)).toBe(
      `${fixture.root}:install\n${join(fixture.root, "sdk")}:build\n`,
    );
  });

  it("rebuilds when a package-exported SDK artifact is missing", async () => {
    const fixture = await devDepsFixture();

    const initial = fixture.run();
    expect(initial.status, `${initial.stdout}\n${initial.stderr}`).toBe(0);

    await Promise.all([
      writeFile(fixture.calls, ""),
      rm(join(fixture.root, "sdk/dist/resolve-binary.js")),
    ]);
    const repaired = fixture.run();
    expect(repaired.status, `${repaired.stdout}\n${repaired.stderr}`).toBe(0);
    expect(await callsFor(fixture.calls)).toBe(
      `${join(fixture.root, "sdk")}:build\n`,
    );
  });

  it("retries dependency installation after an interrupted repair", async () => {
    const fixture = await devDepsFixture();

    const initial = fixture.run();
    expect(initial.status, `${initial.stdout}\n${initial.stderr}`).toBe(0);

    await writeFile(fixture.calls, "");
    const failed = fixture.run(["--force"], { PNPM_INSTALL_FAIL: "1" });
    expect(failed.status).toBe(43);

    await writeFile(fixture.calls, "");
    const retried = fixture.run();
    expect(retried.status, `${retried.stdout}\n${retried.stderr}`).toBe(0);
    expect(await callsFor(fixture.calls)).toBe(`${fixture.root}:install\n`);
  });

  it("retries an SDK build after an interrupted repair", async () => {
    const fixture = await devDepsFixture();

    const initial = fixture.run();
    expect(initial.status, `${initial.stdout}\n${initial.stderr}`).toBe(0);

    await writeFile(fixture.calls, "");
    const failed = fixture.run(["--force"], { PNPM_BUILD_FAIL: "1" });
    expect(failed.status).toBe(42);

    await writeFile(fixture.calls, "");
    const retried = fixture.run();
    expect(retried.status, `${retried.stdout}\n${retried.stderr}`).toBe(0);
    expect(await callsFor(fixture.calls)).toBe(
      `${join(fixture.root, "sdk")}:build\n`,
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
