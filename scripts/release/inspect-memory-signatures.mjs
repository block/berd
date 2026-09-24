#!/usr/bin/env node
// Read-only inspection of quiescent, already extracted release artifacts.
// No extraction, execution, signing, Keychain access, or temporary files.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const tools = {
  codesign: "/usr/bin/codesign",
  lipo: "/usr/bin/lipo",
  plutil: "/usr/bin/plutil",
};
const fields = [
  "root",
  "artifact",
  "app",
  "team",
  "main-id",
  "sidecar-id",
  "artifact-sha256",
  "main-sha256",
  "sidecar-sha256",
  "source-sha",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(message);
};

function systemRun(command, args, input) {
  return spawnSync(command, args, {
    input,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    shell: false,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
  });
}

function invoke(run, tool, args, input) {
  let result;
  try {
    result = run(tools[tool], args, input);
  } catch {
    fail(`${tool} inspection failed`);
  }
  if (result?.status !== 0 || result.error || result.signal)
    fail(`${tool} inspection failed`);
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

async function checkedPath(root, path, kind) {
  if (!isAbsolute(path)) fail("Inspection paths must be absolute");
  const rel = relative(root, resolve(path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail("Inspection path is outside the supplied root");
  }
  let current = root;
  const parts = rel.split(sep);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      fail("Symlinks are not accepted in inspection paths");
    const directory = index < parts.length - 1 || kind === "directory";
    if (directory ? !stat.isDirectory() : !stat.isFile())
      fail("Unexpected inspection path type");
  }
  return current;
}

async function digest(path) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) fail("Expected a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(128 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      fail("Inspection input changed");
    }
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

