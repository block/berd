#!/usr/bin/env node
// Exercise signed replacement and the call lock using an isolated macOS bundle.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [source, consent] = process.argv.slice(2);
if (
  process.platform !== "darwin" ||
  !source ||
  consent !== "--trust-localhost"
) {
  throw new Error(
    "Usage (macOS): node scripts/test-bundled-updater.mjs /absolute/isolated/Berd.app --trust-localhost. Temporarily trusts a generated localhost certificate and removes it on exit.",
  );
}
const execute = (bin, args, env = {}) =>
  execFileSync(bin, args, {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const identifier = execute("/usr/libexec/PlistBuddy", [
  "-c",
  "Print CFBundleIdentifier",
  path.join(source, "Contents/Info.plist"),
]);
if (
  !path.isAbsolute(source) ||
  !/^xyz\.block\.berd\.e2e\.[a-zA-Z0-9-]+$/.test(identifier)
) {
  throw new Error(
    "Source must be an absolute path to an isolated E2E bundle, never the production app",
  );
}
const runId = identifier.slice("xyz.block.berd.e2e.".length);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "berd-updater-test."));
const runRoot = path.join(root, runId);
fs.mkdirSync(runRoot);
const applications = path.join(os.homedir(), "Applications");
fs.mkdirSync(applications, { recursive: true });
const parent = fs.mkdtempSync(path.join(applications, "Berd-updater-test."));
const app = path.join(parent, "Berd.app");
const targetParent = path.join(root, "target");
fs.mkdirSync(targetParent);
const target = path.join(targetParent, "Berd.app");
const version = "99.0.0";
const platform = process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
const archive = path.join(root, `Berd_${version}_${platform}.app.tar.gz`);
const cert = path.join(root, "cert.pem");
let server,
  lock,
  pid,
  trusted = false,
  fingerprint;
