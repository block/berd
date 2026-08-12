import { describe, expect, it } from "vitest";
import { filterStartupProvidersForRuntimeConfig } from "./useAppStartup";

const providers = [
  { id: "goose", label: "Goose" },
  { id: "codex-acp", label: "Codex" },
];

describe("filterStartupProvidersForRuntimeConfig", () => {
  it("keeps providers when no allowlist is configured", () => {
    expect(filterStartupProvidersForRuntimeConfig(providers, null, [])).toEqual(
      providers,
    );
  });

  it("removes Goose when an allowlist exists but no allowed model provider is known", () => {
    expect(
      filterStartupProvidersForRuntimeConfig(
        providers,
        new Set(["anthropic"]),
        [],
      ),
    ).toEqual([{ id: "codex-acp", label: "Codex" }]);
  });

  it("keeps Goose when an allowed model provider exists", () => {
    expect(
      filterStartupProvidersForRuntimeConfig(
        providers,
        new Set(["anthropic"]),
        [{ id: "anthropic" }],
      ),
    ).toEqual(providers);
  });

  it("removes Goose when no model provider is allowed", () => {
    expect(
      filterStartupProvidersForRuntimeConfig(
        providers,
        new Set(["anthropic"]),
        [{ id: "openai" }],
      ),
    ).toEqual([{ id: "codex-acp", label: "Codex" }]);
  });
});
