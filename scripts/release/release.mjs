#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareSemver, parseSemver, sameNumericVersion } from "./version.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, "../..");
const RELEASE_FILES = [
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/crates/berdctl/Cargo.toml",
  "src-tauri/plugins/berdctl/Cargo.toml",
  "src-tauri/Cargo.lock",
  "CHANGELOG.md",
];
const RELEASE_COMMIT_BODY =
  "synchronize app, cli, plugin, lockfile, and changelog versions.";

function fail(message) {
  throw new Error(message);
}

function commandResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    input: options.input,
    stdio: options.visible ? "inherit" : "pipe",
  });
}

function run(command, args, options = {}) {
  const result = commandResult(command, args, options);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    fail(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return (result.stdout ?? "").trim();
}

function succeeds(command, args, options = {}) {
  return commandResult(command, args, options).status === 0;
}

function repoRoot() {
  return resolve(process.env.BERD_RELEASE_REPO_ROOT || defaultRepoRoot);
}

function cargoPackage(content, path) {
  const start = content.indexOf("[package]");
  if (start < 0) fail(`${path} has no [package] section`);
  const nextSection = content.indexOf("\n[", start + "[package]".length);
  const end = nextSection < 0 ? content.length : nextSection;
  const section = content.slice(start, end);
  const name = /^name\s*=\s*"([^"]+)"\s*$/m.exec(section)?.[1];
  const version = /^version\s*=\s*"([^"]+)"\s*$/m.exec(section)?.[1];
  if (!name || !version) fail(`${path} has an incomplete [package] section`);
  parseSemver(version, `${path} package version`);
  return { name, version, start, end, section };
}

function updateCargoPackage(content, path, expectedName, version) {
  const pkg = cargoPackage(content, path);
  if (pkg.name !== expectedName) {
    fail(`${path} package is ${pkg.name}, expected ${expectedName}`);
  }
  const updatedSection = pkg.section.replace(
    /^(version\s*=\s*")[^"]+("\s*)$/m,
    `$1${version}$2`,
  );
  return `${content.slice(0, pkg.start)}${updatedSection}${content.slice(pkg.end)}`;
}

function cargoLockPackages(content) {
  const starts = [...content.matchAll(/^\[\[package\]\]\s*$/gm)].map(
    (match) => match.index,
  );
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? content.length;
    const block = content.slice(start, end);
    return {
      start,
      end,
      block,
      name: /^name\s*=\s*"([^"]+)"\s*$/m.exec(block)?.[1],
      version: /^version\s*=\s*"([^"]+)"\s*$/m.exec(block)?.[1],
    };
  });
}

function lockVersion(content, packageName) {
  const matches = cargoLockPackages(content).filter(
    (pkg) => pkg.name === packageName,
  );
  if (matches.length !== 1 || !matches[0].version) {
    fail(
      `src-tauri/Cargo.lock must contain exactly one ${packageName} package entry`,
    );
  }
  parseSemver(matches[0].version, `${packageName} Cargo.lock version`);
  return matches[0].version;
}

