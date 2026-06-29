// @vitest-environment node

import { describe, expect, it } from "vitest";

describe("berdctl contract import purity", () => {
  it("builds contracts in node without browser globals", async () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;

    expect(typeof window).toBe("undefined");
    expect("localStorage" in globalThis).toBe(false);

    const { buildApiSurfaceContract, buildCliSurfaceContract } = await import(
      "@/features/berdctl/commands/contract"
    );

    const api = buildApiSurfaceContract();
    const cli = buildCliSurfaceContract();

    expect(api.groups.sessions.actions.create.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "prompt", required: true }),
      ]),
    );
    expect(cli.nouns.session.verbs.create.action).toBe("create");
  });
});
