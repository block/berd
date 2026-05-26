import { describe, expect, it, vi } from "vitest";
import { getImageFilesFromClipboardItems } from "./clipboardAttachments";

function clipboardItems(items: Partial<DataTransferItem>[]) {
  return items as unknown as DataTransferItemList;
}

describe("getImageFilesFromClipboardItems", () => {
  it("returns only non-null image file items", () => {
    const image = new File(["image"], "pasted.png", { type: "image/png" });
    const textFile = new File(["text"], "notes.txt", { type: "text/plain" });

    const files = getImageFilesFromClipboardItems(
      clipboardItems([
        {
          kind: "file",
          type: "image/png",
          getAsFile: vi.fn(() => image),
        },
        {
          kind: "file",
          type: "text/plain",
          getAsFile: vi.fn(() => textFile),
        },
        {
          kind: "string",
          type: "image/png",
          getAsFile: vi.fn(() => image),
        },
        {
          kind: "file",
          type: "image/jpeg",
          getAsFile: vi.fn(() => null),
        },
        {
          kind: "file",
          type: "",
          getAsFile: vi.fn(
            () => new File(["unknown"], "unknown", { type: "" }),
          ),
        },
      ]),
    );

    expect(files).toEqual([image]);
  });
});