function updateLockVersions(content, version) {
  let updated = content;
  for (const packageName of ["Berd", "berdctl", "tauri-plugin-berdctl"]) {
    const matches = cargoLockPackages(updated).filter(
      (pkg) => pkg.name === packageName,
    );
    if (matches.length !== 1) {
      fail(
        `src-tauri/Cargo.lock must contain exactly one ${packageName} package entry`,
      );
    }
    const pkg = matches[0];
    const block = pkg.block.replace(
      /^(version\s*=\s*")[^"]+("\s*)$/m,
      `$1${version}$2`,
    );
    updated = `${updated.slice(0, pkg.start)}${block}${updated.slice(pkg.end)}`;
  }
  return updated;
}

function releaseHeadingPattern() {
  return /^## \[v([^\]]+)\]\(([^)]+)\) - (\d{4}-\d{2}-\d{2})\s*$/gm;
}

function changelogEntries(content) {
  if (!content.startsWith("# Changelog\n")) {
    fail("CHANGELOG.md must start with '# Changelog'");
  }
  const matches = [...content.matchAll(releaseHeadingPattern())];
  const releaseShapedHeadings = [...content.matchAll(/^## \[v[^\]]+\].*$/gm)];
  if (releaseShapedHeadings.length !== matches.length) {
    fail("CHANGELOG.md contains a malformed release heading");
  }
  return matches.map((match, index) => {
    const version = match[1];
    parseSemver(version, "changelog version");
    const bodyStart = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const body = content.slice(bodyStart, end).trim();
    if (!body) fail(`CHANGELOG.md entry v${version} is empty`);
    return {
      version,
      url: match[2],
      date: match[3],
      start: match.index,
      end,
      body,
    };
  });
}

function changelogEntry(content, version, repository) {
  const entries = changelogEntries(content).filter(
    (entry) => entry.version === version,
  );
  if (entries.length !== 1) {
    fail(`CHANGELOG.md must contain exactly one v${version} entry`);
  }
  const entry = entries[0];
  const expectedUrl = `https://github.com/${repository}/releases/tag/v${version}`;
  if (entry.url !== expectedUrl) {
    fail(`CHANGELOG.md v${version} must link to ${expectedUrl}`);
  }
  return entry;
}

export function updateChangelog(content, version, notes, date, repository) {
  const prefix = "# Changelog\n\n";
  if (content !== "# Changelog\n" && !content.startsWith(prefix)) {
    fail("CHANGELOG.md must contain only release entries after its title");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fail(`invalid release date: ${date}`);
  }
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (
    Number.isNaN(parsedDate.valueOf()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    fail(`invalid release date: ${date}`);
  }
  const entries = changelogEntries(content);
  if (entries[0] && entries[0].start !== prefix.length) {
    fail("CHANGELOG.md must contain only release entries after its title");
  }
  if (entries.some((entry) => entry.version === version)) {
    fail(`CHANGELOG.md already contains v${version}`);
  }
  const parsed = parseSemver(version);
  const link = `https://github.com/${repository}/releases/tag/v${version}`;
  const newEntry = `## [v${version}](${link}) - ${date}\n\n${notes.trim()}`;
  let existingEntries = content.slice(content.indexOf("\n") + 1).trim();

  if (
    parsed.prerelease.length === 0 &&
    entries[0]?.version &&
    sameNumericVersion(entries[0].version, version) &&
    parseSemver(entries[0].version).prerelease[0] === "rc"
  ) {
    existingEntries = content.slice(entries[0].end).trim();
  }

  return `${prefix}${newEntry}${existingEntries ? `\n\n${existingEntries}` : ""}\n`;
}

function fileReader(root) {
  return (path) => readFile(join(root, path), "utf8");
}

function gitReader(root, ref) {
  if (!/^[0-9a-f]{40}$/.test(ref)) fail(`invalid git commit: ${ref}`);
  return async (path) => run("git", ["show", `${ref}:${path}`], { cwd: root });
}

async function versionState(read) {
  const [packageJson, tauriJson, appCargo, cliCargo, pluginCargo, lock] =
    await Promise.all([
      read("package.json"),
      read("src-tauri/tauri.conf.json"),
      read("src-tauri/Cargo.toml"),
      read("src-tauri/crates/berdctl/Cargo.toml"),
      read("src-tauri/plugins/berdctl/Cargo.toml"),
      read("src-tauri/Cargo.lock"),
    ]);
  const packageVersion = JSON.parse(packageJson).version;
  const tauriVersion = JSON.parse(tauriJson).version;
  const app = cargoPackage(appCargo, "src-tauri/Cargo.toml");
  const cli = cargoPackage(cliCargo, "src-tauri/crates/berdctl/Cargo.toml");
  const plugin = cargoPackage(
    pluginCargo,
    "src-tauri/plugins/berdctl/Cargo.toml",
  );
  if (
    app.name !== "Berd" ||
    cli.name !== "berdctl" ||
    plugin.name !== "tauri-plugin-berdctl"
  ) {
    fail("release Cargo package names do not match the lockstep package set");
  }
  const versions = new Map([
    ["package.json", packageVersion],
    ["src-tauri/tauri.conf.json", tauriVersion],
    ["Berd Cargo.toml", app.version],
    ["berdctl Cargo.toml", cli.version],
    ["tauri-plugin-berdctl Cargo.toml", plugin.version],
    ["Berd Cargo.lock", lockVersion(lock, "Berd")],
    ["berdctl Cargo.lock", lockVersion(lock, "berdctl")],
    [
      "tauri-plugin-berdctl Cargo.lock",
      lockVersion(lock, "tauri-plugin-berdctl"),
    ],
  ]);
  for (const [label, version] of versions) parseSemver(version, label);
  return versions;
}

async function releaseConfig(read) {
  const config = JSON.parse(await read("scripts/release/release-channel.json"));
  if (
    typeof config.repository !== "string" ||
    !config.repository.includes("/")
  ) {
    fail("release-channel.json has an invalid repository");
  }
  parseSemver(config.minimumPublicVersion, "minimum public version");
  return config;
}

function validateMinimumPublicVersion(version, config) {
  if (compareSemver(version, config.minimumPublicVersion) < 0) {
    fail(
      `release version ${version} is below minimum public version ${config.minimumPublicVersion}`,
    );
  }
}

async function checkVersions({ root, expected, ref } = {}) {
  const resolvedRoot = root || repoRoot();
  if (expected) parseSemver(expected, "expected version");
  const read = ref ? gitReader(resolvedRoot, ref) : fileReader(resolvedRoot);
  const versions = await versionState(read);
  const unique = new Set(versions.values());
  if (unique.size !== 1) {
    fail(
      `release versions are not in lockstep:\n${[...versions]
        .map(([label, version]) => `- ${label}: ${version}`)
        .join("\n")}`,
    );
  }
  const actual = [...unique][0];
  if (expected && actual !== expected) {
    fail(`release version is ${actual}, expected ${expected}`);
  }
  if (expected) {
    const config = await releaseConfig(read);
    const changelog = await read("CHANGELOG.md");
    changelogEntry(changelog, expected, config.repository);
  }
  return actual;
}

async function writeReleaseFiles(root, version, notes, date, repository) {
  const paths = Object.fromEntries(
    await Promise.all(
      RELEASE_FILES.map(async (path) => [
        path,
        await readFile(join(root, path)),
      ]),
    ),
  );
  const text = (path) => paths[path].toString("utf8");
  const packageJson = JSON.parse(text("package.json"));
  const tauriJson = JSON.parse(text("src-tauri/tauri.conf.json"));
  packageJson.version = version;
  tauriJson.version = version;
  const updates = new Map([
    ["package.json", `${JSON.stringify(packageJson, null, 2)}\n`],
    ["src-tauri/tauri.conf.json", `${JSON.stringify(tauriJson, null, 2)}\n`],
    [
      "src-tauri/Cargo.toml",
      updateCargoPackage(
        text("src-tauri/Cargo.toml"),
        "src-tauri/Cargo.toml",
        "Berd",
        version,
      ),
    ],
    [
      "src-tauri/crates/berdctl/Cargo.toml",
      updateCargoPackage(
        text("src-tauri/crates/berdctl/Cargo.toml"),
        "src-tauri/crates/berdctl/Cargo.toml",
        "berdctl",
        version,
      ),
    ],
    [
      "src-tauri/plugins/berdctl/Cargo.toml",
      updateCargoPackage(
        text("src-tauri/plugins/berdctl/Cargo.toml"),
        "src-tauri/plugins/berdctl/Cargo.toml",
        "tauri-plugin-berdctl",
        version,
      ),
    ],
    [
      "src-tauri/Cargo.lock",
      updateLockVersions(text("src-tauri/Cargo.lock"), version),
    ],
    [
      "CHANGELOG.md",
      updateChangelog(text("CHANGELOG.md"), version, notes, date, repository),
    ],
  ]);
  for (const [path, content] of updates) {
    await writeFile(join(root, path), content);
  }
  return paths;
}

async function restoreReleaseFiles(root, originals) {
  run("git", ["restore", "--staged", "--", ...RELEASE_FILES], {
    cwd: root,
  });
  for (const [path, content] of Object.entries(originals)) {
    await writeFile(join(root, path), content);
  }
}

function assertReleaseFileSet(output, failureMessage) {
  const paths = output.split("\n").filter(Boolean).sort();
  const expected = [...RELEASE_FILES].sort();
  if (
    paths.length !== expected.length ||
    paths.some((path, index) => path !== expected[index])
  ) {
    fail(`${failureMessage}:\n${paths.join("\n")}`);
  }
}

function assertClean(root) {
  const status = run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: root,
    },
  );
  if (status) fail(`working tree must be clean:\n${status}`);
}

function refExists(root, ref) {
  return succeeds("git", ["show-ref", "--verify", "--quiet", ref], {
    cwd: root,
  });
}

function fetchReleaseState(root) {
  run(
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      "refs/heads/main:refs/remotes/origin/main",
      "refs/tags/v*:refs/tags/v*",
    ],
    { cwd: root },
  );
}

function remoteTagTarget(root, tag) {
  const result = commandResult(
    "git",
    [
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ],
    { cwd: root },
  );
  if (result.status !== 0) fail("failed to inspect remote tags");
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  const tagRef = `refs/tags/${tag}`;
  const tagObject = lines.find((line) => line.endsWith(`\t${tagRef}`));
  const peeledTag = lines.find((line) => line.endsWith(`\t${tagRef}^{}`));
  if (!tagObject || !peeledTag) fail(`remote tag must be annotated: ${tag}`);
  const [target] = peeledTag.split(/\s+/, 1);
  if (!/^[0-9a-f]{40}$/.test(target)) {
    fail(`remote tag has invalid target: ${tag}`);
  }
  return target;
}

function validateLocalTag(root, tag, expectedTarget) {
  if (
    run("git", ["cat-file", "-t", `refs/tags/${tag}`], { cwd: root }) !== "tag"
  ) {
    fail(`local tag must be annotated: ${tag}`);
  }
  const target = run("git", ["rev-parse", `refs/tags/${tag}^{commit}`], {
    cwd: root,
  });
  if (target !== expectedTarget) {
    fail(`local tag ${tag} targets ${target}, expected ${expectedTarget}`);
  }
}

export function releaseNotesFrom(root, version, changelog) {
  const args = ["describe", "--tags", "--abbrev=0", "--match", "v*"];
  const parsed = parseSemver(version);
  if (parsed.prerelease.length > 0) {
    return run("git", args, { cwd: root });
  }
  args.push("--exclude", "v*-*");
  const previousStable = commandResult("git", args, { cwd: root });
  if (previousStable.status === 0) return previousStable.stdout.trim();

  const firstPrerelease = changelogEntries(changelog)
    .filter(
      (entry) =>
        sameNumericVersion(entry.version, version) &&
        parseSemver(entry.version).prerelease.length > 0,
    )
    .at(-1);
  const from =
    /^\*\*Full Changelog\*\*: https:\/\/github\.com\/\S+\/compare\/(.+?)\.\.\.\S+$/m.exec(
      firstPrerelease?.body ?? "",
    )?.[1];
  if (
    !from ||
    !succeeds("git", ["rev-parse", "--verify", `${from}^{commit}`], {
      cwd: root,
    })
  ) {
    fail("no previous stable tag or first prerelease changelog baseline found");
  }
  return from;
}

async function generateReviewedNotes(root, version, changelog) {
  const from = releaseNotesFrom(root, version, changelog);
  process.stderr.write(`generating release notes from ${from}...\n`);
  const notes = run("just", ["release-notes", from], { cwd: root });
  if (!notes) fail("generated release notes are empty");
  process.stdout.write(`\n${notes}\n\n`);
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question("use these release notes? [y/N] ");
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      fail("release preparation cancelled");
    }
  } finally {
    prompt.close();
  }
  return notes;
}

