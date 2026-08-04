import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANIMATED_AVATARS_CHANGED_EVENT } from "@/shared/avatars/avatarPlaybackPreferences";
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
const originalMatchMedia = window.matchMedia;

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

function setPrefersReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function dispatchAnimatedAvatarsPreference(enabled: boolean) {
  localStorage.setItem("goose:animated-avatars-enabled", String(enabled));
  act(() => {
    window.dispatchEvent(
      new CustomEvent(ANIMATED_AVATARS_CHANGED_EVENT, {
        detail: { enabled },
      }),
    );
  });
}

describe("AvatarMedia", () => {
  beforeEach(() => {
    observerCallback = undefined;
    vi.clearAllMocks();
    localStorage.clear();
    setPrefersReducedMotion(false);

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
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.matchMedia = originalMatchMedia;
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
    expect(video).toHaveAttribute("loop");
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
  });

  it("keeps lazy-once video sources attached after they have become visible", async () => {
    render(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="lazy-once"
      />,
    );

    const video = screen.getByRole("img", { name: "avatar" });

    emitIntersection(true);
    await waitFor(() =>
      expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4"),
    );

    emitIntersection(false);

    expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4");
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("renders eager video sources on the first paint", () => {
    render(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="eager"
      />,
    );

    expect(screen.getByRole("img", { name: "avatar" })).toHaveAttribute(
      "src",
      "asset://localhost/avatar.mp4",
    );
  });

  it("attaches paused visible-video sources without looping when animation is disabled", async () => {
    localStorage.setItem("goose:animated-avatars-enabled", "false");

    render(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="visible-video"
      />,
    );

    const video = screen.getByRole("img", { name: "avatar" });

    expect(video).not.toHaveAttribute("loop");
    expect(video).toHaveAttribute("preload", "none");
    expect(video).not.toHaveAttribute("src");

    emitIntersection(true);

    await waitFor(() =>
      expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4"),
    );
    expect(video).toHaveAttribute("preload", "auto");
    expect(playMock).not.toHaveBeenCalled();
    expect(pauseMock).toHaveBeenCalled();
  });

  it("pauses and resumes a mounted visible video when animation preference changes", async () => {
    render(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="visible-video"
      />,
    );

    const video = screen.getByRole("img", { name: "avatar" });

    emitIntersection(true);

    await waitFor(() => expect(playMock).toHaveBeenCalledTimes(1));
    expect(video).toHaveAttribute("loop");

    dispatchAnimatedAvatarsPreference(false);

    await waitFor(() => expect(video).not.toHaveAttribute("loop"));
    expect(pauseMock).toHaveBeenCalled();

    dispatchAnimatedAvatarsPreference(true);

    await waitFor(() => expect(playMock).toHaveBeenCalledTimes(2));
    expect(video).toHaveAttribute("loop");
  });

  it("does not autoplay video avatars when reduced motion is preferred", async () => {
    setPrefersReducedMotion(true);

    render(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="visible-video"
      />,
    );

    const video = screen.getByRole("img", { name: "avatar" });

    expect(video).not.toHaveAttribute("loop");

    emitIntersection(true);

    await waitFor(() =>
      expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4"),
    );
    expect(playMock).not.toHaveBeenCalled();
    expect(pauseMock).toHaveBeenCalled();
  });

  it("plays occasional avatars once, then waits before replaying", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    render(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="eager"
        playbackMode="occasional"
      />,
    );

    const video = screen.getByRole("img", { name: "avatar" });
    expect(video).not.toHaveAttribute("loop");
    expect(playMock).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(750));
    expect(playMock).toHaveBeenCalledTimes(1);

    act(() => video.dispatchEvent(new Event("ended")));
    await act(async () => vi.advanceTimersByTime(7_999));
    expect(playMock).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTime(1));
    expect(playMock).toHaveBeenCalledTimes(2);
  });

  it("preloads occasional video while it is visible", async () => {
    render(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="visible-video"
        playbackMode="occasional"
      />,
    );

    const video = screen.getByRole("img", { name: "avatar" });
    emitIntersection(true);

    await waitFor(() => expect(video).toHaveAttribute("preload", "auto"));
  });
});