function single(metadata, key) {
  const values = metadata
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${key}=`));
  if (values.length !== 1) fail("Missing or ambiguous signature metadata");
  return values[0].slice(key.length + 1).trim();
}

function inspectExecutable(run, path, identifier, team) {
  // Explicit expected identity AND Apple trust anchor; team equality is insufficient.
  const requirement = `=anchor apple generic and identifier "${identifier}" and certificate leaf[subject.OU] = "${team}"`;
  invoke(run, "codesign", [
    "--verify",
    "--strict",
    "--all-architectures",
    "-R",
    requirement,
    path,
  ]);
  const display = invoke(run, "codesign", ["--display", "--verbose=4", path]);
  const metadata = `${display.stdout}\n${display.stderr}`;
  if (/Signature=adhoc|flags=.*\badhoc\b/i.test(metadata))
    fail("Ad-hoc signatures are not accepted");
  if (
    single(metadata, "Identifier") !== identifier ||
    single(metadata, "TeamIdentifier") !== team
  ) {
    fail("Signature identity does not match expectations");
  }
  if (
    !/^\d+$/.test(single(metadata, "Signature size")) ||
    Number(single(metadata, "Signature size")) < 1
  ) {
    fail("Missing signing identity");
  }
  const authorities = metadata
    .split(/\r?\n/)
    .filter((line) => /^Authority=\S/.test(line));
  if (!authorities.length) fail("Missing signing authority");
  const architecture = invoke(run, "lipo", ["-archs", path]).stdout.trim();
  if (architecture !== "arm64") fail("Expected exactly arm64 architecture");
  const requirements = invoke(run, "codesign", ["--display", "-r-", path]);
  const designated = `${requirements.stdout}\n${requirements.stderr}`
    .split(/\r?\n/)
    .filter((line) => line.startsWith("designated => "));
  if (designated.length !== 1 || !designated[0].slice(14).trim())
    fail("Missing designated requirement");
  const entitlements = invoke(run, "codesign", [
    "--display",
    "--entitlements",
    "-",
    "--xml",
    path,
  ]).stdout;
  let parsed = {};
  if (entitlements.trim()) {
    const json = invoke(
      run,
      "plutil",
      ["-convert", "json", "-o", "-", "-"],
      entitlements,
    ).stdout;
    try {
      parsed = JSON.parse(json);
    } catch {
      fail("Invalid entitlements");
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
      fail("Invalid entitlements");
  }
  // Do not emit arbitrary strings from requirements, certificate names, or entitlements.
  const booleanEntitlements = {};
  for (const key of [
    "com.apple.security.app-sandbox",
    "com.apple.security.get-task-allow",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.allow-dyld-environment-variables",
  ]) {
    if (Object.hasOwn(parsed, key)) {
      if (typeof parsed[key] !== "boolean")
        fail("Invalid security entitlement type");
      booleanEntitlements[key] = parsed[key];
    }
  }
  const groups = {};
  for (const key of [
    "keychain-access-groups",
    "com.apple.security.application-groups",
  ]) {
    if (Object.hasOwn(parsed, key)) {
      if (
        !Array.isArray(parsed[key]) ||
        !parsed[key].every((value) => typeof value === "string")
      ) {
        fail("Invalid group entitlement type");
      }
      groups[key] = {
        count: parsed[key].length,
        sha256: sha256(JSON.stringify(parsed[key])),
      };
    }
  }
  return {
    identifier,
    teamIdentifier: team,
    architecture,
    appleAnchoredExpectedIdentityVerified: true,
    signatureSize: Number(single(metadata, "Signature size")),
    signingAuthorityCount: authorities.length,
    designatedRequirementSha256: sha256(designated[0]),
    entitlements: {
      present: Boolean(entitlements.trim()),
      sha256: sha256(entitlements),
      entryCount: Object.keys(parsed).length,
      securityBooleans: booleanEntitlements,
      groups,
    },
  };
}

/** Tool injection is for unit tests only; CLI always uses absolute system tools. */
export async function inspectMemorySignatures(
  options,
  { run = systemRun, platform = process.platform } = {},
) {
  try {
    if (platform !== "darwin") fail("Signature inspection requires macOS");
    for (const field of fields)
      if (typeof options[field] !== "string" || !options[field])
        fail("Missing required inspection input");
    if (!/^[A-Z0-9]{10}$/.test(options.team))
      fail("Invalid expected team identifier");
    for (const field of ["main-id", "sidecar-id"]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(options[field]))
        fail("Invalid expected executable identifier");
    }
    for (const field of ["artifact-sha256", "main-sha256", "sidecar-sha256"]) {
      if (!/^[a-f0-9]{64}$/.test(options[field]))
        fail("Invalid expected SHA-256 digest");
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options["source-sha"]))
      fail("Invalid source SHA label");
    if (!isAbsolute(options.root) || !(await lstat(options.root)).isDirectory())
      fail("Invalid inspection root");
    const root = await realpath(options.root);
    // Canonical parents (e.g. macOS /tmp) are permitted only outside the root.
    const canonicalInput = (path) => {
      if (!isAbsolute(path)) fail("Inspection paths must be absolute");
      const rel = relative(resolve(options.root), resolve(path));
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        fail("Inspection path is outside the supplied root");
      return join(root, rel);
    };
    const artifact = await checkedPath(
      root,
      canonicalInput(options.artifact),
      "file",
    );
    const app = await checkedPath(
      root,
      canonicalInput(options.app),
      "directory",
    );
    const plist = await checkedPath(
      app,
      join(app, "Contents/Info.plist"),
      "file",
    );
    const plistDigest = await digest(plist);
    const name = invoke(run, "plutil", [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      plist,
    ]).stdout.trim();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
      name === ".." ||
      name === "berd-memory-mcp"
    )
      fail("Invalid main executable name");
    const main = await checkedPath(
      app,
      join(app, "Contents/MacOS", name),
      "file",
    );
    const sidecar = await checkedPath(
      app,
      join(app, "Contents/MacOS/berd-memory-mcp"),
      "file",
    );
    const inputs = [
      [artifact, "artifact-sha256"],
      [main, "main-sha256"],
      [sidecar, "sidecar-sha256"],
    ];
    for (const [path, expected] of inputs)
      if ((await digest(path)) !== options[expected])
        fail("Artifact or executable digest mismatch");
    invoke(run, "codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--all-architectures",
      app,
    ]);
    const mainEvidence = inspectExecutable(
      run,
      main,
      options["main-id"],
      options.team,
    );
    const sidecarEvidence = inspectExecutable(
      run,
      sidecar,
      options["sidecar-id"],
      options.team,
    );
    for (const [path, expected] of [...inputs, [plist, null]]) {
      await checkedPath(root, path, "file");
      if ((await digest(path)) !== (expected ? options[expected] : plistDigest))
        fail("Inspection input changed");
    }
    return {
      schemaVersion: 1,
      status: "metadata-inspection-passed",
      scope:
        "Metadata inspection is NOT key authorization or native acceptance. No binaries were executed and no Keychain access was requested.",
      provenance: {
        sourceSha: options["source-sha"],
        meaning:
          "User-supplied provenance label, not cryptographic proof of source or build.",
      },
      limitations:
        "Requires quiescent inputs; not an atomic snapshot against hostile concurrent mutation. Artifact and extracted bundle are inspected independently; their relationship is not proven. No notarization, upgrade continuity, or Keychain interoperability claim.",
      artifact: { sha256: options["artifact-sha256"] },
      main: { ...mainEvidence, sha256: options["main-sha256"] },
      sidecar: { ...sidecarEvidence, sha256: options["sidecar-sha256"] },
    };
  } catch (error) {
    // Filesystem/tool diagnostics can contain personal paths or arbitrary secrets.
    if (error?.code || !(error instanceof Error))
      throw new Error("Inspection failed; check inputs and file accessibility");
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(
      `Usage: node inspect-memory-signatures.mjs ${fields.map((field) => `--${field} <value>`).join(" ")}\nAll paths must be absolute and inside --root. Read-only macOS metadata inspection; no native acceptance claim.\n`,
    );
    return;
  }
  try {
    const options = {};
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index].slice(2);
      if (
        !argv[index].startsWith("--") ||
        !fields.includes(key) ||
        Object.hasOwn(options, key) ||
        !argv[index + 1]
      )
        fail("Invalid inspection arguments");
      options[key] = argv[index + 1];
    }
    process.stdout.write(
      `${JSON.stringify(await inspectMemorySignatures(options), null, 2)}\n`,
    );
  } catch {
    process.stderr.write(
      '{"status":"failed","message":"Signature inspection failed; verify expected inputs and artifact integrity."}\n',
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