function releasePrs(root, repository, branch) {
  const json = run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "100",
      "--json",
      "number,url,state,isDraft,mergedAt,headRefName,baseRefName,headRefOid,title,mergeCommit",
    ],
    { cwd: root },
  );
  const prs = JSON.parse(json);
  if (!Array.isArray(prs)) fail("GitHub returned an invalid PR list");
  return prs;
}

function validatePreparedCommit(root, version) {
  const subject = `chore: release v${version}`;
  const body = run("git", ["log", "-1", "--format=%B", "HEAD"], {
    cwd: root,
  });
  if (body !== `${subject}\n\n${RELEASE_COMMIT_BODY}`) {
    fail("existing release commit has unexpected subject or body");
  }
  const changed = run(
    "git",
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
    { cwd: root },
  );
  assertReleaseFileSet(changed, "release commit changed unexpected files");
}

async function validatePreparedFiles(root, version) {
  await checkVersions({ root, expected: version });
  run(
    "cargo",
    [
      "metadata",
      "--locked",
      "--no-deps",
      "--format-version",
      "1",
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ],
    { cwd: root },
  );
  run("pnpm", ["test:release-scripts"], { cwd: root });
}

async function prepare(version, notesPath) {
  parseSemver(version, "release version");
  const root = repoRoot();
  const read = fileReader(root);
  const config = await releaseConfig(read);
  validateMinimumPublicVersion(version, config);
  const branch = `release/v${version}`;
  const subject = `chore: release v${version}`;
  assertClean(root);
  run("gh", ["auth", "status", "--hostname", "github.com"], { cwd: root });
  fetchReleaseState(root);
  const notes = notesPath
    ? (await readFile(resolve(notesPath), "utf8")).trim()
    : await generateReviewedNotes(root, version, await read("CHANGELOG.md"));
  if (!notes) fail("release notes file must contain reviewed Markdown");
  if (notes.includes("\0")) fail("release notes file contains a NUL byte");

  const remoteBranchOutput = commandResult(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { cwd: root },
  );
  if (remoteBranchOutput.status !== 0) {
    fail("failed to inspect the remote release branch");
  }
  const remoteBranchExists = Boolean(remoteBranchOutput.stdout.trim());
  const localBranchExists = refExists(root, `refs/heads/${branch}`);
  if (remoteBranchExists) {
    run(
      "git",
      [
        "fetch",
        "--no-tags",
        "origin",
        `refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      { cwd: root },
    );
  }

  const currentBranch = run("git", ["branch", "--show-current"], { cwd: root });
  if (currentBranch !== branch) {
    if (localBranchExists) {
      if (
        remoteBranchExists &&
        run("git", ["rev-parse", `refs/heads/${branch}`], { cwd: root }) !==
          run("git", ["rev-parse", `refs/remotes/origin/${branch}`], {
            cwd: root,
          })
      ) {
        fail("local and remote release branches disagree");
      }
      run("git", ["switch", branch], { cwd: root, visible: true });
    } else if (remoteBranchExists) {
      run("git", ["switch", "--track", "-c", branch, `origin/${branch}`], {
        cwd: root,
        visible: true,
      });
    } else {
      const head = run("git", ["rev-parse", "HEAD"], { cwd: root });
      const main = run("git", ["rev-parse", "refs/remotes/origin/main"], {
        cwd: root,
      });
      if (head !== main) {
        fail("release preparation must start from up-to-date origin/main");
      }
      run("git", ["switch", "-c", branch], { cwd: root, visible: true });
    }
  }
  assertClean(root);

  const commitCount = Number(
    run("git", ["rev-list", "--count", "refs/remotes/origin/main..HEAD"], {
      cwd: root,
    }),
  );
  if (commitCount === 0) {
    const currentVersion = await checkVersions({ root });
    if (compareSemver(version, currentVersion) <= 0) {
      fail(`release version ${version} must be newer than ${currentVersion}`);
    }
    const date =
      process.env.BERD_RELEASE_DATE || new Date().toISOString().slice(0, 10);
    let originals;
    try {
      originals = await writeReleaseFiles(
        root,
        version,
        notes,
        date,
        config.repository,
      );
      await validatePreparedFiles(root, version);
      run("git", ["add", "--", ...RELEASE_FILES], { cwd: root });
      const staged = run(
        "git",
        ["diff", "--cached", "--name-only", "--diff-filter=ACMRT"],
        { cwd: root },
      );
      assertReleaseFileSet(
        staged,
        "release preparation staged unexpected files",
      );
      run("git", ["commit", "-m", subject, "-m", RELEASE_COMMIT_BODY], {
        cwd: root,
        visible: true,
      });
      originals = undefined;
    } catch (error) {
      if (originals) await restoreReleaseFiles(root, originals);
      throw error;
    }
  } else if (commitCount === 1) {
    const parent = run("git", ["rev-parse", "HEAD^"], { cwd: root });
    if (
      !succeeds(
        "git",
        ["merge-base", "--is-ancestor", parent, "refs/remotes/origin/main"],
        { cwd: root },
      )
    ) {
      fail("existing release commit is not based on main");
    }
    validatePreparedCommit(root, version);
    await checkVersions({ root, expected: version });
  } else {
    fail("release branch must contain exactly one release commit");
  }

  const head = run("git", ["rev-parse", "HEAD"], { cwd: root });
  if (remoteBranchExists) {
    const remoteHead = run(
      "git",
      ["rev-parse", `refs/remotes/origin/${branch}`],
      { cwd: root },
    );
    if (remoteHead !== head)
      fail("remote release branch has conflicting commits");
  } else {
    run("git", ["push", "--set-upstream", "origin", `refs/heads/${branch}`], {
      cwd: root,
      visible: true,
    });
  }

  const prs = releasePrs(root, config.repository, branch);
  if (prs.length > 1) fail(`multiple PRs exist for ${branch}`);
  let url;
  if (prs.length === 1) {
    const pr = prs[0];
    if (
      pr.state !== "OPEN" ||
      pr.mergedAt ||
      pr.isDraft ||
      pr.baseRefName !== "main" ||
      pr.headRefName !== branch ||
      pr.headRefOid !== head ||
      pr.title !== subject
    ) {
      fail(`existing PR #${pr.number} conflicts with ${branch}`);
    }
    url = pr.url;
  } else {
    const body = `## Summary\n\n- synchronize Berd, berdctl, and tauri-plugin-berdctl at ${version}\n- add the reviewed v${version} changelog entry\n\n### Related issue\n\nN/A\n\n### Testing\n\n- \`just release-version-check ${version}\`\n- \`just release-validate ${version}\`\n`;
    const dir = await mkdtemp(join(tmpdir(), "berd-release-pr-"));
    const bodyPath = join(dir, "body.md");
    try {
      await writeFile(bodyPath, body);
      url = run(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          config.repository,
          "--base",
          "main",
          "--head",
          branch,
          "--title",
          subject,
          "--body-file",
          bodyPath,
        ],
        { cwd: root },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  console.log(`${url}\nstop here for human review and squash merge`);
}

async function publish(version) {
  parseSemver(version, "release version");
  const root = repoRoot();
  const read = fileReader(root);
  const config = await releaseConfig(read);
  validateMinimumPublicVersion(version, config);
  const branch = `release/v${version}`;
  const tag = `v${version}`;
  const subject = `chore: release v${version}`;
  assertClean(root);
  run("gh", ["auth", "status", "--hostname", "github.com"], { cwd: root });
  fetchReleaseState(root);

  const prs = releasePrs(root, config.repository, branch);
  if (prs.length !== 1) fail(`expected exactly one PR for ${branch}`);
  const pr = prs[0];
  if (
    !pr.mergedAt ||
    pr.state !== "MERGED" ||
    pr.baseRefName !== "main" ||
    pr.headRefName !== branch ||
    pr.title !== subject
  ) {
    fail(`PR #${pr.number} is not the merged ${subject} PR`);
  }
  const mergeSha = pr.mergeCommit?.oid;
  if (!/^[0-9a-f]{40}$/.test(mergeSha ?? "")) {
    fail(`PR #${pr.number} has no squash-merge commit SHA`);
  }
  if (
    !succeeds(
      "git",
      ["merge-base", "--is-ancestor", mergeSha, "refs/remotes/origin/main"],
      { cwd: root },
    )
  ) {
    fail(`merge commit ${mergeSha} is not reachable from origin/main`);
  }
  const mergeTitle = run("git", ["show", "-s", "--format=%s", mergeSha], {
    cwd: root,
  });
  const githubMergeTitle = `${subject} (#${pr.number})`;
  if (mergeTitle !== subject && mergeTitle !== githubMergeTitle) {
    fail(`merge commit title does not match PR #${pr.number}`);
  }
  await checkVersions({ root, expected: version, ref: mergeSha });
  const sourceConfig = await releaseConfig(gitReader(root, mergeSha));
  validateMinimumPublicVersion(version, sourceConfig);

  const remoteTarget = remoteTagTarget(root, tag);
  if (remoteTarget) {
    if (remoteTarget !== mergeSha) {
      fail(`remote tag ${tag} targets ${remoteTarget}, expected ${mergeSha}`);
    }
    if (refExists(root, `refs/tags/${tag}`)) {
      validateLocalTag(root, tag, mergeSha);
    }
  } else {
    if (refExists(root, `refs/tags/${tag}`)) {
      validateLocalTag(root, tag, mergeSha);
    } else {
      run(
        "git",
        ["tag", "--annotate", "--no-sign", tag, mergeSha, "--message", subject],
        { cwd: root },
      );
      validateLocalTag(root, tag, mergeSha);
    }
    run("git", ["push", "origin", `refs/tags/${tag}`], {
      cwd: root,
      visible: true,
    });
  }
  console.log(
    `https://github.com/${config.repository}/actions/workflows/release.yml\nwait for all platform assets, then approve the release environment promotion`,
  );
}

async function notes(version, changelogPath) {
  parseSemver(version, "release version");
  const root = repoRoot();
  const read = fileReader(root);
  const config = await releaseConfig(read);
  const content = await readFile(
    changelogPath || join(root, "CHANGELOG.md"),
    "utf8",
  );
  process.stdout.write(
    `${changelogEntry(content, version, config.repository).body}\n`,
  );
}

function usage() {
  console.error(`Usage:
  release.mjs version-check [expected-version] [--ref <commit>]
  release.mjs changelog-notes <version> [changelog-path]
  release.mjs prepare <version> [notes-file]
  release.mjs publish <version>`);
  process.exit(2);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "version-check") {
    if (args[0] === "") args.shift();
    let expected;
    let ref;
    if (args[0] && args[0] !== "--ref") expected = args.shift();
    if (args[0] === "--ref" && args[1] && args.length === 2) {
      ref = args[1];
      args.splice(0);
    }
    if (args.length) usage();
    const actual = await checkVersions({ expected, ref });
    console.log(`release versions are in lockstep at ${actual}`);
    return;
  }
  if (command === "changelog-notes" && args.length >= 1 && args.length <= 2) {
    await notes(args[0], args[1]);
    return;
  }
  if (command === "prepare" && args.length >= 1 && args.length <= 2) {
    await prepare(args[0], args[1]);
    return;
  }
  if (command === "publish" && args.length === 1) {
    await publish(args[0]);
    return;
  }
  usage();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
