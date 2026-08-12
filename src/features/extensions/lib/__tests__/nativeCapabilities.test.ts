import { describe, expect, it } from "vitest";
import type { ExtensionEntry } from "../../types";
import { isNativeCapabilityExtension } from "../nativeCapabilities";

function extension(
  name: string,
  type: ExtensionEntry["type"],
  overrides: Partial<ExtensionEntry> = {},
): ExtensionEntry {
  return {
    type,
    name,
    description: "",
    config_key: name.toLowerCase().replace(/[^a-z0-9]/g, ""),
    enabled: true,
    ...(type === "stdio" ? { cmd: "npx", args: [] } : {}),
    ...(type === "streamable_http" ? { uri: "http://localhost:3000/mcp" } : {}),
    ...overrides,
  } as ExtensionEntry;
}

describe("isNativeCapabilityExtension", () => {
  it("treats builtin and platform extensions as native capabilities", () => {
    expect(isNativeCapabilityExtension(extension("developer", "builtin"))).toBe(
      true,
    );
    expect(isNativeCapabilityExtension(extension("todo", "platform"))).toBe(
      true,
    );
  });

  it("treats bundled general-purpose tools as native capabilities", () => {
    expect(
      isNativeCapabilityExtension(
        extension("Codesearch", "stdio", { bundled: true }),
      ),
    ).toBe(true);
    expect(
      isNativeCapabilityExtension(
        extension("datadiscovery", "stdio", { bundled: true }),
      ),
    ).toBe(true);
    expect(
      isNativeCapabilityExtension(
        extension("Image Generator", "stdio", { bundled: true }),
      ),
    ).toBe(true);
    expect(
      isNativeCapabilityExtension(
        extension("PDF Reader", "stdio", { bundled: true }),
      ),
    ).toBe(true);
    expect(
      isNativeCapabilityExtension(
        extension("Web Search", "stdio", { bundled: true }),
      ),
    ).toBe(true);
  });

  it("matches bundled native tools on config_key when the display name differs", () => {
    expect(
      isNativeCapabilityExtension(
        extension("Some Renamed Tool", "stdio", {
          bundled: true,
          config_key: "pdfreader",
        }),
      ),
    ).toBe(true);
  });

  it("keeps user-added MCPs visible even when their names match native tools", () => {
    expect(isNativeCapabilityExtension(extension("Web Search", "stdio"))).toBe(
      false,
    );
    expect(
      isNativeCapabilityExtension(
        extension("Some Renamed Tool", "stdio", { config_key: "pdfreader" }),
      ),
    ).toBe(false);
  });

  it("keeps linked-account connections visible", () => {
    expect(
      isNativeCapabilityExtension(extension("Google Drive", "stdio")),
    ).toBe(false);
    expect(isNativeCapabilityExtension(extension("Figma", "stdio"))).toBe(
      false,
    );
    expect(isNativeCapabilityExtension(extension("Linear", "stdio"))).toBe(
      false,
    );
    expect(
      isNativeCapabilityExtension(
        extension("my-custom-mcp", "streamable_http"),
      ),
    ).toBe(false);
  });
});
