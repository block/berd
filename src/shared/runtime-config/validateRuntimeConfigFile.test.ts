import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG_PATH,
  parseRuntimeConfigCliArgs,
  validateRuntimeConfigFile,
} from "../../../scripts/validate-runtime-config";

// The committed base config the release build deep-merges custom overrides
// onto; resolved relative to the repo root (vitest's cwd).
const BASE_CONFIG_PATH = "src-tauri/resources/runtime-config.json";

describe("validateRuntimeConfigFile", () => {
  let dir: string;
  let base: Record<string, unknown>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "runtime-config-validate-"));
    base = JSON.parse(readFileSync(BASE_CONFIG_PATH, "utf8"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  }

  it("accepts the committed base config", () => {
    const result = validateRuntimeConfigFile(BASE_CONFIG_PATH);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("defaults CLI validation to the committed base config", () => {
    expect(parseRuntimeConfigCliArgs([])).toEqual({
      ok: true,
      knownToggleKeysOnly: false,
      target: DEFAULT_RUNTIME_CONFIG_PATH,
    });
  });

  it("rejects unknown CLI flags", () => {
    expect(parseRuntimeConfigCliArgs(["--bogus"])).toEqual({
      ok: false,
      errors: ["unknown option: --bogus"],
    });
  });

  it("rejects multiple positional CLI config paths", () => {
    expect(
      parseRuntimeConfigCliArgs([
        BASE_CONFIG_PATH,
        join(dir, "other-runtime-config.json"),
      ]),
    ).toEqual({
      ok: false,
      errors: [
        expect.stringContaining(
          "expected at most one runtime-config path, got 2",
        ),
      ],
    });
  });

  it("accepts a config carrying merged featureToggles", () => {
    const merged = {
      ...base,
      featureToggles: {
        voiceDictation: false,
        telemetry: false,
        automations: false,
      },
    };
    const path = writeFixture("merged.json", JSON.stringify(merged));
    expect(validateRuntimeConfigFile(path).ok).toBe(true);
  });

  it("rejects an unknown top-level key (typo'd override)", () => {
    const path = writeFixture(
      "unknown-top.json",
      JSON.stringify({ ...base, featureTogglez: { voiceDictation: false } }),
    );
    const result = validateRuntimeConfigFile(path);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects an unknown nested key", () => {
    const path = writeFixture(
      "unknown-nested.json",
      JSON.stringify({
        ...base,
        goose: { ...(base.goose as object), bogus: true },
      }),
    );
    const result = validateRuntimeConfigFile(path);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a non-boolean featureToggle value", () => {
    const path = writeFixture(
      "bad-toggle.json",
      JSON.stringify({ ...base, featureToggles: { voiceDictation: "false" } }),
    );
    expect(validateRuntimeConfigFile(path).ok).toBe(false);
  });

  it("accepts a misspelled toggle KEY without --strict-toggles (free-form record)", () => {
    // featureToggles is a free-form record<string, boolean>, so the schema
    // alone cannot catch a fat-fingered key; only custom builds opt into the
    // stricter check below.
    const path = writeFixture(
      "typo-toggle-lax.json",
      JSON.stringify({ ...base, featureToggles: { voiceDictaton: false } }),
    );
    expect(validateRuntimeConfigFile(path).ok).toBe(true);
  });

  it("rejects a misspelled toggle KEY with knownToggleKeysOnly", () => {
    const path = writeFixture(
      "typo-toggle-strict.json",
      JSON.stringify({ ...base, featureToggles: { voiceDictaton: false } }),
    );
    const result = validateRuntimeConfigFile(path, {
      knownToggleKeysOnly: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining(
        "featureToggles.voiceDictaton: unknown toggle key",
      ),
    ]);
  });

  it("accepts recognized toggle keys with knownToggleKeysOnly", () => {
    const path = writeFixture(
      "known-toggles-strict.json",
      JSON.stringify({
        ...base,
        featureToggles: {
          voiceDictation: false,
          telemetry: false,
          costTracking: false,
        },
      }),
    );
    expect(
      validateRuntimeConfigFile(path, { knownToggleKeysOnly: true }).ok,
    ).toBe(true);
  });

  it("rejects malformed JSON", () => {
    const path = writeFixture("malformed.json", "{ not json");
    const result = validateRuntimeConfigFile(path);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("invalid JSON");
  });

  it("reports a read failure for a missing file", () => {
    const result = validateRuntimeConfigFile(join(dir, "missing.json"));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("failed to read");
  });
});
