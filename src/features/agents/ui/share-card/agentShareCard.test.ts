import { afterEach, describe, expect, it, vi } from "vitest";
import type { Persona } from "@/shared/types/agents";
import {
  AVATAR_VIDEO_LOAD_TIMEOUT_MS,
  getAgentShareDescription,
  getAgentShareFilename,
  loadAvatarVideo,
  loadShareCardImage,
  SHARE_CARD_IMAGE_LOAD_TIMEOUT_MS,
  wrapShareCardText,
} from "./agentShareCard";

const persona: Persona = {
  id: "/agents/reviewer.md",
  displayName: "Reviewer",
  systemPrompt: "Review code carefully.",
  isBuiltin: false,
  writable: true,
};

function contextWithCharacterWidth(width: number): CanvasRenderingContext2D {
  return {
    measureText: vi.fn((text: string) => ({ width: text.length * width })),
  } as unknown as CanvasRenderingContext2D;
}

describe("agentShareCard", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("times out stalled images and ignores late events", async () => {
    vi.useFakeTimers();
    const image = document.createElement("img");
    const removeAttribute = vi.spyOn(image, "removeAttribute");
    const ImageConstructor = vi.fn(function ImageConstructor() {
      return image;
    });
    vi.stubGlobal("Image", ImageConstructor);

    const loading = loadShareCardImage("https://example.com/stalled.png");
    const rejection = expect(loading).rejects.toThrow(
      "Share card image loading timed out",
    );
    const lateLoaded = image.onload;
    await vi.advanceTimersByTimeAsync(SHARE_CARD_IMAGE_LOAD_TIMEOUT_MS);

    await rejection;
    expect(removeAttribute).toHaveBeenCalledWith("src");
    expect(image.onload).toBeNull();
    lateLoaded?.call(image, new Event("load"));
  });

  it("times out stalled avatar videos and ignores late events", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    const removeAttribute = vi.spyOn(video, "removeAttribute");
    vi.spyOn(video, "load").mockImplementation(() => undefined);
    vi.spyOn(document, "createElement").mockReturnValueOnce(video);

    const loading = loadAvatarVideo("asset://stalled-avatar.mp4");
    const rejection = expect(loading).rejects.toThrow(
      "Avatar video loading timed out",
    );
    const lateLoaded = video.onloadeddata;
    await vi.advanceTimersByTimeAsync(AVATAR_VIDEO_LOAD_TIMEOUT_MS);

    await rejection;
    expect(removeAttribute).toHaveBeenCalledWith("src");
    expect(video.onloadeddata).toBeNull();
    lateLoaded?.call(video, new Event("loadeddata"));
  });
  it("prefers an authored public description over instructions", () => {
    expect(
      getAgentShareDescription({
        ...persona,
        sourceDescription: "Unrelated metadata.",
        systemPrompt:
          "You are Reviewer. Your job is to review code carefully. Keep internal policy private.",
      }),
    ).toBe("Unrelated metadata.");
  });

  it("creates a safe bounded filename", () => {
    expect(getAgentShareFilename("  My Helpful Agent!  ")).toBe(
      "my-helpful-agent.agent.png",
    );
    expect(getAgentShareFilename("✨✨✨")).toBe("agent.agent.png");
  });

  it("clamps wrapped text and adds an ellipsis", () => {
    const lines = wrapShareCardText(
      contextWithCharacterWidth(10),
      "one two three four five six seven",
      90,
      2,
    );

    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/…$/);
    expect(lines.every((line) => line.length * 10 <= 90)).toBe(true);
  });

  it("clamps long unbroken words to the available width", () => {
    const lines = wrapShareCardText(
      contextWithCharacterWidth(10),
      "averylongunbrokenword",
      60,
      2,
    );

    expect(lines).toEqual(["averyl", "ongun…"]);
  });
});
