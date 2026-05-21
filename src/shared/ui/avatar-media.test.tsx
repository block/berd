import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AvatarMedia } from "./avatar-media";

type ObserverCallback = (
  entries: IntersectionObserverEntry[],
  observer: IntersectionObserver,
) => void;

let observerCallback: ObserverCallback | undefined;
const observeMock = vi.fn();
const disconnectMock = vi.fn();
const playMock = vi.fn();
const pauseMock = vi.fn();
const loadMock = vi.fn();

class MockIntersectionObserver {
  constructor(callback: ObserverCallback) {
    observerCallback = callback;
  }

  disconnect = disconnectMock;
  observe = observeMock;
  takeRecords = () => [];
  unobserve = vi.fn();
}

function emitIntersection(isIntersecting: boolean) {
  if (!observerCallback) {
    throw new Error("IntersectionObserver was not created");
  }

  act(() => {
    observerCallback?.(
      [{ isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
}

describe("AvatarMedia", () => {
  beforeEach(() => {
    observerCallback = undefined;
    vi.clearAllMocks();

    window.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;

    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => {
      playMock();
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
      pauseMock();
    });
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {
      loadMock();
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("attaches, plays, pauses, and detaches visible-video sources with intersection", async () => {
    render(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="visible-video"
        poster="asset://localhost/avatar.png"
      />,
    );

    const video = screen.getByRole("img", { name: "avatar" });

    expect(video).toHaveAttribute("preload", "none");
    expect(video).toHaveAttribute("poster", "asset://localhost/avatar.png");
    expect(video).not.toHaveAttribute("src");
    expect(observeMock).toHaveBeenCalledWith(video);

    emitIntersection(true);

    await waitFor(() =>
      expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4"),
    );
    expect(playMock).toHaveBeenCalledTimes(1);

    emitIntersection(false);

    await waitFor(() => expect(video).not.toHaveAttribute("src"));
    expect(pauseMock).toHaveBeenCalled();
    expect(loadMock).toHaveBeenCalled();
  });
});
