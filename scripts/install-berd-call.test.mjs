import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";

const installer = resolve("scripts/install-berd-call.sh");
const mac = process.platform === "darwin";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "berd standalone test "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const commands = join(dir, "commands"),
    assets = join(dir, "assets"),
    bin = join(dir, "bin with spaces"),
    home = join(dir, "home");
  for (const path of [commands, assets, home]) mkdirSync(path);
  const command = (name, source) =>
    writeFileSync(join(commands, name), `#!/bin/bash\nset -eu\n${source}\n`, {
      mode: 0o755,
    });
  command(
    "uname",
    'if [[ "$1" == -s ]]; then echo "${TEST_OS:-Darwin}"; else echo arm64; fi',
  );
  command(
    "codesign",
    '[[ "${BAD_SIGNATURE:-}" != 1 ]] || exit 1\n[[ "$1" == --display || "$*" == *"leaf[subject.OU] = EYF346PHUG"* ]] || exit 1\nif [[ "$1" == --display ]]; then echo Identifier=berd-call; for i in {1..2000}; do echo metadata; done; fi',
  );
  command(
    "curl",
    `if [[ "$*" == *url_effective* ]]; then echo "https://github.com/block/berd/releases/tag/$(cat "$ASSETS/staged")"; exit; fi
if [[ "$*" == */berd-desktop-latest/latest.json* ]]; then printf '{"version":"%s"}\n' "$(sed 's/^v//' "$ASSETS/latest")"; exit; fi
url=''; output=''
while [[ $# -gt 0 ]]; do case "$1" in https:*) url="$1"; shift;; -o) output="$2"; shift 2;; *) shift;; esac; done
cp "$ASSETS/$(basename "$url")" "$output"`,
  );
  command(
    "gh",
    `if [[ "$1 $2" == 'release view' ]]; then cat "$ASSETS/latest"; exit; fi
asset=''; dest=''
while [[ $# -gt 0 ]]; do case "$1" in --pattern) asset="$2"; shift 2;; --dir) dest="$2"; shift 2;; *) shift;; esac; done
cp "$ASSETS/$asset" "$dest/$asset"`,
  );
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${commands}:${process.env.PATH}`,
    ASSETS: assets,
  };
  const run = (...args) =>
    spawnSync("/bin/bash", [installer, "--bin-dir", bin, ...args], {
      env,
      encoding: "utf8",
    });
  const release = (version, kind = "regular") => {
    const stage = join(dir, `stage-${version}`);
    mkdirSync(stage);
    if (kind === "symlink")
      symlinkSync("/usr/bin/true", join(stage, "berd-call"));
    else
      writeFileSync(
        join(stage, "berd-call"),
        `#!/bin/bash\necho ${version}\n`,
        { mode: 0o755 },
      );
    const archive = `berd-call_${version}_darwin-aarch64.tar.gz`;
    assert.equal(
      spawnSync(
        "tar",
        ["-czf", join(assets, archive), "-C", stage, "berd-call"],
        { env: { ...process.env, COPYFILE_DISABLE: "1" } },
      ).status,
      0,
    );
    writeFileSync(
      join(assets, `${archive}.sha256`),
      `${createHash("sha256")
        .update(readFileSync(join(assets, archive)))
        .digest("hex")}  ${archive}\n`,
    );
    writeFileSync(join(assets, "latest"), `v${version}\n`);
  };
  const version = () =>
    readFileSync(join(bin, ".berd-call/installed"), "utf8").trim();
  return { dir, bin, assets, env, run, release, version };
}
test("installs, updates in place, refuses rollback and retains channel", {
  skip: !mac,
}, (t) => {
  const f = fixture(t);
  f.release("0.6.5");
  let r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.version(), "0.6.5");
  assert.equal(
    spawnSync(join(f.bin, "berd-call"), [], { encoding: "utf8" }).stdout.trim(),
    "0.6.5",
  );
  f.release("0.6.6");
  r = spawnSync("/bin/bash", [join(f.bin, ".berd-call/update"), "--run"], {
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.version(), "0.6.6");
  writeFileSync(join(f.assets, "latest"), "v0.6.5\n");
  r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.version(), "0.6.6");
  r = f.run("--channel", "internal");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /different channel/);
});
test("installs the promoted release, not GitHub's latest staged release", {
  skip: !mac,
}, (t) => {
  const f = fixture(t);
  f.release("0.6.6");
  f.release("0.6.5");
  writeFileSync(join(f.assets, "staged"), "v0.6.6\n");
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.version(), "0.6.5");
});
test("checksum, signature and missing releases preserve the installed executable", {
  skip: !mac,
}, (t) => {
  const f = fixture(t);
  f.release("0.6.5");
  assert.equal(f.run().status, 0);
  const before = readFileSync(join(f.bin, "berd-call"));
  f.release("0.6.6");
  writeFileSync(
    join(f.assets, "berd-call_0.6.6_darwin-aarch64.tar.gz.sha256"),
    `${"0".repeat(64)}  berd-call_0.6.6_darwin-aarch64.tar.gz\n`,
  );
  let r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /checksum mismatch/);
  assert.deepEqual(readFileSync(join(f.bin, "berd-call")), before);
  f.env.BAD_SIGNATURE = "1";
  f.release("0.6.7");
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(readFileSync(join(f.bin, "berd-call")), before);
  delete f.env.BAD_SIGNATURE;
  writeFileSync(join(f.assets, "latest"), "v0.6.8\n");
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(readFileSync(join(f.bin, "berd-call")), before);
});
test("rejects symlinks in archives and preserves existing app links", {
  skip: !mac,
}, (t) => {
  const f = fixture(t);
  f.release("0.6.5", "symlink");
  let r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /regular executable/);
  assert.equal(existsSync(join(f.bin, "berd-call")), false);
  symlinkSync("/usr/bin/true", join(f.bin, "berd-call"));
  r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /symlink/);
});
test("supports authenticated internal downloads and rejects unsupported platforms", {
  skip: !mac,
}, (t) => {
  const f = fixture(t);
  f.release("0.5.36");
  let r = f.run("--channel", "internal");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.version(), "0.5.36");
  f.env.TEST_OS = "Linux";
  r = f.run("--channel", "internal");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Apple Silicon/);
});
test("downloaded update waits for all active call locks before replacing", {
  skip: !mac,
}, async (t) => {
  const f = fixture(t);
  f.release("0.6.5");
  assert.equal(f.run().status, 0);
  f.release("0.6.6");
  const lock = join(
    f.env.HOME,
    "Library/Caches/Berd/berd-call-app-update.lock",
  );
  const holder = spawn(
    "/usr/bin/perl",
    [
      "-MFcntl=:flock",
      "-e",
      'open(my $f, ">>", $ARGV[0]) or die $!; flock($f,LOCK_SH) or die $!; print "locked\\n"; $|=1; <STDIN>;',
      lock,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => holder.kill());
  await new Promise((done, reject) => {
    holder.stdout.once("data", done);
    holder.once("error", reject);
  });
  const child = spawn(
    "/bin/bash",
    [join(f.bin, ".berd-call/update"), "--run"],
    { env: f.env, stdio: "pipe" },
  );
  t.after(() => child.kill());
  // The install subprocess announces itself by opening the exclusive lock.
  await new Promise((done, reject) => {
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(Error("update never reached install lock"));
      }
      const p = spawnSync("pgrep", ["-P", String(child.pid), "-f", "lockf"], {
        encoding: "utf8",
      });
      if (p.status === 0) {
        clearInterval(timer);
        done();
      }
    }, 20);
  });
  assert.equal(f.version(), "0.6.5");
  holder.stdin.end("\n");
  const status = await new Promise((done) => child.once("exit", done));
  assert.equal(status, 0);
  assert.equal(f.version(), "0.6.6");
});
