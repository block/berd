import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { inspectMemorySignatures } from "../inspect-memory-signatures.mjs";

const roots = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const ok = (stdout = "", stderr = "") => ({ status: 0, stdout, stderr });
const secret = "PRIVATE-DO-NOT-EMIT";
const inspector = fileURLToPath(
  new URL("../inspect-memory-signatures.mjs", import.meta.url),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "berd-memory-signatures-"));
  roots.push(root);
  const app = join(root, "Berd.app");
  const bin = join(app, "Contents/MacOS");
  await mkdir(bin, { recursive: true });
  const files = {
    artifact: join(root, "release.dmg"),
    main: join(bin, "Berd"),
    sidecar: join(bin, "berd-memory-mcp"),
    plist: join(app, "Contents/Info.plist"),
  };
  await writeFile(files.artifact, "synthetic artifact");
  await writeFile(files.main, "synthetic main; must never execute");
  await writeFile(files.sidecar, "synthetic sidecar; must never execute");
  await writeFile(
    files.plist,
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Berd</string><key>CFBundleIdentifier</key><string>com.example.berd</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
  );
  const options = {
    root,
    app,
    artifact: files.artifact,
    team: "ABCDE12345",
    "main-id": "com.example.berd",
    "sidecar-id": "com.example.berd.memory",
    "artifact-sha256": hash(await readFile(files.artifact)),
    "main-sha256": hash(await readFile(files.main)),
    "sidecar-sha256": hash(await readFile(files.sidecar)),
    "source-sha": "a".repeat(40),
  };
  return { options, files };
}

