import { describe, expect, it } from "vitest";
import type { ExtensionEntry } from "@/features/extensions/types";
import {
  getCompanyManagedExtensionKeys,
  isCompanyManagedExtension,
} from "../managedExtensions";

function stdioExtension(name: string, configKey = name): ExtensionEntry {
  return {
    type: "stdio",
    name,
    description: "",
    cmd: "npx",
    args: [],
    config_key: configKey,
    enabled: true,
  };
}

describe("managed extensions", () => {
  it("matches local extensions covered by the company-managed catalog", () => {
    expect(isCompanyManagedExtension(stdioExtension("Airtable"))).toBe(true);
    expect(isCompanyManagedExtension(stdioExtension("Google Drive"))).toBe(
      true,
    );
    expect(isCompanyManagedExtension(stdioExtension("Query Expert"))).toBe(
      true,
    );
  });

  it("does not hide hidden providers or custom extensions", () => {
    expect(isCompanyManagedExtension(stdioExtension("GitHub"))).toBe(false);
    expect(isCompanyManagedExtension(stdioExtension("Block App Kit"))).toBe(
      false,
    );
  });

  it("returns config keys for extensions that should defer to Connections", () => {
    expect(
      getCompanyManagedExtensionKeys([
        stdioExtension("Airtable", "airtable"),
        stdioExtension("GitHub", "github"),
        stdioExtension("Block App Kit", "block-app-kit"),
      ]),
    ).toEqual(["airtable"]);
  });
});
