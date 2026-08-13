import { afterEach, describe, expect, it } from "vitest";
import {
  access,
  mkdtemp,
  mkdir,
  chmod,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

const repo = resolve(import.meta.dirname, "../../..");
const tempDirs = [];
const releaseRepositoryEnv = { BERD_REPO: "squareup/berd" };

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "berd-release-test-"));
  tempDirs.push(path);
  return path;
}

function run(command, args, env = {}) {
  return spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("managed Goose build profile", () => {
  it("defaults development to debug and makes release selection profile-aware", async () => {
    const script = await readFile(
      join(repo, "scripts/ensure-local-goose.sh"),
      "utf8",
    );

    expect(script).toContain(`build_profile="\${GOOSE_BUILD_PROFILE:-debug}"`);
    expect(script).toContain(
      '[[ "$build_profile" == "release" ]] && cargo_args+=(--release)',
    );
    expect(script).toContain(
      'printf \'%s/%s/%s\\n\' "$target_dir" "$build_profile" "$goose_bin"',
    );
    expect(script).toContain(
      "printf 'STAMP_BUILD_PROFILE=%q\\n' \"$build_profile\"",
    );
  });

  it("requests release Goose in every Unix packaging lane", async () => {
    const [justfile, macos, workflow, docker] = await Promise.all([
      readFile(join(repo, "justfile"), "utf8"),
      readFile(join(repo, "scripts/release/build-macos.sh"), "utf8"),
      readFile(join(repo, ".github/workflows/release.yml"), "utf8"),
      readFile(join(repo, "scripts/build_linux_docker.sh"), "utf8"),
    ]);

    expect(justfile).toMatch(
      /_bundle-unix:[\s\S]*if \[\[ -z "\$\{GOOSE_BIN:-\}" \]\]; then[\s\S]*GOOSE_BUILD_PROFILE=release \.\/scripts\/ensure-local-goose\.sh/,
    );
    expect(macos).toContain("GOOSE_BUILD_PROFILE=release just setup");
    expect(workflow).toContain("GOOSE_BUILD_PROFILE=release just setup");
    expect(docker).toContain("GOOSE_BUILD_PROFILE=release");
  });

  it("keeps Windows development debug and release bundles optimized", async () => {
    const [module, bundle, workflow, windowsSetup] = await Promise.all([
      readFile(join(repo, "scripts/windows/WindowsDev.psm1"), "utf8"),
      readFile(join(repo, "scripts/windows/Bundle-Windows.ps1"), "utf8"),
      readFile(join(repo, ".github/workflows/release.yml"), "utf8"),
      readFile(join(repo, "scripts/windows/Setup-Windows.ps1"), "utf8"),
    ]);

    expect(module).toContain('$buildProfile = "debug"');
    expect(module).toContain('$Settings.BuildProfile -eq "release"');
    expect(module).toContain('$cargoArguments += "--release"');
    expect(bundle).toContain(
      '$gooseBuildProfile = if ($Debug) { "debug" } else { "release" }',
    );
    expect(bundle).toContain("$env:GOOSE_BUILD_PROFILE = $gooseBuildProfile");
    expect(workflow).toContain("run: just setup-windows release");
    expect(windowsSetup).toContain(
      '[ValidateSet("debug", "release")][string]$GooseBuildProfile = "debug"',
    );
    expect(windowsSetup).toContain(
      "$env:GOOSE_BUILD_PROFILE = $GooseBuildProfile",
    );
  });

  it("pins ordinary development entry points to debug Goose", async () => {
    const [justfile, devE2e, schema, windowsSetup, windowsDev, windowsStage] =
      await Promise.all([
        readFile(join(repo, "justfile"), "utf8"),
        readFile(join(repo, "scripts/dev-e2e.sh"), "utf8"),
        readFile(join(repo, "scripts/regenerate-sdk-schema.sh"), "utf8"),
        readFile(join(repo, "scripts/windows/Setup-Windows.ps1"), "utf8"),
        readFile(join(repo, "scripts/windows/Dev-Windows.ps1"), "utf8"),
        readFile(
          join(repo, "scripts/windows/Invoke-Stage-Sidecar-Windows.ps1"),
          "utf8",
        ),
      ]);

    expect(justfile).toMatch(
      /setup: _setup-dev-deps[\s\S]*GOOSE_DEV_MODE=required \.\/scripts\/ensure-local-goose\.sh/,
    );
    expect(justfile).toMatch(
      /_bundle-debug-unix:[\s\S]*if \[\[ -z "\$\{GOOSE_BIN:-\}" \]\]; then[\s\S]*GOOSE_BUILD_PROFILE=debug \.\/scripts\/ensure-local-goose\.sh/,
    );
    expect(justfile).toMatch(
      /dev:[\s\S]*GOOSE_BUILD_PROFILE=debug just setup[\s\S]*GOOSE_BUILD_PROFILE=debug \.\/scripts\/ensure-local-goose\.sh --check-bin/,
    );
    expect(devE2e).toContain("GOOSE_BUILD_PROFILE=debug just setup");
    expect(schema).toContain("GOOSE_BUILD_PROFILE=debug");
    expect(windowsSetup).toContain('$GooseBuildProfile = "debug"');
    expect(windowsDev).toContain('$env:GOOSE_BUILD_PROFILE = "debug"');
    expect(windowsStage).toContain('$env:GOOSE_BUILD_PROFILE = "debug"');
  });
});

describe("Docker Linux registry setup", () => {
  it("forwards the host npm registry when Docker replaces HOME", async () => {
    const dir = await tempDir();
    const bin = join(dir, "bin");
    const capture = join(dir, "docker-args");
    const output = join(dir, "output");
    const calls = join(dir, "docker-calls");
    await mkdir(bin);
    const dollar = "$";
    await writeFile(
      join(bin, "npm"),
      `#!/bin/sh\nif [ "${dollar}1" = config ] && [ "${dollar}2" = get ] && [ "${dollar}3" = registry ]; then printf '%s\\n' 'https://host.example.test/npm/'; fi\n`,
    );
    await writeFile(
      join(bin, "docker"),
      `#!/bin/sh\nprintf '%s\\n' "${dollar}@" >> "${dollar}DOCKER_CAPTURE"\ncalls=$(cat "${dollar}DOCKER_CALLS" 2>/dev/null || true)\ncalls="${dollar}calls x"\nprintf '%s' "${dollar}calls" > "${dollar}DOCKER_CALLS"\nif [ "${dollar}calls" = ' x x' ]; then mkdir -p .docker-cache/tauri-target/release/bundle; touch .docker-cache/tauri-target/release/bundle/Berd.deb; fi\n`,
    );
    await Promise.all([
      chmod(join(bin, "npm"), 0o755),
      chmod(join(bin, "docker"), 0o755),
    ]);
    const result = run("bash", ["scripts/build_linux_docker.sh"], {
      DOCKER: join(bin, "docker"),
      DOCKER_CAPTURE: capture,
      DOCKER_CALLS: calls,
      GOOSE_LINUX_DOCKER_OUTPUT: output,
      NPM_CONFIG_REGISTRY: "",
      COREPACK_NPM_REGISTRY: "",
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const args = await readFile(capture, "utf8");
    expect(args).toContain("NPM_REGISTRY=https://host.example.test/npm/");
    expect(args).toContain(
      "NPM_CONFIG_REGISTRY=https://host.example.test/npm/",
    );
    expect(args).toContain(
      "npm_config_registry=https://host.example.test/npm/",
    );
  });
});

describe("build-tauri-release-config", () => {
  async function generate(env) {
    const dir = await tempDir();
    const output = join(dir, "release.json");
    const catalogOutput = join(dir, "release-channels.json");
    const result = run(
      "node",
      ["scripts/release/build-tauri-release-config.mjs"],
      {
        BERD_RELEASE_CHANNEL: "",
        BERD_UPDATER_ENDPOINT: "",
        BERD_UPDATER_PUBLIC_KEY: "",
        BERD_RELEASE_CHANNELS_FILE: "",
        BERD_RELEASE_CHANNEL_ID: "",
        ...env,
        TAURI_RELEASE_CONFIG_PATH: output,
        BERD_RELEASE_CATALOG_OUTPUT: catalogOutput,
      },
    );
    return { result, output, catalogOutput };
  }

  it.each([
    "public",
    "internal",
  ])("emits one endpoint/key pair for %s", async (channel) => {
    const { result, output, catalogOutput } = await generate({
      BERD_RELEASE_CHANNEL: channel,
      BERD_UPDATER_ENDPOINT: "https://updates.example.test/latest.json",
      BERD_UPDATER_PUBLIC_KEY: `${channel}-key`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      plugins: {
        updater: {
          pubkey: `${channel}-key`,
          endpoints: ["https://updates.example.test/latest.json"],
        },
      },
      bundle: {
        resources: {
          "resources/release-channels.json": "release-channels.json",
        },
      },
    });
    expect(JSON.parse(await readFile(catalogOutput, "utf8"))).toMatchObject({
      schemaVersion: 1,
      defaultChannel: "main",
      runningBuild: {
        channelId: "main",
        compatibility: {
          storeContractVersion: 1,
          writesDataEpoch: 1,
          minReadableDataEpoch: 1,
          maxReadableDataEpoch: 1,
        },
      },
      channels: [
        {
          id: "main",
          label: "Main",
          endpoint: "https://updates.example.test/latest.json",
          pubkey: `${channel}-key`,
          compatibility: {
            storeContractVersion: 1,
            writesDataEpoch: 1,
            minReadableDataEpoch: 1,
            maxReadableDataEpoch: 1,
          },
        },
      ],
    });
  });

  it("emits an empty overlay and disabled catalog for disabled", async () => {
    const { result, output, catalogOutput } = await generate({
      BERD_RELEASE_CHANNEL: "disabled",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({});
    expect(JSON.parse(await readFile(catalogOutput, "utf8"))).toEqual({
      schemaVersion: 1,
      disabled: true,
    });
  });

  it("validates and emits a finite multi-channel catalog", async () => {
    const dir = await tempDir();
    const source = join(dir, "channels.json");
    await writeFile(
      source,
      JSON.stringify({
        schemaVersion: 1,
        defaultChannel: "main",
        channels: [
          {
            id: "main",
            label: "Main",
            description: "Recommended releases",
            endpoint: "https://updates.example.test/main/latest.json",
            pubkey: "shared-key",
            runningBuild: {
              compatibility: {
                storeContractVersion: 1,
                writesDataEpoch: 1,
                minReadableDataEpoch: 1,
                maxReadableDataEpoch: 2,
              },
            },
          },
          {
            id: "beta",
            label: "Beta",
            description: "New features first",
            whatToTest: "Try the new agent builder.",
            endpoint: "https://updates.example.test/beta/latest.json",
            pubkey: "shared-key",
            runningBuild: {
              compatibility: {
                storeContractVersion: 1,
                writesDataEpoch: 2,
                minReadableDataEpoch: 1,
                maxReadableDataEpoch: 2,
              },
            },
          },
        ],
      }),
    );

    const { result, output, catalogOutput } = await generate({
      BERD_RELEASE_CHANNEL: "internal",
      BERD_RELEASE_CHANNELS_FILE: source,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      plugins: {
        updater: {
          pubkey: "shared-key",
          endpoints: ["https://updates.example.test/main/latest.json"],
        },
      },
    });
    expect(JSON.parse(await readFile(catalogOutput, "utf8"))).toMatchObject({
      defaultChannel: "main",
      runningBuild: { channelId: "main" },
      channels: [
        { id: "main" },
        { id: "beta", whatToTest: "Try the new agent builder." },
      ],
    });
  });

  it.each([
    [
      "duplicate IDs",
      (catalog) => catalog.channels.push({ ...catalog.channels[0] }),
    ],
    [
      "duplicate endpoints",
      (catalog) => {
        catalog.channels[1].endpoint = catalog.channels[0].endpoint;
      },
    ],
    [
      "missing default",
      (catalog) => {
        catalog.defaultChannel = "missing";
      },
    ],
    [
      "inverted compatibility",
      (catalog) => {
        catalog.channels[1].runningBuild.compatibility.minReadableDataEpoch = 3;
      },
    ],
  ])("rejects a catalog with %s", async (_name, mutate) => {
    const dir = await tempDir();
    const source = join(dir, "channels.json");
    const catalog = {
      schemaVersion: 1,
      defaultChannel: "main",
      channels: ["main", "beta"].map((id, index) => ({
        id,
        label: id === "main" ? "Main" : "Beta",
        endpoint: `https://updates.example.test/${id}/latest.json`,
        pubkey: `${id}-key`,
        runningBuild: {
          compatibility: {
            storeContractVersion: 1,
            writesDataEpoch: index + 1,
            minReadableDataEpoch: 1,
            maxReadableDataEpoch: 2,
          },
        },
      })),
    };
    mutate(catalog);
    await writeFile(source, JSON.stringify(catalog));

    const { result } = await generate({
      BERD_RELEASE_CHANNEL: "internal",
      BERD_RELEASE_CHANNELS_FILE: source,
    });
    expect(result.status).not.toBe(0);
  });

  it.each([
    ["missing channel", {}],
    ["unknown channel", { BERD_RELEASE_CHANNEL: "stable" }],
    [
      "missing endpoint",
      { BERD_RELEASE_CHANNEL: "public", BERD_UPDATER_PUBLIC_KEY: "key" },
    ],
    [
      "missing key",
      {
        BERD_RELEASE_CHANNEL: "internal",
        BERD_UPDATER_ENDPOINT: "https://example.test/latest.json",
      },
    ],
    [
      "non-HTTPS endpoint",
      {
        BERD_RELEASE_CHANNEL: "public",
        BERD_UPDATER_PUBLIC_KEY: "key",
        BERD_UPDATER_ENDPOINT: "http://example.test/latest.json",
      },
    ],
    [
      "credentials in endpoint",
      {
        BERD_RELEASE_CHANNEL: "public",
        BERD_UPDATER_PUBLIC_KEY: "key",
        BERD_UPDATER_ENDPOINT: "https://user@example.test/latest.json",
      },
    ],
    [
      "disabled mixed with key",
      { BERD_RELEASE_CHANNEL: "disabled", BERD_UPDATER_PUBLIC_KEY: "key" },
    ],
    [
      "disabled mixed with endpoint",
      {
        BERD_RELEASE_CHANNEL: "disabled",
        BERD_UPDATER_ENDPOINT: "https://example.test/latest.json",
      },
    ],
  ])("fails closed for %s", async (_name, env) => {
    const { result } = await generate(env);
    expect(result.status).not.toBe(0);
  });
});

describe("local macOS bundle version propagation", () => {
  it("exports the resolved version to Rust for release and debug bundles", async () => {
    const justfile = await readFile(join(repo, "justfile"), "utf8");
    const versionEnvironment = `CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" \\
      BERD_APP_VERSION="$BERD_APP_VERSION" \\
      VITE_AUTH_GATE="\${VITE_BUILDERBOT:-0}" \\
      VITE_APP_VERSION="$BERD_APP_VERSION_RICH" \\
      `;

    expect(justfile).toContain(
      `${versionEnvironment}"\${TAURI_BUILD_ARGS[@]}"`,
    );
    expect(justfile).toContain(
      `${versionEnvironment}pnpm tauri build --features "$CARGO_FEATURES_CSV" --config "$DEBUG_CONFIG"`,
    );
  });
});

describe("local macOS bundle feature-gate propagation", () => {
  const gates = [
    ["VITE_AGENT_TOOLS", "block-agent-tools"],
    ["VITE_AUTOMATIONS", "block-automations"],
    ["VITE_BUILDERBOT", "block-builderbot"],
    ["VITE_FEEDBACK", "block-feedback"],
    ["VITE_MANAGED_CONNECTIONS", "block-managed-connections"],
    ["VITE_VOICE_DICTATION", "block-voice-dictation"],
  ];

  it("maps all six positive opt-ins in both release and debug recipes", async () => {
    const justfile = await readFile(join(repo, "justfile"), "utf8");
    const releaseRecipe = justfile.slice(
      justfile.indexOf("_bundle-unix:"),
      justfile.indexOf("# Build macOS app and DMG bundles."),
    );
    const debugRecipe = justfile.slice(
      justfile.indexOf("_bundle-debug-unix:"),
      justfile.indexOf("# ── Test"),
    );

    for (const recipe of [releaseRecipe, debugRecipe]) {
      for (const [viteGate, cargoFeature] of gates) {
        expect(recipe).toContain(`\${${viteGate}:-0}`);
        expect(recipe).toContain(cargoFeature);
      }
      expect(recipe).toContain(`VITE_AUTH_GATE="\${VITE_BUILDERBOT:-0}"`);
      expect(recipe).toContain("no-voice-dictation");
      expect(recipe).toContain("prepare-bb-cli-resource.sh");
      expect(recipe).toContain('"../resources/bb"');
      expect(recipe).toContain(`VITE_FEEDBACK="\${VITE_FEEDBACK:-0}"`);
    }
  });
});

describe("development Block-feature resources", () => {
  it.each([
    "justfile",
    "scripts/dev-e2e.sh",
  ])("%s keeps the standalone CLI and Agent Tools resource aligned with renderer gates", async (path) => {
    const source = await readFile(join(repo, path), "utf8");
    expect(source).toContain(
      `[[ "\${VITE_FEEDBACK:-0}" == "1" ]] && BERDCTL_FEATURES+=(--features block-feedback)`,
    );
    expect(source).toContain(
      `cargo build -p berdctl \${BERDCTL_FEATURES[@]+"\${BERDCTL_FEATURES[@]}"}`,
    );
    expect(source).toContain(`[[ "\${VITE_AGENT_TOOLS:-0}" == "1" ]]`);
    expect(source).toContain("prepare-bb-cli-resource.sh");
  });
});

describe("build-macos Block-service feature seam", () => {
  it("defaults all six families off and maps each opt-in to packaging", async () => {
    const script = await readFile(
      join(repo, "scripts/release/build-macos.sh"),
      "utf8",
    );
    const gates = [
      ["AGENT_TOOLS", "block-agent-tools"],
      ["AUTOMATIONS", "block-automations"],
      ["BUILDERBOT", "block-builderbot"],
      ["FEEDBACK", "block-feedback"],
      ["MANAGED_CONNECTIONS", "block-managed-connections"],
      ["VOICE_DICTATION", "block-voice-dictation"],
    ];

    for (const [gate, cargoFeature] of gates) {
      expect(script).toContain(`VITE_${gate}_VALUE="\${VITE_${gate}:-0}"`);
      expect(script).toContain(cargoFeature);
      expect(script).toContain(`VITE_${gate}="$VITE_${gate}_VALUE"`);
    }
    expect(script).toContain('VITE_AUTH_GATE_VALUE="$VITE_BUILDERBOT_VALUE"');
    expect(script).toContain("no-voice-dictation");
    expect(script).toContain('if [[ "$VITE_AGENT_TOOLS_VALUE" == "1" ]]; then');
    expect(script).toContain(
      'jq \'.bundle.resources["../resources/bb"] = "bb"\'',
    );
    expect(script).toContain(
      'VITE_FEEDBACK="$VITE_FEEDBACK_VALUE" ./scripts/prepare-berdctl-sidecar.sh',
    );
  });

  it("preserves the custom-build telemetry privacy opt-out outside the six gates", async () => {
    const script = await readFile(
      join(repo, "scripts/release/build-macos.sh"),
      "utf8",
    );
    expect(script).toContain(
      `jq -r '.featureToggles.telemetry == false' "$RUNTIME_CONFIG"`,
    );
    expect(script).toContain("set_vite_env VITE_TELEMETRY 0");
  });
});

describe("build-macos release resource staging", () => {
  it("requires Beta Linear routing when a Beta catalog is bundled", async () => {
    const script = await readFile(
      join(repo, "scripts/release/build-macos.sh"),
      "utf8",
    );
    expect(script).toContain('select(.id == "beta")');
    expect(script).toContain(
      "beta_linear_label_id must be a Linear label UUID when the release catalog contains Beta",
    );
    expect(script).toContain(
      'VITE_BETA_LINEAR_LABEL_ID="$VITE_BETA_LINEAR_LABEL_ID_VALUE"',
    );
  });

  it("invokes only resource staging scripts present in the checkout", async () => {
    const script = await readFile(
      join(repo, "scripts/release/build-macos.sh"),
      "utf8",
    );
    const stagingScripts = [
      ...script.matchAll(/\.\/scripts\/(prepare-[a-z0-9-]+\.sh)/g),
    ].map((match) => match[1]);

    expect(stagingScripts).not.toHaveLength(0);
    await Promise.all(
      stagingScripts.map((path) => access(join(repo, "scripts", path))),
    );
  });
});

describe("generate-latest-json", () => {
  it("generates one manifest for macOS, Windows, and Linux", async () => {
    const dir = await tempDir();
    const macSignature = join(dir, "mac.sig");
    const windowsSignature = join(dir, "windows.sig");
    const linuxSignature = join(dir, "linux.sig");
    await writeFile(macSignature, "mac-signature\n");
    await writeFile(windowsSignature, "windows-signature\n");
    await writeFile(linuxSignature, "linux-signature\n");
    const result = run("scripts/release/generate-latest-json.sh", [
      "1.2.3",
      "Berd v1.2.3",
      "darwin-aarch64",
      macSignature,
      "https://updates.example.test/Berd_1.2.3_darwin-aarch64.app.tar.gz",
      "windows-x86_64",
      windowsSignature,
      "https://updates.example.test/Berd_1.2.3_windows-x86_64-setup.nsis.zip",
      "linux-x86_64",
      linuxSignature,
      "https://updates.example.test/Berd_1.2.3_linux-x86_64.AppImage.tar.gz",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: "1.2.3",
      platforms: {
        "darwin-aarch64": { signature: "mac-signature" },
        "windows-x86_64": { signature: "windows-signature" },
        "linux-x86_64": { signature: "linux-signature" },
      },
    });
  });

  it("adds per-platform compatibility metadata without corrupting JSON env values", async () => {
    const dir = await tempDir();
    const macSignature = join(dir, "mac.sig");
    const windowsSignature = join(dir, "windows.sig");
    await writeFile(macSignature, "mac-signature\n");
    await writeFile(windowsSignature, "windows-signature\n");
    const result = run(
      "scripts/release/generate-latest-json.sh",
      [
        "1.2.3",
        "Berd v1.2.3",
        "darwin-aarch64",
        macSignature,
        "https://updates.example.test/Berd_1.2.3_darwin-aarch64.app.tar.gz",
        "windows-x86_64",
        windowsSignature,
        "https://updates.example.test/Berd_1.2.3_windows-x86_64-setup.nsis.zip",
      ],
      {
        BERD_RELEASE_CHANNEL_ID: "main",
        BERD_STORE_CONTRACT_VERSION: "1",
        BERD_WRITES_DATA_EPOCH: "1",
        BERD_MIN_READABLE_DATA_EPOCH: "1",
        BERD_MAX_READABLE_DATA_EPOCH: "1",
        BERD_ARTIFACT_SHA256_BY_PLATFORM: JSON.stringify({
          "darwin-aarch64": "a".repeat(64),
          "windows-x86_64": "b".repeat(64),
        }),
        BERD_COMPATIBILITY_SIGNATURES_BY_PLATFORM: JSON.stringify({
          "darwin-aarch64": "mac-compatibility",
          "windows-x86_64": "windows-compatibility",
        }),
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest).toMatchObject({
      signedCompatibility: {
        artifactSha256: "a".repeat(64),
        signature: "mac-compatibility",
      },
      signedCompatibilityPlatforms: {
        "darwin-aarch64": {
          artifactSha256: "a".repeat(64),
          signature: "mac-compatibility",
        },
        "windows-x86_64": {
          artifactSha256: "b".repeat(64),
          signature: "windows-compatibility",
        },
      },
    });
    // This is the metadata lookup contract used by already-installed macOS
    // builds before signedCompatibilityPlatforms existed.
    expect(manifest.signedCompatibility).toEqual(
      manifest.signedCompatibilityPlatforms["darwin-aarch64"],
    );
  });

  it("rejects ambiguous or malformed archive URLs", async () => {
    const dir = await tempDir();
    const signature = join(dir, "archive.sig");
    await writeFile(signature, "signed-value\n");
    const archive = "Berd_1.2.3_darwin-aarch64.app.tar.gz";
    const invalidUrls = [
      `https://user@example.test/${archive}`,
      `https://example.test/${archive}?download=1`,
      `https://example.test/${archive}#fragment`,
      `https:///${archive}`,
      `https://example.test/ ${archive}`,
      `https://example.test/prefix-${archive}`,
    ];
    for (const url of invalidUrls) {
      const result = run("scripts/release/generate-latest-json.sh", [
        "1.2.3",
        "Berd v1.2.3",
        "darwin-aarch64",
        signature,
        url,
      ]);
      expect(result.status, url).not.toBe(0);
      expect(result.stderr).toContain("canonical HTTPS");
    }
  });

  it("rejects duplicate updater platforms", async () => {
    const dir = await tempDir();
    const signature = join(dir, "archive.sig");
    await writeFile(signature, "signed-value\n");
    const args = [
      "1.2.3",
      "Berd v1.2.3",
      "darwin-aarch64",
      signature,
      "https://updates.example.test/Berd_1.2.3_darwin-aarch64.app.tar.gz",
    ];
    const result = run("scripts/release/generate-latest-json.sh", [
      ...args,
      ...args.slice(2),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("duplicate updater platform");
  });
});

describe("desktop release workflow platform gate", () => {
  it("does not interpolate GitHub expressions into executable shell", async () => {
    const workflow = parseYaml(
      await readFile(join(repo, ".github/workflows/release.yml"), "utf8"),
    );
    const runSteps = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      (job.steps ?? [])
        .filter((step) => typeof step.run === "string")
        .map((step) => ({ jobName, stepName: step.name, run: step.run })),
    );
    const interpolatedSteps = runSteps.filter(({ run }) => run.includes("${{"));

    expect(interpolatedSteps).toEqual([]);
  });

  it("requires macOS, Windows, and Linux staging before promotion", async () => {
    const workflow = await readFile(
      join(repo, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      "needs: [setup, stage-macos, stage-windows, stage-linux]",
    );
    expect(workflow).toContain("needs.stage-windows.result == 'success'");
    expect(workflow).toContain("needs.stage-linux.result == 'success'");
    expect(workflow).toContain(
      "for PLATFORM in darwin-aarch64 windows-x86_64 linux-x86_64",
    );
    expect(workflow).toContain("Package and sign Windows updater archive");
    expect(workflow).toContain("Package and sign Linux updater archive");
    expect(workflow).toContain("actions/attest-build-provenance@");
    const parsedWorkflow = parseYaml(workflow);
    const attestationSteps = Object.values(parsedWorkflow.jobs).flatMap((job) =>
      (job.steps ?? []).filter((step) =>
        step.uses?.startsWith("actions/attest-build-provenance@"),
      ),
    );
    expect(attestationSteps).toHaveLength(3);
    const expressionStart = "$" + "{{";
    const expectedSubjectPath =
      `${expressionStart} runner.temp }}/release-assets/Berd_` +
      `${expressionStart} env.VERSION }}_${expressionStart} env.PLATFORM }}.provenance.json`;
    expect(attestationSteps.map((step) => step.with["subject-path"])).toEqual(
      Array(3).fill(expectedSubjectPath),
    );
    expect(workflow).not.toContain(`${expressionStart} env.asset_dir }}`);
    expect(workflow).not.toContain("release delete-asset");
    expect(workflow).toContain("release-reconcile-assets");
    expect(workflow).toContain("group: berd-release-$" + "{{ github.ref }}");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("release-write-provenance");
    expect(workflow).not.toContain("jq -n");
    const justfile = await readFile(join(repo, "justfile"), "utf8");
    const provenanceRecipes = justfile.slice(
      justfile.indexOf(
        "# Write one platform's tag-bound release provenance receipt.",
      ),
      justfile.indexOf("# ── BuilderBot CLI"),
    );
    expect(provenanceRecipes).toContain(
      "[unix]\n[positional-arguments]\nrelease-write-provenance",
    );
    expect(provenanceRecipes).toContain(
      '[windows]\n[positional-arguments]\n[script("bash", "-euo", "pipefail")]\nrelease-write-provenance',
    );
    expect(provenanceRecipes.match(/release-write-provenance/g)).toHaveLength(
      2,
    );
    expect(provenanceRecipes).toContain(
      'bash -euo pipefail -c \'scripts/release/write-provenance.sh "$@"\' _ "$1" "$2" "$3" "$4" "$' +
        '{@:5}"',
    );
    expect(provenanceRecipes).toContain(
      'scripts/release/write-provenance.sh "$1" "$2" "$3" "$4" "$' + '{@:5}"',
    );
    const justVersion = run(join(repo, "bin/just"), ["--version"]);
    expect(justVersion.status, justVersion.stderr).toBe(0);
    expect(justVersion.stdout).toContain("just 1.40.0");
    const stableParse = run(join(repo, "bin/just"), ["--summary"], {
      JUST_UNSTABLE: "",
    });
    expect(stableParse.status, stableParse.stderr).toBe(0);
    const stableDryRun = run(join(repo, "bin/just"), ["--dry-run", "check"], {
      JUST_UNSTABLE: "",
    });
    expect(stableDryRun.status, stableDryRun.stderr).toBe(0);
    const provenanceDir = await tempDir();
    const provenanceAssets = ["asset one", "asset'quote", "asset$literal"];
    await Promise.all(
      provenanceAssets.map((asset) =>
        writeFile(join(provenanceDir, asset), `contents for ${asset}`),
      ),
    );
    const unixProvenance = run(
      join(repo, "bin/just"),
      [
        "release-write-provenance",
        "0123456789abcdef0123456789abcdef01234567",
        "1.2.3",
        "linux-x86_64",
        provenanceDir,
        ...provenanceAssets,
      ],
      { JUST_UNSTABLE: "" },
    );
    expect(unixProvenance.status, unixProvenance.stderr).toBe(0);
    const provenance = JSON.parse(
      await readFile(
        join(provenanceDir, "Berd_1.2.3_linux-x86_64.provenance.json"),
        "utf8",
      ),
    );
    expect(Object.keys(provenance.artifacts)).toEqual(provenanceAssets);
    expect(parsedWorkflow.env.JUST_UNSTABLE).toBeUndefined();
    expect(parsedWorkflow.jobs["stage-windows"].env.JUST_UNSTABLE).toBe("1");
    for (const [jobName, job] of Object.entries(parsedWorkflow.jobs)) {
      if (jobName !== "stage-windows") {
        expect(job.env?.JUST_UNSTABLE).toBeUndefined();
      }
    }
    const setupSteps = parsedWorkflow.jobs.setup.steps;
    const hermitIndex = setupSteps.findIndex(
      (step) => step.name === "Activate Hermit",
    );
    const ensureReleaseIndex = setupSteps.findIndex((step) =>
      step.run?.includes("release-ensure-versioned"),
    );
    expect(hermitIndex).toBeGreaterThanOrEqual(0);
    expect(hermitIndex).toBeLessThan(ensureReleaseIndex);
    expect(workflow.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
      workflow.indexOf(
        "TAURI_SIGNING_PRIVATE_KEY: $" +
          "{{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
      ),
    );
    expect(workflow).toContain("$env:BERD_APP_VERSION_OVERRIDE = $env:VERSION");
    expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(workflow).not.toContain("Sign-WindowsReleaseArtifact.ps1");
    expect(workflow).not.toContain("BERD_WIN_");
    expect(workflow).not.toContain("Authenticode-sign Windows installer");
    const promotion = await readFile(
      join(repo, "scripts/release/github/promote-updater.sh"),
      "utf8",
    );
    expect(promotion).toContain(
      "Windows and Linux payloads lack native code signatures",
    );
    expect(promotion).toContain(
      "Windows Authenticode posture: installer unsigned",
    );
  });

  it("keeps unsigned desktop build artifacts out of releases", async () => {
    const workflow = await readFile(
      join(repo, ".github/workflows/unsigned-desktop-build.yml"),
      "utf8",
    );
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toMatch(/env:\r?\n\s+JUST_UNSTABLE: ["']1["']/);
    expect(workflow).toContain("node-version: 24.10.0");
    expect(workflow).toContain("corepack prepare pnpm@10.33.0 --activate");
    expect(workflow).toContain(
      "codesign --force --deep --sign - release/macos/Berd.app",
    );
    expect(workflow).toContain(
      "codesign --verify --deep --strict --verbose=2 release/macos/Berd.app",
    );
    expect(workflow).toContain("just bundle-windows nsis");
    expect(workflow).not.toContain("just setup-windows");
    expect(workflow).toContain(
      "scripts/windows/Test-UnsignedWindowsPackaging.ps1",
    );
    expect(workflow).toContain(
      "scripts/windows/Collect-UnsignedWindowsInstaller.ps1",
    );
    const collector = await readFile(
      join(repo, "scripts/windows/Collect-UnsignedWindowsInstaller.ps1"),
      "utf8",
    );
    expect(collector).toContain("Import-Module");
    expect(collector).toContain("Get-TauriCargoTargetDir");
    expect(collector).toContain("Get-ChildItem -LiteralPath $nsisDir");
    expect(workflow).not.toContain(
      "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis",
    );
    expect(workflow).not.toContain("gh release");
    expect(workflow).not.toContain("latest.json");
  });
});

describe("package-signed-updater", () => {
  it("uses the version/platform-qualified filename and keeps Berd.app at archive root", async () => {
    const dir = await tempDir();
    const app = join(dir, "Berd.app");
    const zip = join(dir, "Berd.app.zip");
    const output = join(dir, "output");
    const fakeBin = join(dir, "bin");
    await mkdir(join(app, "Contents"), { recursive: true });
    await writeFile(join(app, "Contents", "marker"), "signed app");
    expect(run("ditto", ["-c", "-k", "--keepParent", app, zip]).status).toBe(0);
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "pnpm"),
      `#!/usr/bin/env bash
set -euo pipefail
archive="\${@: -1}"
printf fake-signature > "$archive.sig"
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(fakeBin, "cargo"),
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *"updater-signature-verifier"* ]]
`,
      { mode: 0o755 },
    );

    const result = run(
      "scripts/release/package-signed-updater.sh",
      [
        "--app-zip",
        zip,
        "--version",
        "1.2.3",
        "--platform",
        "darwin-aarch64",
        "--output-dir",
        output,
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH}`,
        TAURI_SIGNING_PRIVATE_KEY: "test-key",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test-password",
        BERD_UPDATER_PUBLIC_KEY: "test-public-key",
        SKIP_MACOS_SECURITY_CHECKS: "1",
        CI: "",
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const archive = join(output, "Berd_1.2.3_darwin-aarch64.app.tar.gz");
    const listing = run("tar", ["-tzf", archive]);
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout.split("\n")[0]).toBe("Berd.app/");
    expect(await readFile(`${archive}.sig`, "utf8")).toBe("fake-signature");
    expect(await readFile(`${archive}.sha256`, "utf8")).toContain(
      "Berd_1.2.3_darwin-aarch64.app.tar.gz",
    );
  });
  it("packages the Linux AppImage as a signed single-entry updater archive", async () => {
    const dir = await tempDir();
    const appimage = join(dir, "built.AppImage");
    const output = join(dir, "output");
    const fakeBin = join(dir, "bin");
    await writeFile(appimage, "appimage-bytes", { mode: 0o755 });
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "pnpm"),
      `#!/usr/bin/env bash
set -euo pipefail
archive="\${@: -1}"
cat > "$archive.sig" <<'SIG'
untrusted comment: signature from minisign secret key
fake-signature
SIG
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(fakeBin, "cargo"),
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *"updater-signature-verifier"* ]]
`,
      { mode: 0o755 },
    );

    const result = run(
      "scripts/release/package-signed-updater-linux.sh",
      ["--appimage", appimage, "--version", "1.2.3", "--output-dir", output],
      {
        PATH: `${fakeBin}:${process.env.PATH}`,
        TAURI_SIGNING_PRIVATE_KEY: "test-key",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test-password",
        BERD_UPDATER_PUBLIC_KEY: "test-public-key",
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const archive = join(output, "Berd_1.2.3_linux-x86_64.AppImage.tar.gz");
    expect(run("tar", ["-tzf", archive]).stdout.trim()).toBe(
      "Berd_1.2.3_linux-x86_64.AppImage",
    );
    expect(await readFile(`${archive}.sig`, "utf8")).toContain(
      "signature from minisign secret key",
    );
    expect(await readFile(`${archive}.sha256`, "utf8")).toContain(
      "Berd_1.2.3_linux-x86_64.AppImage.tar.gz",
    );
  });

  it("uses only the frozen repository-local Tauri signer", async () => {
    for (const name of [
      "package-signed-updater.sh",
      "package-signed-updater-windows.sh",
      "package-signed-updater-linux.sh",
      "sign-compatibility-descriptor.sh",
    ]) {
      const script = await readFile(
        join(repo, "scripts/release", name),
        "utf8",
      );
      expect(script, name).toContain("pnpm exec tauri signer sign");
      expect(script, name).not.toMatch(/\bpnpm\b[^\n]*\bdlx\b/);
      expect(script, name).not.toContain("pnpm --package");
    }
  });
});

describe("validate-manifest-promotion", () => {
  async function manifests(
    candidateVersion,
    currentVersion,
    mutateCandidate = {},
  ) {
    const dir = await tempDir();
    const base = {
      notes: "release",
      pub_date: "2026-01-01T00:00:00Z",
      platforms: {
        "darwin-aarch64": {
          url: "https://example.test/archive",
          signature: "sig",
        },
      },
    };
    const candidate = join(dir, "candidate.json");
    const current = join(dir, "current.json");
    await writeFile(
      candidate,
      `${JSON.stringify({ ...base, version: candidateVersion, ...mutateCandidate }, null, 2)}\n`,
    );
    await writeFile(
      current,
      `${JSON.stringify({ ...base, version: currentVersion }, null, 2)}\n`,
    );
    return { candidate, current };
  }

  it("accepts a newer SemVer including prerelease ordering", async () => {
    const f = await manifests("1.2.3", "1.2.3-rc.2");
    expect(
      run("node", [
        "scripts/release/validate-manifest-promotion.mjs",
        f.candidate,
        f.current,
      ]).status,
    ).toBe(0);
  });

  it("rejects a rolling-feed downgrade", async () => {
    const f = await manifests("1.2.2", "1.2.3");
    const result = run("node", [
      "scripts/release/validate-manifest-promotion.mjs",
      f.candidate,
      f.current,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing updater downgrade");
  });

  it("orders SemVer without numeric precision or locale dependence", async () => {
    const hugeCore = await manifests(
      "9007199254740993.0.0",
      "9007199254740992.0.0",
    );
    expect(
      run("node", [
        "scripts/release/validate-manifest-promotion.mjs",
        hugeCore.candidate,
        hugeCore.current,
      ]).status,
    ).toBe(0);

    const hugePrerelease = await manifests(
      "1.2.3-9007199254740992",
      "1.2.3-9007199254740993",
    );
    expect(
      run("node", [
        "scripts/release/validate-manifest-promotion.mjs",
        hugePrerelease.candidate,
        hugePrerelease.current,
      ]).status,
    ).not.toBe(0);

    const asciiOrder = await manifests("1.2.3-a", "1.2.3-B");
    expect(
      run("node", [
        "scripts/release/validate-manifest-promotion.mjs",
        asciiOrder.candidate,
        asciiOrder.current,
      ]).status,
    ).toBe(0);
  });

  it("accepts the same version only with identical release data", async () => {
    const idempotent = await manifests("1.2.3", "1.2.3", {
      pub_date: "2026-02-01T00:00:00Z",
    });
    expect(
      run("node", [
        "scripts/release/validate-manifest-promotion.mjs",
        idempotent.candidate,
        idempotent.current,
      ]).status,
    ).toBe(0);
    expect(await readFile(idempotent.candidate, "utf8")).toBe(
      await readFile(idempotent.current, "utf8"),
    );

    const changed = await manifests("1.2.3", "1.2.3", { notes: "changed" });
    const result = run("node", [
      "scripts/release/validate-manifest-promotion.mjs",
      changed.candidate,
      changed.current,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("non-idempotent replacement");
  });
});

describe("write-provenance", () => {
  it.each([
    [
      "darwin-aarch64",
      [
        "Berd_1.2.3_darwin-aarch64.app.zip",
        "Berd_1.2.3_darwin-aarch64.dmg",
        "Berd_1.2.3_darwin-aarch64.app.tar.gz",
        "Berd_1.2.3_darwin-aarch64.app.tar.gz.sig",
        "Berd_1.2.3_darwin-aarch64.app.tar.gz.sha256",
      ],
    ],
    [
      "windows-x86_64",
      [
        "Berd_1.2.3_windows-x86_64-setup.exe",
        "Berd_1.2.3_windows-x86_64-setup.nsis.zip",
        "Berd_1.2.3_windows-x86_64-setup.nsis.zip.sig",
        "Berd_1.2.3_windows-x86_64-setup.nsis.zip.sha256",
      ],
    ],
    [
      "linux-x86_64",
      [
        "Berd_1.2.3_linux-x86_64.AppImage",
        "Berd_1.2.3_linux-x86_64.deb",
        "Berd_1.2.3_linux-x86_64.rpm",
        "Berd_1.2.3_linux-x86_64.AppImage.tar.gz",
        "Berd_1.2.3_linux-x86_64.AppImage.tar.gz.sig",
        "Berd_1.2.3_linux-x86_64.AppImage.tar.gz.sha256",
      ],
    ],
  ])("writes the complete %s receipt with computed digests", async (platform, names) => {
    const dir = await tempDir();
    for (const name of names) {
      await writeFile(join(dir, name), `artifact:${name}`);
    }

    const result = run(
      "scripts/release/write-provenance.sh",
      ["a".repeat(40), "1.2.3", platform, dir, ...names],
      releaseRepositoryEnv,
    );
    expect(result.status, result.stderr).toBe(0);
    const provenance = JSON.parse(
      await readFile(join(dir, `Berd_1.2.3_${platform}.provenance.json`)),
    );
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      sourceSha: "a".repeat(40),
      version: "1.2.3",
      platform,
    });
    expect(Object.keys(provenance.artifacts)).toEqual(names);
    for (const name of names) {
      expect(provenance.artifacts[name]).toBe(
        createHash("sha256").update(`artifact:${name}`).digest("hex"),
      );
    }
  });

  it("fails closed on empty, missing, duplicate, or path-qualified assets", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "asset"), "bytes");
    await writeFile(join(dir, "empty"), "");
    const base = ["a".repeat(40), "1.2.3", "darwin-aarch64", dir];
    for (const assets of [
      ["empty"],
      ["missing"],
      ["asset", "asset"],
      ["../asset"],
    ]) {
      const result = run(
        "scripts/release/write-provenance.sh",
        [...base, ...assets],
        releaseRepositoryEnv,
      );
      expect(result.status).not.toBe(0);
    }
  });
});

describe("ensure-versioned-release", () => {
  async function fixture({
    existing = false,
    annotated = false,
    resolvedSha = "a".repeat(40),
    releaseJson = '{"tagName":"v1.2.3","isDraft":false}',
  } = {}) {
    const dir = await tempDir();
    const bin = join(dir, "bin");
    const calls = join(dir, "calls");
    await mkdir(bin);
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1 $2" == "release view" ]]; then
  if [[ "$EXISTING" != true ]]; then exit 1; fi
  if [[ "$*" == *"--json tagName,isDraft"* ]]; then
    printf '%s' "$RELEASE_JSON"
  fi
elif [[ "$1 $2" == "release create" ]]; then
  [[ "$EXISTING" == false ]]
elif [[ "$1" == "api" && "$2" == */git/ref/tags/* ]]; then
  case "$*" in
    *object.type*) [[ "$ANNOTATED" == true ]] && printf tag || printf commit ;;
    *) [[ "$ANNOTATED" == true ]] && printf bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb || printf %s "$RESOLVED_SHA" ;;
  esac
elif [[ "$1" == "api" && "$2" == */git/tags/* ]]; then
  printf %s "$RESOLVED_SHA"
else
  exit 1
fi
`,
      { mode: 0o755 },
    );
    return { bin, calls, existing, annotated, resolvedSha, releaseJson };
  }

  function ensure(f, version = "1.2.3") {
    return run(
      "scripts/release/github/ensure-versioned-release.sh",
      ["squareup/berd", `v${version}`, version, "a".repeat(40)],
      {
        PATH: `${f.bin}:${process.env.PATH}`,
        CALLS: f.calls,
        EXISTING: String(f.existing),
        ANNOTATED: String(f.annotated),
        RESOLVED_SHA: f.resolvedSha,
        RELEASE_JSON: f.releaseJson,
        GH_TOKEN: "test-token",
        ...releaseRepositoryEnv,
      },
    );
  }

  it("creates a missing stable release and verifies its tag", async () => {
    const f = await fixture();
    const result = ensure(f);
    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(f.calls, "utf8");
    expect(calls).toContain("release create v1.2.3");
    expect(calls).not.toContain("--prerelease");
    expect(calls).toContain(`--target ${"a".repeat(40)}`);
  });

  it("reuses an existing release and dereferences annotated tags", async () => {
    const f = await fixture({ existing: true, annotated: true });
    const result = ensure(f);
    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(f.calls, "utf8");
    expect(calls).not.toContain("release create");
    expect(calls).toContain("/git/tags/");
  });

  it("marks prereleases and rejects a tag that resolves elsewhere", async () => {
    const prerelease = await fixture();
    const prereleaseResult = ensure(prerelease, "1.2.3-rc.1");
    expect(prereleaseResult.status, prereleaseResult.stderr).toBe(0);
    expect(await readFile(prerelease.calls, "utf8")).toContain("--prerelease");

    const mismatch = await fixture({ resolvedSha: "b".repeat(40) });
    const mismatchResult = ensure(mismatch);
    expect(mismatchResult.status).not.toBe(0);
    expect(mismatchResult.stderr).toContain("expected");
  });

  it.each([
    ['{"tagName":"v9.9.9","isDraft":false}', "tag mismatch"],
    ['{"tagName":"v1.2.3","isDraft":true}', "must not be a draft"],
  ])("rejects an invalid existing release: %s", async (releaseJson, error) => {
    const f = await fixture({ existing: true, releaseJson });
    const result = ensure(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  });
});

describe("reconcile-staged-assets", () => {
  const platformAssets = {
    macos_ready: [
      "Berd_1.2.3_darwin-aarch64.app.zip",
      "Berd_1.2.3_darwin-aarch64.dmg",
      "Berd_1.2.3_darwin-aarch64.app.tar.gz",
      "Berd_1.2.3_darwin-aarch64.app.tar.gz.sig",
      "Berd_1.2.3_darwin-aarch64.app.tar.gz.sha256",
      "Berd_1.2.3_darwin-aarch64.provenance.json",
    ],
    windows_ready: [
      "Berd_1.2.3_windows-x86_64-setup.exe",
      "Berd_1.2.3_windows-x86_64-setup.nsis.zip",
      "Berd_1.2.3_windows-x86_64-setup.nsis.zip.sig",
      "Berd_1.2.3_windows-x86_64-setup.nsis.zip.sha256",
      "Berd_1.2.3_windows-x86_64.provenance.json",
    ],
    linux_ready: [
      "Berd_1.2.3_linux-x86_64.AppImage",
      "Berd_1.2.3_linux-x86_64.deb",
      "Berd_1.2.3_linux-x86_64.rpm",
      "Berd_1.2.3_linux-x86_64.AppImage.tar.gz",
      "Berd_1.2.3_linux-x86_64.AppImage.tar.gz.sig",
      "Berd_1.2.3_linux-x86_64.AppImage.tar.gz.sha256",
      "Berd_1.2.3_linux-x86_64.provenance.json",
    ],
  };

  async function fixture(assets) {
    const dir = await tempDir();
    const bin = join(dir, "bin");
    const calls = join(dir, "calls");
    const state = join(dir, "assets");
    const output = join(dir, "output");
    await mkdir(bin);
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1 $2" == "release view" ]]; then
  cat "$ASSET_STATE"
elif [[ "$1 $2" == "release delete-asset" ]]; then
  name="$4"
  grep -Fxv "$name" "$ASSET_STATE" > "$ASSET_STATE.next" || true
  mv "$ASSET_STATE.next" "$ASSET_STATE"
else
  exit 1
fi
`,
      { mode: 0o755 },
    );
    await writeFile(state, `${assets.join("\n")}\n`);
    return { bin, calls, state, output };
  }

  function reconcile(f) {
    return run(
      "scripts/release/github/reconcile-staged-assets.sh",
      ["squareup/berd", "v1.2.3", "1.2.3", f.output],
      {
        PATH: `${f.bin}:${process.env.PATH}`,
        CALLS: f.calls,
        ASSET_STATE: f.state,
        GH_TOKEN: "test-token",
        ...releaseRepositoryEnv,
      },
    );
  }

  it("reports complete and absent payloads without mutation", async () => {
    const f = await fixture(platformAssets.macos_ready);
    const result = reconcile(f);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(f.output, "utf8")).toBe(
      "macos_ready=true\nwindows_ready=false\nlinux_ready=false\n",
    );
    expect(await readFile(f.calls, "utf8")).not.toContain("delete-asset");
  });

  it("deletes every present asset in a partial platform payload", async () => {
    const partial = platformAssets.linux_ready.slice(0, 3);
    const f = await fixture(partial);
    const result = reconcile(f);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(f.output, "utf8")).toContain("linux_ready=false");
    const calls = await readFile(f.calls, "utf8");
    expect(calls.match(/release delete-asset/g)).toHaveLength(partial.length);
    for (const name of partial) expect(calls).toContain(name);
    expect(await readFile(f.state, "utf8")).toBe("");
  });
});

describe("upload-immutable-assets", () => {
  async function fixture(existingAssets = {}) {
    const dir = await tempDir();
    const remote = join(dir, "remote");
    const bin = join(dir, "bin");
    const assetDir = join(dir, "assets");
    const calls = join(dir, "calls");
    await mkdir(remote);
    await mkdir(bin);
    await mkdir(assetDir);
    for (const [name, contents] of Object.entries(existingAssets)) {
      await writeFile(join(remote, name), contents);
    }
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS"
[[ "$1 $2" == "release download" || "$1 $2" == "release upload" || "$1" == "api" ]]
if [[ "$1" == "api" ]]; then
  for path in "$REMOTE"/*; do
    [[ -f "$path" ]] && basename "$path"
  done
elif [[ "$2" == "download" ]]; then
  output=""
  pattern=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --output) output="$2"; shift 2 ;;
      --pattern) pattern="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  # Reproduce gh's real refusal so a mktemp-created output regresses this test.
  [[ ! -e "$output" ]] || { echo "$output already exists" >&2; exit 1; }
  [[ -f "$REMOTE/$pattern" ]] || exit 1
  cp "$REMOTE/$pattern" "$output"
else
  asset="\${@: -1}"
  cp "$asset" "$REMOTE/$(basename "$asset")"
fi
`,
      { mode: 0o755 },
    );
    return { dir, remote, bin, assetDir, calls };
  }

  function upload(fixture, assets) {
    return run(
      "scripts/release/github/upload-immutable-assets.sh",
      ["squareup/berd", "v1.2.3", ...assets],
      {
        PATH: `${fixture.bin}:${process.env.PATH}`,
        REMOTE: fixture.remote,
        CALLS: fixture.calls,
      },
    );
  }

  it("downloads an existing asset to an absent path and accepts identical bytes", async () => {
    const f = await fixture({ "archive.tar.gz": "same" });
    const asset = join(f.assetDir, "archive.tar.gz");
    await writeFile(asset, "same");
    const result = upload(f, [asset]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("verified existing immutable asset");
    expect(await readFile(f.calls, "utf8")).not.toContain("release upload");
  });

  it("rejects an existing asset with conflicting bytes", async () => {
    const f = await fixture({ "archive.tar.gz": "old" });
    const asset = join(f.assetDir, "archive.tar.gz");
    await writeFile(asset, "new");
    const result = upload(f, [asset]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("different bytes");
    expect(await readFile(f.calls, "utf8")).not.toContain("release upload");
  });

  it("fills only missing assets in a partially staged release", async () => {
    const f = await fixture({ "existing.tar.gz": "same" });
    const existing = join(f.assetDir, "existing.tar.gz");
    const missing = join(f.assetDir, "missing.tar.gz");
    await writeFile(existing, "same");
    await writeFile(missing, "new");
    const result = upload(f, [existing, missing]);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(f.remote, "missing.tar.gz"), "utf8")).toBe(
      "new",
    );
    const calls = await readFile(f.calls, "utf8");
    expect(calls.match(/^release upload.*$/gm)).toHaveLength(1);
    expect(calls).toContain(missing);
  });
});

describe("verify-release-ref", () => {
  it("binds HEAD, a local tag, and the canonical remote tag", async () => {
    const dir = await tempDir();
    const remote = join(dir, "remote.git");
    const checkout = join(dir, "checkout");
    expect(run("git", ["init", "--bare", remote]).status).toBe(0);
    expect(run("git", ["init", checkout]).status).toBe(0);
    const git = (args) =>
      spawnSync("git", args, {
        cwd: checkout,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    expect(git(["config", "user.name", "Release Test"]).status).toBe(0);
    expect(git(["config", "user.email", "release@example.test"]).status).toBe(
      0,
    );
    await writeFile(join(checkout, "source"), "immutable");
    expect(git(["add", "source"]).status).toBe(0);
    expect(git(["commit", "-m", "source"]).status).toBe(0);
    expect(git(["tag", "--no-sign", "v1.2.3"]).status).toBe(0);
    expect(git(["remote", "add", "origin", remote]).status).toBe(0);
    expect(git(["push", "origin", "HEAD", "refs/tags/v1.2.3"]).status).toBe(0);
    const verifyEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/tags/v1.2.3",
    };

    const result = spawnSync(
      resolve(repo, "scripts/release/github/verify-release-ref.sh"),
      ["v1.2.3"],
      {
        cwd: checkout,
        encoding: "utf8",
        env: verifyEnv,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    await writeFile(join(checkout, "source"), "moved");
    expect(git(["add", "source"]).status).toBe(0);
    expect(git(["commit", "-m", "moved"]).status).toBe(0);
    const mismatch = spawnSync(
      resolve(repo, "scripts/release/github/verify-release-ref.sh"),
      ["v1.2.3"],
      {
        cwd: checkout,
        encoding: "utf8",
        env: verifyEnv,
      },
    );
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("does not match");
  });
});

describe("verify-versioned-release", () => {
  async function fixture({ missing = "", tagSha = "a".repeat(40) } = {}) {
    const dir = await tempDir();
    const bin = join(dir, "bin");
    await mkdir(bin);
    const names = [
      "Berd_1.2.3_darwin-aarch64.app.zip",
      "Berd_1.2.3_darwin-aarch64.dmg",
      "Berd_1.2.3_darwin-aarch64.app.tar.gz",
      "Berd_1.2.3_darwin-aarch64.app.tar.gz.sig",
      "Berd_1.2.3_darwin-aarch64.app.tar.gz.sha256",
      "Berd_1.2.3_darwin-aarch64.provenance.json",
    ].filter((name) => name !== missing);
    const artifactContents = Object.fromEntries(
      names
        .filter((name) => !name.endsWith(".provenance.json"))
        .map((name) => [name, `artifact:${name}`]),
    );
    const provenance = JSON.stringify({
      schemaVersion: 1,
      sourceSha: tagSha,
      version: "1.2.3",
      platform: "darwin-aarch64",
      artifacts: Object.fromEntries(
        Object.entries(artifactContents).map(([name, contents]) => [
          name,
          createHash("sha256").update(contents).digest("hex"),
        ]),
      ),
    });
    const artifactContentsBase64 = Buffer.from(
      JSON.stringify({
        ...artifactContents,
        "Berd_1.2.3_darwin-aarch64.provenance.json": provenance,
      }),
    ).toString("base64");
    const release = join(dir, "release.json");
    await writeFile(release, "placeholder");
    const releaseJson = JSON.stringify({
      tagName: "v1.2.3",
      isDraft: false,
      assets: names.map((name) => ({ name, size: 1 })),
    });
    const releaseJsonBase64 = Buffer.from(releaseJson).toString("base64");
    const calls = join(dir, "gh-calls");
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_CALLS"
if [[ "$1 $2" == "release view" ]]; then
  printf %s "$RELEASE_JSON_BASE64" | base64 --decode
elif [[ "$1 $2" == "release download" ]]; then
  output=""
  pattern=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --output) output="$2"; shift 2 ;;
      --pattern) pattern="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  printf %s "$ARTIFACT_CONTENTS_BASE64" | base64 --decode | jq -jr --arg name "$pattern" '.[$name]' > "$output"
elif [[ "$1 $2" == "attestation verify" ]]; then
  [[ "$*" == *"--source-digest $TAG_SHA"* ]]
  [[ "$*" == *"--source-ref refs/tags/v1.2.3"* ]]
elif [[ "$1" == "api" && "$2" == */git/ref/tags/* ]]; then
  case "$*" in
    *object.type*) printf commit ;;
    *) printf %s "$TAG_SHA" ;;
  esac
else
  exit 1
fi
`,
      { mode: 0o755 },
    );
    return {
      bin,
      release,
      releaseJsonBase64,
      artifactContentsBase64,
      tagSha,
      calls,
    };
  }

  function verify(f) {
    return run(
      "scripts/release/github/verify-versioned-release.sh",
      ["v1.2.3", "a".repeat(40)],
      {
        PATH: `${f.bin}:${process.env.PATH}`,
        RELEASE_JSON: f.release,
        RELEASE_JSON_BASE64: f.releaseJsonBase64,
        ARTIFACT_CONTENTS_BASE64: f.artifactContentsBase64,
        TAG_SHA: f.tagSha,
        GH_CALLS: f.calls,
        GH_PAGER: "/bin/cat",
        PAGER: "/bin/cat",
        GH_TOKEN: "test-token",
        REPOSITORY: "squareup/berd",
        VERSION: "1.2.3",
        PLATFORM: "darwin-aarch64",
      },
    );
  }

  it("accepts one non-empty copy of every expected immutable asset", async () => {
    const f = await fixture();
    const result = verify(f);
    expect(
      result.status,
      `${result.stderr}\n${await readFile(f.calls, "utf8")}`,
    ).toBe(0);
  });

  it("rejects an incomplete staged asset set", async () => {
    const result = verify(
      await fixture({ missing: "Berd_1.2.3_darwin-aarch64.app.tar.gz.sig" }),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exactly one non-empty asset");
  });

  it("rejects old release bytes renamed under the requested version", async () => {
    const f = await fixture();
    const contents = JSON.parse(
      Buffer.from(f.artifactContentsBase64, "base64").toString("utf8"),
    );
    contents["Berd_1.2.3_darwin-aarch64.app.tar.gz"] =
      "validly-signed-archive-from-1.2.2";
    f.artifactContentsBase64 = Buffer.from(JSON.stringify(contents)).toString(
      "base64",
    );
    const result = verify(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("provenance digest mismatch");
  });

  it("rejects a release whose remote tag moved", async () => {
    const result = verify(await fixture({ tagSha: "b".repeat(40) }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected");
  });
});

describe("promote-updater", () => {
  async function fixture({
    publishedDigestMatches = true,
    signatureValid = true,
    currentVersion = null,
    recheckedVersion = currentVersion,
    preflightStatus = currentVersion ? 200 : 404,
    recheckStatus = recheckedVersion ? 200 : 404,
  } = {}) {
    const dir = await tempDir();
    const bin = join(dir, "bin");
    const staged = join(dir, "staged");
    const calls = join(dir, "calls");
    await mkdir(bin);
    await mkdir(join(staged, "Berd.app", "Contents"), { recursive: true });
    await writeFile(join(staged, "Berd.app", "Contents", "marker"), "signed");
    const archive = join(dir, "Berd_1.2.3_darwin-aarch64.app.tar.gz");
    expect(
      spawnSync("tar", ["-C", staged, "-czf", archive, "Berd.app"]).status,
    ).toBe(0);
    await writeFile(`${archive}.sig`, "signature");
    const digest = run("shasum", ["-a", "256", archive]).stdout.split(/\s+/)[0];
    await writeFile(
      `${archive}.sha256`,
      `${digest}  ${archive.split("/").at(-1)}\n`,
    );
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1 $2" == "release download" ]]; then
  dir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in --dir) dir="$2"; shift 2 ;; *) shift ;; esac
  done
  cp "$STAGED_ARCHIVE" "$STAGED_ARCHIVE.sig" "$STAGED_ARCHIVE.sha256" "$dir/"
elif [[ "$1 $2" == "release view" ]]; then
  exit 0
elif [[ "$1 $2" == "release upload" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == */latest.json ]]; then cp "$arg" "$PUBLISHED_MANIFEST"; fi
  done
else
  exit 1
fi
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, "cargo"),
      `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *"updater-signature-verifier"* ]]
[[ "$SIGNATURE_VALID" == true ]]
`,
      { mode: 0o755 },
    );
    const currentManifest = join(dir, "current-manifest.json");
    const recheckedManifest = join(dir, "rechecked-manifest.json");
    if (currentVersion) {
      await writeFile(
        currentManifest,
        JSON.stringify({ version: currentVersion }),
      );
      await writeFile(
        recheckedManifest,
        JSON.stringify({ version: recheckedVersion }),
      );
    }
    await writeFile(
      join(bin, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
output=""
write_out=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    --write-out) write_out=true; shift 2 ;;
    *) shift ;;
  esac
done
status=200
if [[ "$output" == *current-latest.json ]]; then
  status="$PREFLIGHT_STATUS"
  if [[ "$status" == 200 ]]; then cp "$REMOTE_CURRENT_MANIFEST" "$output"; fi
elif [[ "$output" == *rechecked-latest.json ]]; then
  status="$RECHECK_STATUS"
  if [[ "$status" == 200 ]]; then cp "$REMOTE_RECHECKED_MANIFEST" "$output"; fi
elif [[ "$output" == *published-latest.json ]]; then
  cp "$PUBLISHED_MANIFEST" "$output"
elif [[ "$PUBLISHED_DIGEST_MATCHES" == true ]]; then
  cp "$STAGED_ARCHIVE" "$output"
else
  printf tampered > "$output"
fi
[[ "$write_out" == false ]] || printf %s "$status"
`,
      { mode: 0o755 },
    );
    const channelConfig = join(dir, "release-channel.json");
    await writeFile(
      channelConfig,
      JSON.stringify({
        repository: "squareup/berd",
        rollingTag: "berd-desktop-latest",
        platforms: ["darwin-aarch64"],
      }),
    );
    return {
      dir,
      bin,
      archive,
      calls,
      channelConfig,
      publishedDigestMatches,
      signatureValid,
      preflightStatus,
      recheckStatus,
      publishedManifest: join(dir, "published-latest.json"),
      currentManifest,
      recheckedManifest,
    };
  }

  function promote(f) {
    return run(
      "scripts/release/github/promote-updater.sh",
      ["v1.2.3", "a".repeat(40), join(f.dir, "summary.md")],
      {
        PATH: `${f.bin}:${process.env.PATH}`,
        GH_TOKEN: "test-token",
        BERD_UPDATER_PUBLIC_KEY: "test-public-key",
        GITHUB_REPOSITORY: "squareup/berd",
        STAGED_ARCHIVE: f.archive,
        CALLS: f.calls,
        PUBLISHED_MANIFEST: f.publishedManifest,
        REMOTE_CURRENT_MANIFEST: f.currentManifest,
        REMOTE_RECHECKED_MANIFEST: f.recheckedManifest,
        PUBLISHED_DIGEST_MATCHES: String(f.publishedDigestMatches),
        SIGNATURE_VALID: String(f.signatureValid),
        PREFLIGHT_STATUS: String(f.preflightStatus),
        RECHECK_STATUS: String(f.recheckStatus),
        BERD_PROMOTION_RETRY_DELAY_SECONDS: "0",
        BERD_RELEASE_CHANNEL_CONFIG: f.channelConfig,
      },
    );
  }

  it("uploads latest.json only after published archive verification", async () => {
    const f = await fixture();
    const result = promote(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = (await readFile(f.calls, "utf8")).trim().split("\n");
    expect(calls.at(-1)).toContain("latest.json");
    expect(
      JSON.parse(await readFile(f.publishedManifest, "utf8")).version,
    ).toBe("1.2.3");
  });

  it("rejects downgrade and stale rolling-manifest state", async () => {
    const downgrade = await fixture({ currentVersion: "1.2.4" });
    const downgradeResult = promote(downgrade);
    expect(downgradeResult.status).not.toBe(0);
    expect(downgradeResult.stderr).toContain("refusing updater downgrade");
    expect(await readFile(downgrade.calls, "utf8")).not.toContain(
      "release upload",
    );

    const stale = await fixture({
      currentVersion: "1.2.2",
      recheckedVersion: "1.2.2-hotfix.1",
    });
    const staleResult = promote(stale);
    expect(staleResult.status).not.toBe(0);
    expect(staleResult.stderr).toContain(
      "updater manifest changed during promotion",
    );
    const staleCalls = (await readFile(stale.calls, "utf8")).split("\n");
    expect(
      staleCalls.filter((call) => call.includes("latest.json")),
    ).toHaveLength(0);
  });

  it("fails closed on manifest server errors before the final feed upload", async () => {
    const preflightFailure = await fixture({ preflightStatus: 503 });
    const preflightResult = promote(preflightFailure);
    expect(preflightResult.status).not.toBe(0);
    expect(preflightResult.stderr).toContain("HTTP 503 during preflight");
    expect(await readFile(preflightFailure.calls, "utf8")).not.toContain(
      "latest.json",
    );

    const recheckFailure = await fixture({ recheckStatus: 503 });
    const recheckResult = promote(recheckFailure);
    expect(recheckResult.status).not.toBe(0);
    expect(recheckResult.stderr).toContain("HTTP 503 during recheck");
    const calls = await readFile(recheckFailure.calls, "utf8");
    expect(calls).not.toContain("latest.json");
  });

  it("rejects an invalid updater signature before mutating the rolling release", async () => {
    const f = await fixture({ signatureValid: false });
    const result = promote(f);
    expect(result.status).not.toBe(0);
    const calls = await readFile(f.calls, "utf8");
    expect(calls).not.toContain("release upload");
  });

  it("leaves latest.json untouched when anonymous bytes do not match", async () => {
    const f = await fixture({ publishedDigestMatches: false });
    const result = promote(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not publicly accessible");
    const calls = await readFile(f.calls, "utf8");
    expect(calls).not.toContain("latest.json");
  });
});

describe("Block feature gate propagation", () => {
  it("maps every updater-off default to the fail-closed Cargo posture", () => {
    const result = run("bash", ["scripts/block-feature-gates.sh", "berdctl"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("berdctl,no-voice-dictation");
  });

  it("maps the six independent renderer gates to matching Cargo features", () => {
    const env = {
      VITE_AGENT_TOOLS: "1",
      VITE_AUTOMATIONS: "1",
      VITE_BUILDERBOT: "1",
      VITE_FEEDBACK: "1",
      VITE_MANAGED_CONNECTIONS: "1",
      VITE_VOICE_DICTATION: "1",
    };
    const result = run(
      "bash",
      ["scripts/block-feature-gates.sh", "berdctl,app-test-driver"],
      env,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(",")).toEqual([
      "berdctl",
      "app-test-driver",
      "block-agent-tools",
      "block-automations",
      "block-builderbot",
      "block-feedback",
      "block-managed-connections",
      "block-voice-dictation",
    ]);
  });

  it("rejects ambiguous gate values instead of desynchronizing renderer and Rust", () => {
    const result = run("bash", ["scripts/block-feature-gates.sh", "berdctl"], {
      VITE_AUTOMATIONS: "true",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("VITE_AUTOMATIONS must be 0 or 1");
  });
});