function stub(options, override = () => undefined) {
  const calls = [];
  const run = (command, args, input) => {
    calls.push({ command, args, input });
    const changed = override(command, args, input);
    if (changed !== undefined) return changed;
    const path = args.at(-1);
    if (command === "/usr/bin/plutil") {
      if (args[0] === "-extract") return ok("Berd\n");
      if (args[0] === "-convert")
        return ok(
          JSON.stringify({
            "com.apple.security.app-sandbox": false,
            custom: secret,
          }),
        );
    }
    if (command === "/usr/bin/lipo") return ok("arm64\n");
    if (command === "/usr/bin/codesign") {
      if (args.includes("--verify")) return ok();
      if (args.includes("--verbose=4")) {
        const id =
          basename(path) === "Berd"
            ? options["main-id"]
            : options["sidecar-id"];
        return ok(
          "",
          `Executable=${path}\nIdentifier=${id}\nTeamIdentifier=${options.team}\nSignature size=9000\nAuthority=Developer ID Application: ${secret}\nAuthority=Apple Root CA\n`,
        );
      }
      if (args.includes("-r-"))
        return ok(
          "",
          `Executable=${path}\ndesignated => identifier "${secret}" and anchor apple generic\n`,
        );
      if (args.includes("--entitlements"))
        return ok(
          `<plist><dict><key>custom</key><string>${secret}</string></dict></plist>`,
          `Executable=${path}`,
        );
    }
    throw new Error("Unexpected tool invocation");
  };
  return { run, calls };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("read-only memory signature acceptance inspection", () => {
  it("verifies bundle and both expected identities, hashes exact bytes, and emits sanitized limited evidence", async () => {
    const { options, files } = await fixture();
    const { run, calls } = stub(options);
    const result = await inspectMemorySignatures(options, {
      run,
      platform: "darwin",
    });
    expect(result.status).toBe("metadata-inspection-passed");
    expect(result.main.identifier).toBe(options["main-id"]);
    expect(result.sidecar.identifier).toBe(options["sidecar-id"]);
    expect(result.main.sha256).toBe(hash(await readFile(files.main)));
    expect(result.sidecar.sha256).toBe(hash(await readFile(files.sidecar)));
    expect(result.artifact.sha256).toBe(hash(await readFile(files.artifact)));
    expect(result.main.entitlements.securityBooleans).toEqual({
      "com.apple.security.app-sandbox": false,
    });
    expect(result.main.designatedRequirementSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.scope).toContain(
      "NOT key authorization or native acceptance",
    );
    expect(result.provenance.meaning).toContain("not cryptographic proof");
    expect(result.limitations).toContain("relationship is not proven");
    const output = JSON.stringify(result);
    expect(output).not.toContain(options.root);
    expect(output).not.toContain(secret);
    const verification = calls.filter(({ args }) => args.includes("--verify"));
    expect(verification).toHaveLength(3);
    expect(verification[0].args).toContain("--deep");
    for (const [index, id] of [
      [1, options["main-id"]],
      [2, options["sidecar-id"]],
    ]) {
      expect(verification[index].args).toContain(
        `=anchor apple generic and identifier "${id}" and certificate leaf[subject.OU] = "${options.team}"`,
      );
      expect(verification[index].args).toContain("--strict");
      expect(verification[index].args).toContain("--all-architectures");
    }
    expect(
      calls.every(({ command }) =>
        ["/usr/bin/codesign", "/usr/bin/lipo", "/usr/bin/plutil"].includes(
          command,
        ),
      ),
    ).toBe(true);
    expect(
      calls.some(
        ({ command, args }) =>
          command === "/usr/bin/security" || args.includes("--sign"),
      ),
    ).toBe(false);
    expect(
      calls
        .filter(({ args }) => args.includes("--entitlements"))
        .every(({ args }) => args[args.indexOf("--entitlements") + 1] === "-"),
    ).toBe(true);
  });

  it.each([
    "main",
    "sidecar",
    "artifact",
  ])("rejects changed %s digest before signature checks", async (role) => {
    const { options, files } = await fixture();
    await writeFile(files[role], "changed bytes");
    const { run, calls } = stub(options);
    await expect(
      inspectMemorySignatures(options, { run, platform: "darwin" }),
    ).rejects.toThrow("digest mismatch");
    expect(calls.some(({ command }) => command === "/usr/bin/codesign")).toBe(
      false,
    );
  });

  it.each([
    "unsigned",
    "ad-hoc",
    "flags-ad-hoc",
    "wrong-team",
    "wrong-id",
    "no-team",
    "no-authority",
    "no-signature",
    "duplicate-id",
    "no-requirement",
    "bad-architecture",
    "universal",
    "bad-entitlements",
    "timeout",
    "tool-throw",
  ])("rejects %s for the sidecar", async (failure) => {
    const { options } = await fixture();
    const { run } = stub(options, (command, args) => {
      if (
        args.at(-1) === "-" &&
        command === "/usr/bin/plutil" &&
        failure === "bad-entitlements"
      )
        return ok("not JSON");
      if (!args.at(-1).endsWith("berd-memory-mcp")) return;
      if (args.includes("--verify")) {
        if (failure === "unsigned")
          return { status: 1, stderr: `${secret} ${options.root}` };
        if (failure === "timeout")
          return { status: null, signal: "SIGTERM", error: new Error(secret) };
        if (failure === "tool-throw") throw new Error(secret);
      }
      if (command === "/usr/bin/lipo") {
        if (failure === "bad-architecture") return ok("x86_64");
        if (failure === "universal") return ok("x86_64 arm64");
      }
      if (args.includes("-r-") && failure === "no-requirement")
        return ok("", "no requirements");
      if (!args.includes("--verbose=4")) return;
      let metadata = `Identifier=${options["sidecar-id"]}\nTeamIdentifier=${options.team}\nSignature size=9000\nAuthority=Developer ID Application: Synthetic\n`;
      if (failure === "ad-hoc") metadata += "Signature=adhoc\n";
      if (failure === "flags-ad-hoc")
        metadata += "CodeDirectory v=20400 flags=0x2(adhoc) hashes=3\n";
      if (failure === "wrong-team")
        metadata = metadata.replace(options.team, "WRONG12345");
      if (failure === "wrong-id")
        metadata = metadata.replace(
          options["sidecar-id"],
          "com.example.attacker",
        );
      if (failure === "no-team")
        metadata = metadata.replace(`TeamIdentifier=${options.team}\n`, "");
      if (failure === "no-authority")
        metadata = metadata.replace(/^Authority=.*\n/m, "");
      if (failure === "no-signature")
        metadata = metadata.replace(/^Signature size=.*\n/m, "");
      if (failure === "duplicate-id")
        metadata += `Identifier=${options["sidecar-id"]}\n`;
      return ok("", metadata);
    });
    await expect(
      inspectMemorySignatures(options, { run, platform: "darwin" }),
    ).rejects.toThrow();
  });

  it("accepts a signed sidecar without entitlements and records their absence", async () => {
    const { options } = await fixture();
    const { run } = stub(options, (_command, args) =>
      args.includes("--entitlements") && args.at(-1).endsWith("berd-memory-mcp")
        ? ok()
        : undefined,
    );
    const result = await inspectMemorySignatures(options, {
      run,
      platform: "darwin",
    });
    expect(result.sidecar.entitlements).toMatchObject({
      present: false,
      entryCount: 0,
      sha256: hash(""),
    });
  });

  it.each([
    "missing-sidecar",
    "directory-sidecar",
    "symlink-sidecar",
    "symlink-parent",
    "symlink-artifact",
    "symlink-root",
    "outside-root",
    "relative-artifact",
    "plist-traversal",
  ])("rejects unsafe path: %s", async (failure) => {
    const { options, files } = await fixture();
    if (
      ["missing-sidecar", "directory-sidecar", "symlink-sidecar"].includes(
        failure,
      )
    ) {
      await rm(files.sidecar);
      if (failure === "directory-sidecar") await mkdir(files.sidecar);
      if (failure === "symlink-sidecar")
        await symlink(files.main, files.sidecar);
    }
    if (failure === "symlink-parent") {
      await rm(join(options.app, "Contents/MacOS"), { recursive: true });
      await symlink(options.root, join(options.app, "Contents/MacOS"));
    }
    if (failure === "symlink-artifact") {
      await rm(files.artifact);
      await symlink(files.main, files.artifact);
    }
    if (failure === "symlink-root") {
      const alias = join(options.root, "alias");
      await symlink(options.root, alias);
      options.root = alias;
    }
    if (failure === "outside-root")
      options.artifact = join(options.root, "..", "outside");
    if (failure === "relative-artifact") options.artifact = "release.dmg";
    const { run } = stub(options, (command, args) =>
      failure === "plist-traversal" &&
      command === "/usr/bin/plutil" &&
      args[0] === "-extract"
        ? ok("../outside")
        : undefined,
    );
    await expect(
      inspectMemorySignatures(options, { run, platform: "darwin" }),
    ).rejects.toThrow();
  });

  it("rejects input mutation during inspection", async () => {
    const { options, files } = await fixture();
    const { run } = stub(options, (_command, args) => {
      if (args.includes("--deep"))
        writeFileSync(files.sidecar, "concurrently replaced");
    });
    await expect(
      inspectMemorySignatures(options, { run, platform: "darwin" }),
    ).rejects.toThrow("Inspection input changed");
  });

  it("reports group entitlement counts and digests without revealing arbitrary values", async () => {
    const { options } = await fixture();
    const { run } = stub(options, (command, args) =>
      command === "/usr/bin/plutil" && args[0] === "-convert"
        ? ok(JSON.stringify({ "keychain-access-groups": [secret] }))
        : undefined,
    );
    const result = await inspectMemorySignatures(options, {
      run,
      platform: "darwin",
    });
    expect(
      result.sidecar.entitlements.groups["keychain-access-groups"],
    ).toEqual({ count: 1, sha256: hash(JSON.stringify([secret])) });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("sanitizes CLI failures without echoing paths or tool output", async () => {
    const { options } = await fixture();
    options.artifact = join(options.root, secret);
    const result = spawnSync(
      process.execPath,
      [
        inspector,
        ...Object.entries(options).flatMap(([key, value]) => [
          `--${key}`,
          value,
        ]),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).status).toBe("failed");
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain(options.root);
  });

  it("rejects duplicate and unknown CLI options and documents all required inputs", () => {
    for (const args of [
      ["--root", "a", "--root", "b"],
      ["--run-tool", secret],
    ]) {
      const result = spawnSync(process.execPath, [inspector, ...args], {
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain(secret);
    }
    const help = spawnSync(process.execPath, [inspector, "--help"], {
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--sidecar-sha256");
    expect(help.stdout).toContain("--team");
    expect(help.stdout).toContain("--main-id");
    expect(help.stdout).toContain("--sidecar-id");
  });

  it.each([
    "team",
    "main-id",
    "sidecar-id",
    "artifact-sha256",
    "main-sha256",
    "sidecar-sha256",
    "source-sha",
  ])("rejects malformed expected %s before tools", async (field) => {
    const { options } = await fixture();
    options[field] = 'invalid"; shell';
    const { run, calls } = stub(options);
    await expect(
      inspectMemorySignatures(options, { run, platform: "darwin" }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("rejects non-macOS before accessing paths or tools", async () => {
    const { run, calls } = stub({});
    await expect(
      inspectMemorySignatures({}, { run, platform: "linux" }),
    ).rejects.toThrow("requires macOS");
    expect(calls).toHaveLength(0);
  });

  it.runIf(process.platform === "darwin")(
    "rejects a valid ad-hoc synthetic arm64 bundle using real codesign without executing it",
    async () => {
      const { options, files } = await fixture();
      const source = join(options.root, "synthetic.c");
      await writeFile(source, "int main(void) { return 0; }\n");
      const system = (command, args) =>
        spawnSync(command, args, {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          shell: false,
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
        });
      expect(
        system("/usr/bin/clang", ["-arch", "arm64", source, "-o", files.main])
          .status,
      ).toBe(0);
      await copyFile(files.main, files.sidecar);
      // Only these newly created temporary fixtures receive ad-hoc signatures.
      // '-' uses no signing identity, certificate, or credential prompt.
      expect(
        system("/usr/bin/codesign", [
          "--force",
          "--sign",
          "-",
          "--identifier",
          options["sidecar-id"],
          files.sidecar,
        ]).status,
      ).toBe(0);
      expect(
        system("/usr/bin/codesign", [
          "--force",
          "--sign",
          "-",
          "--identifier",
          options["main-id"],
          options.app,
        ]).status,
      ).toBe(0);
      expect(
        system("/usr/bin/codesign", [
          "--verify",
          "--deep",
          "--strict",
          "--all-architectures",
          options.app,
        ]).status,
      ).toBe(0);
      for (const role of ["main", "sidecar"]) {
        const display = system("/usr/bin/codesign", [
          "--display",
          "--verbose=4",
          files[role],
        ]);
        expect(display.status).toBe(0);
        expect(`${display.stdout}\n${display.stderr}`).toContain(
          "Signature=adhoc",
        );
        expect(
          system("/usr/bin/lipo", ["-archs", files[role]]).stdout.trim(),
        ).toBe("arm64");
        options[`${role}-sha256`] = hash(await readFile(files[role]));
      }
      // Digests, architecture, and internal signature integrity are valid;
      // the helper must still reject the absent Apple-anchored expected identity.
      await expect(inspectMemorySignatures(options)).rejects.toThrow(
        "codesign inspection failed",
      );
    },
    60_000,
  );

  it.runIf(process.platform === "darwin")(
    "rejects an unsigned synthetic bundle with real system tools, without signing or executing it",
    async () => {
      const { options, files } = await fixture();
      await chmod(files.main, 0o700);
      await chmod(files.sidecar, 0o700);
      await expect(inspectMemorySignatures(options)).rejects.toThrow(
        "codesign inspection failed",
      );
    },
  );
});
