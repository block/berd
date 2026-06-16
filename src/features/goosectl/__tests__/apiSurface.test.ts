import { describe, expect, it } from "vitest";

import apiSurface from "../../../../src-tauri/crates/goosectl/api-surface.json";
import { buildApiSurfaceContract } from "@/features/goosectl/commands/contract";

/**
 * Freshness control between the renderer's command modules and the published
 * wire surface: api-surface.json pins every group/action's description,
 * wire fields (name/requiredness/kinds/bounds/descriptions), and args JSON
 * Schema, generated from the authoritative zod schemas by the same
 * introspection this test calls (contract.ts). The goosectl crate builds its
 * clap flags and wire mapping from the embedded file at startup, so a stale
 * artifact means a published surface that lies about the wire contract. CI
 * holds the same property byte-exactly (scripts/buildkite/js-checks.sh).
 */
describe("goosectl API surface contract", () => {
  it("checked-in api-surface.json is fresh (run `pnpm generate:goosectl-contract`)", () => {
    expect(
      JSON.parse(JSON.stringify(buildApiSurfaceContract())),
      "src-tauri/crates/goosectl/api-surface.json is stale; run " +
        "`pnpm generate:goosectl-contract` and commit the result",
    ).toEqual(apiSurface);
  });
});
