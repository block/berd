import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

  it("renders stacked-alpha videos through a canvas", () => {
    render(
      <AvatarMedia
        media={{
          src: "asset://localhost/avatar.mp4",
          mediaType: "video",
          alphaMode: "stacked",
        }}
        alt="avatar"
        loadingStrategy="visible-video"
      />,
    );

    const canvas = screen.getByRole("img", { name: "avatar" });
    expect(canvas.tagName).toBe("CANVAS");
    expect(document.querySelector("video")).not.toHaveAttribute("src");
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

  // The next three tests pin the hover-to-play contract: `paused` is
  // transient host gating (hover fields), not the durable animation
  // preference. Regressing any of them re-introduces the hover blink or the
  // invisible-until-hovered tiles.

  it("keeps a paused video mounted as a video instead of swapping to its poster", () => {
    // Pre-fix, paused + posterSrc rendered the poster <img>; unpausing on
    // hover remounted a fresh <video> that flashed blank while re-decoding.
    render(
      <AvatarMedia
        media={{
          src: "asset://localhost/avatar.mp4",
          mediaType: "video",
          posterSrc: "asset://localhost/avatar.png",
        }}
        alt="avatar"
        loadingStrategy="visible-video"
        paused
      />,
    );

    expect(screen.getByRole("img", { name: "avatar" }).tagName).toBe("VIDEO");
  });

  it("preloads a paused visible video so its first frame can paint", async () => {
    // Paused videos never call play(), so preload is the only thing that
    // forces a frame decode; pre-fix "none" left tiles invisible (onReady
    // never fired) until the first hover started playback.
    render(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="visible-video"
        paused
      />,
    );

    const video = screen.getByRole("img", { name: "avatar" });
    emitIntersection(true);

    await waitFor(() =>
      expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4"),
    );
    expect(video).toHaveAttribute("preload", "auto");
  });

  it("keeps the video source attached when paused toggles", async () => {
    // Pre-fix, the visibility effect was keyed on the animate flag, so every
    // hover re-ran it — resetting shouldLoadVideo(false) and detaching the
    // src for a frame: the hover blink.
    const { rerender } = render(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="visible-video"
        paused
      />,
    );

    const video = screen.getByRole("img", { name: "avatar" });
    emitIntersection(true);
    await waitFor(() =>
      expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4"),
    );
    const observeCallsAfterAttach = observeMock.mock.calls.length;

    // Hover in (unpause) and out (pause): the source must stay attached and
    // no new observer may be created (a new observer implies the detach).
    rerender(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="visible-video"
        paused={false}
      />,
    );
    expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4");

    rerender(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="visible-video"
        paused
      />,
    );
    expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4");
    expect(observeMock.mock.calls.length).toBe(observeCallsAfterAttach);
  });

  it("seeks a paused video back to its first frame", async () => {
    const { rerender } = render(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="eager"
        paused={false}
      />,
    );
    const video = screen.getByRole("img", {
      name: "avatar",
    }) as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 1.25,
    });

    rerender(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="eager"
        paused
      />,
    );

    await waitFor(() => expect(video.currentTime).toBe(0));
    expect(pauseMock).toHaveBeenCalled();
  });

  it("renders the matching poster instead of loading video when animation is disabled", () => {
    localStorage.setItem("goose:animated-avatars-enabled", "false");

    render(
      <AvatarMedia
        media={{
          src: "asset://localhost/avatar.mp4",
          mediaType: "video",
          posterSrc: "asset://localhost/avatar.png",
        }}
        alt="avatar"
      />,
    );

    const image = screen.getByRole("img", { name: "avatar" });
    expect(image.tagName).toBe("IMG");
    expect(image).toHaveAttribute("src", "asset://localhost/avatar.png");
  });

  it("switches a failed video to its matching poster", () => {
    const onError = vi.fn();
    render(
      <AvatarMedia
        media={{
          src: "asset://localhost/avatar.mp4",
          mediaType: "video",
          posterSrc: "asset://localhost/avatar.png",
        }}
        alt="avatar"
        onError={onError}
      />,
    );

    const video = screen.getByRole("img", { name: "avatar" });
    expect(video.tagName).toBe("VIDEO");
    fireEvent.error(video);

    const image = screen.getByRole("img", { name: "avatar" });
    expect(image.tagName).toBe("IMG");
    expect(image).toHaveAttribute("src", "asset://localhost/avatar.png");
    expect(onError).not.toHaveBeenCalled();

    fireEvent.error(image);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("resets a video failure when the resolved media changes", () => {
    const { rerender } = render(
      <AvatarMedia
        media={{
          src: "asset://localhost/avatar-1.mp4",
          mediaType: "video",
          posterSrc: "asset://localhost/avatar-1.png",
        }}
        alt="avatar"
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "avatar" }));
    expect(screen.getByRole("img", { name: "avatar" }).tagName).toBe("IMG");

    rerender(
      <AvatarMedia
        media={{
          src: "asset://localhost/avatar-2.mp4",
          mediaType: "video",
          posterSrc: "asset://localhost/avatar-2.png",
        }}
        alt="avatar"
      />,
    );

    expect(screen.getByRole("img", { name: "avatar" }).tagName).toBe("VIDEO");
  });

  it.each([
    "lazy-once",
    "visible-video",
  ] as const)("attaches %s video after animation is enabled from a poster", async (loadingStrategy) => {
    localStorage.setItem("goose:animated-avatars-enabled", "false");
    render(
      <AvatarMedia
        media={{
          src: "asset://localhost/avatar.mp4",
          mediaType: "video",
          posterSrc: "asset://localhost/avatar.png",
        }}
        alt="avatar"
        loadingStrategy={loadingStrategy}
      />,
    );

    expect(screen.getByRole("img", { name: "avatar" }).tagName).toBe("IMG");

    dispatchAnimatedAvatarsPreference(true);

    const video = screen.getByRole("img", { name: "avatar" });
    expect(video.tagName).toBe("VIDEO");
    expect(observeMock).toHaveBeenCalledWith(video);

    emitIntersection(true);

    await waitFor(() =>
      expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4"),
    );
    expect(playMock).toHaveBeenCalled();
  });

  it("keeps a posterless video's source attached across preference changes", async () => {
    // No poster means the same <video> element renders either way — a
    // preference change must not re-run the visibility effect, which resets
    // shouldLoadVideo(false) and detaches the src for a frame (a blink).
    // Only poster-backed media swaps elements and needs an observer rebind.
    render(
      <AvatarMedia
        media={{ src: "asset://localhost/avatar.mp4", mediaType: "video" }}
        alt="avatar"
        loadingStrategy="visible-video"
      />,
    );

    const video = screen.getByRole("img", { name: "avatar" });
    emitIntersection(true);
    await waitFor(() =>
      expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4"),
    );
    const observeCallsAfterAttach = observeMock.mock.calls.length;

    dispatchAnimatedAvatarsPreference(false);
    expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4");

    dispatchAnimatedAvatarsPreference(true);
    expect(video).toHaveAttribute("src", "asset://localhost/avatar.mp4");
    // No new observer either — a new observer implies the detach happened.
    expect(observeMock.mock.calls.length).toBe(observeCallsAfterAttach);
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

    await waitFor(() => expect(video).toHaveAttribute("loop"));
    emitIntersection(true);
    await waitFor(() => expect(playMock).toHaveBeenCalledTimes(2));
  });

  it("renders the matching poster when reduced motion is preferred", () => {
    setPrefersReducedMotion(true);

    render(
      <AvatarMedia
        media={{
          src: "asset://localhost/avatar.mp4",
          mediaType: "video",
          posterSrc: "asset://localhost/avatar.png",
        }}
        alt="avatar"
        loadingStrategy="visible-video"
      />,
    );

    const image = screen.getByRole("img", { name: "avatar" });
    expect(image.tagName).toBe("IMG");
    expect(image).toHaveAttribute("src", "asset://localhost/avatar.png");
    expect(playMock).not.toHaveBeenCalled();
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

  it("cancels occasional playback after falling back to the poster", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    render(
      <AvatarMedia
        media={{
          src: "asset://localhost/avatar.mp4",
          mediaType: "video",
          posterSrc: "asset://localhost/avatar.png",
        }}
        alt="avatar"
        loadingStrategy="eager"
        playbackMode="occasional"
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "avatar" }));
    expect(screen.getByRole("img", { name: "avatar" }).tagName).toBe("IMG");

    await act(async () => vi.advanceTimersByTime(30_000));
    expect(playMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
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
