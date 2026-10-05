import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("dev installation restores the exact released bundle link and refuses unrelated commands", () => {
  const root = mkdtempSync(join(tmpdir(), "berd-call-install-test-"));
  try {
    const bin = join(root, "bin");
    const libexec = join(root, "libexec");
    mkdirSync(bin);
    const command = join(bin, "berd-call");
    const released = join(
      root,
      "Custom Location",
      "Berd.app",
      "Contents",
      "MacOS",
      "berd-call",
    );
    mkdirSync(join(root, "Custom Location", "Berd.app", "Contents", "MacOS"), {
      recursive: true,
    });
    symlinkSync("/usr/bin/true", released);
    symlinkSync(released, command);
    const run = (...args) =>
      spawnSync("bash", ["scripts/install-berd-call-dev.sh", ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          BERD_CALL_DEV_BINDIR: bin,
          BERD_CALL_DEV_LIBEXECDIR: libexec,
        },
      });
    let result = run("install", "/usr/bin/true");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readlinkSync(command), join(libexec, "berd-call-dev"));
    result = run("install", "/usr/bin/true");
    assert.equal(result.status, 0, result.stderr);
    result = run("uninstall");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readlinkSync(command), released);
    rmSync(command);
    symlinkSync("/usr/bin/true", command);
    result = run("install", "/usr/bin/true");
    assert.notEqual(result.status, 0);
    assert.equal(readlinkSync(command), "/usr/bin/true");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
