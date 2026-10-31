import { describe, expect, it, vi } from "vitest";
import schema from "../../../../sdk/schema/acp-schema.json";
import { GooseExtClient } from "../../../../sdk/src/generated/client.gen";
import { zGooseToolCallRequestUnstable } from "../../../../sdk/src/generated/zod.gen";

// Pinned backend source: aaif-goose/goose@7debb275d36559ee4e81799362e7f638275dfed3,
// crates/goose/acp-schema.json, $defs.GooseToolCallRequest_unstable.
const backendRequestSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    extensionName: { type: "string" },
    name: { type: "string" },
    arguments: { default: null },
  },
  required: ["sessionId", "extensionName", "name"],
  description: "Call a tool from an extension.",
  "x-side": "agent",
  "x-method": "_goose/unstable/tools/call",
};

const request = {
  sessionId: "wire-session",
  extensionName: "clock",
  name: "clock__get-time",
  arguments: {},
};

describe("MCP app tool call contract", () => {
  it("matches the pinned backend request schema", () => {
    expect(schema.$defs.GooseToolCallRequest_unstable).toEqual(
      backendRequestSchema,
    );
  });

  it("requires extensionName in the generated validator", () => {
    expect(zGooseToolCallRequestUnstable.parse(request)).toEqual(request);
    const { extensionName: _, ...missingExtension } = request;
    expect(
      zGooseToolCallRequestUnstable.safeParse(missingExtension).success,
    ).toBe(false);
    expect(
      zGooseToolCallRequestUnstable.safeParse({
        ...request,
        extensionName: 42,
      }).success,
    ).toBe(false);
  });

  it("preserves extensionName and the prefixed name on the wire", async () => {
    const extMethod = vi
      .fn()
      .mockResolvedValue({ content: [], isError: false });
    const client = new GooseExtClient({ extMethod });
    await client.GooseUnstableToolsCall(request);
    expect(extMethod).toHaveBeenCalledExactlyOnceWith(
      "_goose/unstable/tools/call",
      request,
    );
  });
});