const delay = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = true;
  });
}
async function until(predicate, label) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Rehearsal interrupted");
    if (predicate()) return;
    await delay();
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(root, "key.pem"),
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  fingerprint = execute("openssl", [
    "x509",
    "-in",
    cert,
    "-noout",
    "-fingerprint",
    "-sha1",
  ])
    .split("=")[1]
    .replaceAll(":", "");
  execute("security", [
    "add-trusted-cert",
    "-r",
    "trustRoot",
    "-p",
    "ssl",
    "-k",
    path.join(os.homedir(), "Library/Keychains/login.keychain-db"),
    cert,
  ]);
  trusted = true;
  const signingKey = path.join(root, "updater.key");
  execute("pnpm", [
    "exec",
    "tauri",
    "signer",
    "generate",
    "--ci",
    "-p",
    "",
    "-w",
    signingKey,
  ]);
  const pubkey = fs.readFileSync(`${signingKey}.pub`, "utf8").trim();
  execute("ditto", [source, app]);
  const compatibility = {
    storeContractVersion: 1,
    writesDataEpoch: 1,
    minReadableDataEpoch: 1,
    maxReadableDataEpoch: 1,
  };
  const endpoint = "https://localhost:14443/latest.json";
  fs.writeFileSync(
    path.join(app, "Contents/Resources/release-channels.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultChannel: "main",
      runningBuild: { channelId: "main", compatibility },
      channels: [
        { id: "main", label: "Main", endpoint, pubkey, compatibility },
      ],
    }),
  );
  execute("codesign", ["--force", "--deep", "--sign", "-", app]);
  execute("ditto", [app, target]);
  execute("/usr/libexec/PlistBuddy", [
    "-c",
    `Set CFBundleShortVersionString ${version}`,
    path.join(target, "Contents/Info.plist"),
  ]);
  fs.writeFileSync(
    path.join(target, "Contents/Resources/updater-test-proof.txt"),
    "signed replacement payload\n",
  );
  execute("codesign", ["--force", "--deep", "--sign", "-", target]);
  execute("tar", ["-C", targetParent, "-czf", archive, "Berd.app"], {
    COPYFILE_DISABLE: "1",
  });
  const signing = {
    TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(signingKey, "utf8"),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
    BERD_STORE_CONTRACT_VERSION: "1",
    BERD_WRITES_DATA_EPOCH: "1",
    BERD_MIN_READABLE_DATA_EPOCH: "1",
    BERD_MAX_READABLE_DATA_EPOCH: "1",
  };
  execute("pnpm", ["exec", "tauri", "signer", "sign", archive], signing);
  const digest = execute("shasum", ["-a", "256", archive]).split(" ")[0];
  const descriptorSignature = execute(
    "bash",
    [
      "scripts/release/sign-compatibility-descriptor.sh",
      version,
      "main",
      digest,
    ],
    signing,
  );
  const manifest = execute(
    "bash",
    [
      "scripts/release/generate-latest-json.sh",
      version,
      "isolated signed replacement",
      platform,
      `${archive}.sig`,
      `https://localhost:14443/${path.basename(archive)}`,
    ],
    {
      ...signing,
      BERD_RELEASE_CHANNEL_ID: "main",
      BERD_ARTIFACT_SHA256: digest,
      BERD_COMPATIBILITY_SIGNATURE: descriptorSignature,
    },
  );
  fs.writeFileSync(path.join(root, "latest.json"), manifest);
  let manifestRequests = 0,
    archiveRequests = 0,
    archiveCompleted = false;
  server = https.createServer(
    {
      key: fs.readFileSync(path.join(root, "key.pem")),
      cert: fs.readFileSync(cert),
    },
    (request, response) => {
      if (request.url === "/latest.json") {
        manifestRequests++;
        response.setHeader("Content-Type", "application/json");
        response.end(manifest);
      } else if (request.url === `/${path.basename(archive)}`) {
        archiveRequests++;
        response.once("finish", () => {
          archiveCompleted = true;
        });
        fs.createReadStream(archive).pipe(response);
      } else {
        response.statusCode = 404;
        response.end();
      }
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(14443, "127.0.0.1", resolve);
  });
  const lockPath = path.join(
    os.homedir(),
    "Library/Caches/Berd/berd-call-app-update.lock",
  );
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  lock = spawn(
    "/usr/bin/python3",
    [
      "-u",
      "-c",
      "import fcntl,sys; f=open(sys.argv[1],'a+'); fcntl.flock(f,fcntl.LOCK_SH); print('LOCKED',flush=True); sys.stdin.read()",
      lockPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await new Promise((resolve, reject) => {
    lock.stdout.once("data", resolve);
    lock.once("error", reject);
    lock.once("exit", () =>
      reject(new Error("Lock holder exited before readiness")),
    );
  });
  execute("open", [
    "-g",
    "-n",
    "-a",
    app,
    "--env",
    "BERD_E2E_MODE=1",
    "--env",
    `BERD_E2E_RUN_ID=${runId}`,
    "--env",
    `BERD_E2E_RUN_ROOT=${runRoot}`,
    "--env",
    `APP_TEST_DRIVER_TOKEN=${randomBytes(24).toString("hex")}`,
    "--stdout",
    path.join(runRoot, "stdout.log"),
    "--stderr",
    path.join(runRoot, "stderr.log"),
    "berd://update-check",
  ]);
  await until(
    () => fs.existsSync(path.join(runRoot, "app-test-driver.json")),
    "driver readiness",
  );
  pid = JSON.parse(
    fs.readFileSync(path.join(runRoot, "app-test-driver.json"), "utf8"),
  ).pid;
  await until(() => archiveCompleted, "signed archive download");
  const proof = path.join(app, "Contents/Resources/updater-test-proof.txt");
  await delay(2000);
  if (fs.existsSync(proof))
    throw new Error("Bundle replaced while call-equivalent lock was held");
  console.log("SIGNED_ARCHIVE_DOWNLOADED_WITH_INSTALL_BLOCKED");
  lock.stdin.end();
  await until(
    () => fs.existsSync(proof),
    "bundle replacement after lock release",
  );
  execute("codesign", ["--verify", "--deep", "--strict", app]);
  const hash = (bundle) =>
    execute("shasum", [
      "-a",
      "256",
      path.join(bundle, "Contents/MacOS/berd-call"),
    ]).split(" ")[0];
  if (hash(app) !== hash(target))
    throw new Error("Bundled CLI payload mismatch");
  console.log(
    `SIGNED_REPLACEMENT_VERIFIED manifests=${manifestRequests} archives=${archiveRequests} evidence=${root} app=${app}`,
  );
} catch (error) {
  console.log(`REHEARSAL_FAILED ${error.message} evidence=${root}`);
  process.exitCode = 1;
} finally {
  if (lock) lock.stdin.end();
  if (pid) {
    // The isolated app may leave its backend child after SIGTERM.
    let children = [];
    try {
      children = execute("pgrep", ["-P", String(pid)])
        .split("\n")
        .filter(Boolean);
    } catch {}
    for (const child of children) {
      try {
        process.kill(Number(child), "SIGTERM");
      } catch {}
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (server) server.close();
  if (trusted) {
    execute("security", ["remove-trusted-cert", cert]);
    execute("security", [
      "delete-certificate",
      "-Z",
      fingerprint,
      path.join(os.homedir(), "Library/Keychains/login.keychain-db"),
    ]);
    console.log("TEST_CERTIFICATE_TRUST_REMOVED");
  }
}
