import { describe, expect, it } from "vitest";
import {
  extractToolResultImages,
  extractToolStructuredContent,
} from "../acpToolCallContent";

describe("extractToolResultImages", () => {
  it("returns [] when there is no content", () => {
    expect(extractToolResultImages({})).toEqual([]);
    expect(extractToolResultImages({ content: null })).toEqual([]);
    expect(extractToolResultImages({ content: [] })).toEqual([]);
  });

  it("ignores text-only tool results", () => {
    expect(
      extractToolResultImages({
        content: [{ type: "content", content: { type: "text", text: "hi" } }],
      }),
    ).toEqual([]);
  });

  it("extracts a base64 image block from a tool result", () => {
    expect(
      extractToolResultImages({
        content: [
          {
            type: "content",
            content: {
              type: "image",
              data: "iVBORw0KGgo=",
              mimeType: "image/png",
            },
          },
        ],
      }),
    ).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
  });

  it("preserves uri and annotations when present and extracts multiple images", () => {
    expect(
      extractToolResultImages({
        content: [
          { type: "content", content: { type: "text", text: "here:" } },
          {
            type: "content",
            content: {
              type: "image",
              data: "AAAA",
              mimeType: "image/png",
              uri: "file:///tmp/a.png",
              annotations: { audience: ["user"] },
            },
          },
          {
            type: "content",
            content: { type: "image", data: "BBBB", mimeType: "image/jpeg" },
          },
        ],
      }),
    ).toEqual([
      {
        type: "image",
        data: "AAAA",
        mimeType: "image/png",
        uri: "file:///tmp/a.png",
        annotations: { audience: ["user"] },
      },
      { type: "image", data: "BBBB", mimeType: "image/jpeg" },
    ]);
  });
});

describe("extractToolStructuredContent", () => {
  it.each([
    [{ restaurants: [{ name: "Coffee Shop" }] }, "object"],
    ["complete", "string"],
    [42, "number"],
    [false, "boolean"],
    [null, "null"],
  ])("preserves %s rawOutput values", (rawOutput, _label) => {
    expect(extractToolStructuredContent({ rawOutput })).toEqual(rawOutput);
  });

  it("returns undefined when rawOutput is absent", () => {
    expect(extractToolStructuredContent({})).toBeUndefined();
  });
});
