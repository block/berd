import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const validator = new URL("./validate-dco-signoff.mjs", import.meta.url)
  .pathname;

function run(
  message,
  author = { name: "Ada Lovelace", email: "ada@example.com" },
) {
  const repo = mkdtempSync(join(tmpdir(), "berd-dco-"));
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", author.name]);
  execFileSync("git", ["-C", repo, "config", "user.email", author.email]);
  const messagePath = join(repo, "COMMIT_EDITMSG");
  writeFileSync(messagePath, message);
  return spawnSync("node", [validator, messagePath], {
    cwd: repo,
    encoding: "utf8",
  });
}

test("accepts an author-matching sign-off", () => {
  const result = run(
    "Subject\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n",
  );
  assert.equal(result.status, 0, result.stderr);
});

test("rejects a missing sign-off with remediation", () => {
  const result = run("Subject\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Signed-off-by: Ada Lovelace <ada@example\.com>/);
  assert.match(result.stderr, /git commit --signoff/);
});

test("rejects a sign-off from someone other than the author", () => {
  const result = run(
    "Subject\n\nSigned-off-by: Grace Hopper <grace@example.com>\n",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Signed-off-by: Ada Lovelace <ada@example\.com>/);
});

test("honors the effective author identity", () => {
  const result = run(
    "Subject\n\nSigned-off-by: Zoë Agent <zoe@example.com>\n",
    { name: "Zoë Agent", email: "zoe@example.com" },
  );
  assert.equal(result.status, 0, result.stderr);
});
