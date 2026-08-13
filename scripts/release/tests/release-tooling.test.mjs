import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateChangelog } from "../release.mjs";
import { compareSemver, parseSemver } from "../version.mjs";

const sourceRepo = resolve(import.meta.dirname, "../../..");
const releaseScript = join(sourceRepo, "scripts/release/release.mjs");
const tempDirs = [];

function run(command, args, { cwd, env = {} } = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "berd-release-tooling-"));
  tempDirs.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "origin.git");
  const bin = join(root, "bin");
  const notes = join(root, "notes.md");
  const calls = join(root, "gh-calls");
  await Promise.all([
    mkdir(join(repo, "scripts/release"), { recursive: true }),
    mkdir(join(repo, "src-tauri/crates/berdctl"), { recursive: true }),
    mkdir(join(repo, "src-tauri/plugins/berdctl"), { recursive: true }),
    mkdir(bin),
  ]);
  await Promise.all([
    writeFile(join(repo, "package.json"), '{"version":"0.4.12"}\n'),
    writeFile(
      join(repo, "src-tauri/tauri.conf.json"),
      '{"productName":"Berd","version":"0.4.12"}\n',
    ),
    writeFile(
      join(repo, "src-tauri/Cargo.toml"),
      '[package]\nname = "Berd"\nversion = "0.4.12"\nedition = "2021"\n',
    ),
    writeFile(
      join(repo, "src-tauri/crates/berdctl/Cargo.toml"),
      '[package]\nname = "berdctl"\nversion = "0.4.12"\nedition = "2021"\n',
    ),
    writeFile(
      join(repo, "src-tauri/plugins/berdctl/Cargo.toml"),
      '[package]\nname = "tauri-plugin-berdctl"\nversion = "0.4.12"\nedition = "2021"\n',
    ),
    writeFile(
      join(repo, "src-tauri/Cargo.lock"),
      `version = 4\n\n[[package]]\nname = "Berd"\nversion = "0.4.12"\n\n[[package]]\nname = "berdctl"\nversion = "0.4.12"\n\n[[package]]\nname = "tauri-plugin-berdctl"\nversion = "0.4.12"\n`,
    ),
    writeFile(join(repo, "CHANGELOG.md"), "# Changelog\n"),
    writeFile(
      join(repo, "scripts/release/release-channel.json"),
      JSON.stringify({
        repository: "block/berd",
        rollingTag: "berd-desktop-latest",
        minimumPublicVersion: "0.6.0-rc.1",
        platforms: ["darwin-aarch64"],
      }),
    ),
    writeFile(notes, "## changes\n\n- tested release tooling"),
    writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_CALLS"
if [[ "$1 $2" == "auth status" ]]; then
  exit 0
elif [[ "$1 $2" == "pr list" ]]; then
  printf '%s' "\${GH_PR_LIST_JSON:-[]}"
elif [[ "$1 $2" == "pr create" ]]; then
  printf '%s\n' 'https://github.com/block/berd/pull/123'
else
  exit 1
fi
`,
    ),
    writeFile(
      join(bin, "cargo"),
      '#!/usr/bin/env bash\nexit "$' + '{CARGO_STATUS:-0}"\n',
    ),
    writeFile(
      join(bin, "pnpm"),
      '#!/usr/bin/env bash\nexit "$' + '{PNPM_STATUS:-0}"\n',
    ),
  ]);
  await Promise.all(
    ["gh", "cargo", "pnpm"].map((name) => chmod(join(bin, name), 0o755)),
  );
  expect(run("git", ["init", "--bare", remote]).status).toBe(0);
  expect(run("git", ["init", "-b", "main", repo]).status).toBe(0);
  const git = (args) =>
    run("git", args, {
      cwd: repo,
      env: { GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  expect(git(["config", "user.name", "Release Test"]).status).toBe(0);
  expect(git(["config", "user.email", "release@example.test"]).status).toBe(0);
  expect(git(["add", "."]).status).toBe(0);
  expect(git(["commit", "-m", "initial"]).status).toBe(0);
  expect(git(["remote", "add", "origin", remote]).status).toBe(0);
  expect(git(["push", "--set-upstream", "origin", "main"]).status).toBe(0);
  const env = {
    BERD_RELEASE_DATE: "2026-08-12",
    BERD_RELEASE_REPO_ROOT: repo,
    GH_CALLS: calls,
    GIT_CONFIG_GLOBAL: "/dev/null",
    PATH: `${bin}:${process.env.PATH}`,
  };
  const release = (args, extraEnv = {}) =>
    run(process.execPath, [releaseScript, ...args], {
      cwd: repo,
      env: { ...env, ...extraEnv },
    });
  return { root, repo, remote, notes, calls, git, env, release };
}

describe("release SemVer and changelog", () => {
  it("uses canonical SemVer ordering for prereleases and stable releases", () => {
    expect(compareSemver("0.6.0-rc.1", "0.6.0-rc.2")).toBeLessThan(0);
    expect(compareSemver("0.6.0-rc.2", "0.6.0")).toBeLessThan(0);
    expect(compareSemver("100000000000000000000.0.0", "9.0.0")).toBeGreaterThan(
      0,
    );
    expect(() => parseSemver("v0.6.0")).toThrow(/without a leading v/);
    expect(() => parseSemver("0.6.0+build.1")).toThrow(/build metadata/);
  });

  it("replaces only the top same-version RC during stable promotion", () => {
    const rc1 = updateChangelog(
      "# Changelog\n",
      "0.6.0-rc.1",
      "rc one",
      "2026-08-10",
      "block/berd",
    );
    const rc2 = updateChangelog(
      rc1,
      "0.6.0-rc.2",
      "rc two",
      "2026-08-11",
      "block/berd",
    );
    const stable = updateChangelog(
      rc2,
      "0.6.0",
      "cumulative stable notes",
      "2026-08-12",
      "block/berd",
    );
    expect(stable).toContain("[v0.6.0](https://github.com/block/berd");
    expect(stable).not.toContain("v0.6.0-rc.2");
    expect(stable).toContain("v0.6.0-rc.1");
  });
});

describe("release preparation", () => {
  it("creates one lockstep release commit, pushes it, opens a PR, and resumes", async () => {
    const f = await fixture();
    const prepared = f.release(["prepare", "0.6.0-rc.1", f.notes]);
    expect(prepared.status, `${prepared.stdout}\n${prepared.stderr}`).toBe(0);
    expect(f.git(["branch", "--show-current"]).stdout.trim()).toBe(
      "release/v0.6.0-rc.1",
    );
    expect(f.git(["log", "-1", "--format=%s"]).stdout.trim()).toBe(
      "chore: release v0.6.0-rc.1",
    );
    const checked = f.release(["version-check", "0.6.0-rc.1"]);
    expect(checked.status, checked.stderr).toBe(0);
    expect(await readFile(join(f.repo, "CHANGELOG.md"), "utf8")).toContain(
      "https://github.com/block/berd/releases/tag/v0.6.0-rc.1",
    );
    expect(f.git(["tag", "--list"]).stdout.trim()).toBe("");
    expect(await readFile(f.calls, "utf8")).toContain("pr create");

    const head = f.git(["rev-parse", "HEAD"]).stdout.trim();
    const pr = JSON.stringify([
      {
        number: 123,
        url: "https://github.com/block/berd/pull/123",
        state: "OPEN",
        isDraft: false,
        mergedAt: null,
        headRefName: "release/v0.6.0-rc.1",
        baseRefName: "main",
        headRefOid: head,
        title: "chore: release v0.6.0-rc.1",
        mergeCommit: null,
      },
    ]);
    const resumed = f.release(["prepare", "0.6.0-rc.1", f.notes], {
      GH_PR_LIST_JSON: pr,
    });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain("https://github.com/block/berd/pull/123");
    expect(
      Number(
        f
          .git(["rev-list", "--count", "refs/remotes/origin/main..HEAD"])
          .stdout.trim(),
      ),
    ).toBe(1);
  });

  it("restores every tracked file when focused validation fails", async () => {
    const f = await fixture();
    const failed = f.release(["prepare", "0.6.0-rc.1", f.notes], {
      PNPM_STATUS: "1",
    });
    expect(failed.status).not.toBe(0);
    expect(f.git(["status", "--porcelain"]).stdout).toBe("");
    expect(
      JSON.parse(await readFile(join(f.repo, "package.json"), "utf8")).version,
    ).toBe("0.4.12");
    expect(await readFile(join(f.repo, "CHANGELOG.md"), "utf8")).toBe(
      "# Changelog\n",
    );
  });
});

describe("release publishing", () => {
  it("creates an annotated tag and pushes only the squash-merge commit tag", async () => {
    const f = await fixture();
    const prepared = f.release(["prepare", "0.6.0-rc.1", f.notes]);
    expect(prepared.status, prepared.stderr).toBe(0);
    const releaseHead = f.git(["rev-parse", "HEAD"]).stdout.trim();
    expect(f.git(["switch", "main"]).status).toBe(0);
    expect(f.git(["merge", "--squash", "release/v0.6.0-rc.1"]).status).toBe(0);
    expect(f.git(["commit", "-m", "chore: release v0.6.0-rc.1"]).status).toBe(
      0,
    );
    const mergeSha = f.git(["rev-parse", "HEAD"]).stdout.trim();
    expect(mergeSha).not.toBe(releaseHead);
    expect(f.git(["push", "origin", "main"]).status).toBe(0);

    const pr = JSON.stringify([
      {
        number: 123,
        url: "https://github.com/block/berd/pull/123",
        state: "MERGED",
        isDraft: false,
        mergedAt: "2026-08-12T00:00:00Z",
        headRefName: "release/v0.6.0-rc.1",
        baseRefName: "main",
        headRefOid: releaseHead,
        title: "chore: release v0.6.0-rc.1",
        mergeCommit: { oid: mergeSha },
      },
    ]);
    const published = f.release(["publish", "0.6.0-rc.1"], {
      GH_PR_LIST_JSON: pr,
    });
    expect(published.status, `${published.stdout}\n${published.stderr}`).toBe(
      0,
    );
    expect(published.stdout).toContain("actions/workflows/release.yml");
    expect(
      run("git", [
        "--git-dir",
        f.remote,
        "cat-file",
        "-t",
        "refs/tags/v0.6.0-rc.1",
      ]).stdout.trim(),
    ).toBe("tag");
    expect(
      run("git", [
        "--git-dir",
        f.remote,
        "rev-parse",
        "refs/tags/v0.6.0-rc.1^{commit}",
      ]).stdout.trim(),
    ).toBe(mergeSha);
  });
});

describe("release workflow source gate", () => {
  it("requires main ancestry and annotated tags before release creation", async () => {
    const [workflow, verifier, notesGenerator] = await Promise.all([
      readFile(join(sourceRepo, ".github/workflows/release.yml"), "utf8"),
      readFile(
        join(sourceRepo, "scripts/release/github/verify-release-source.sh"),
        "utf8",
      ),
      readFile(join(sourceRepo, "scripts/generate-release-notes.sh"), "utf8"),
    ]);
    expect(workflow.indexOf("Verify release source")).toBeLessThan(
      workflow.indexOf("Ensure immutable versioned release"),
    );
    expect(workflow).toContain('just release-version-check "$VERSION"');
    expect(verifier).toContain("git merge-base --is-ancestor");
    expect(verifier).toContain('== "tag"');
    expect(notesGenerator).not.toContain("gh release");
    expect(notesGenerator).not.toContain("read -r -p");
  });
});
