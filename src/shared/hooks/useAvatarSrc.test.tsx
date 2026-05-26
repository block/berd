import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedAvatarForRef } from "@/shared/api/avatars";
import {
  listenLocalMediaCachesCleared,
  type LocalMediaCachesClearedPayload,
} from "@/shared/api/localMediaCaches";
import { useAvatarMediaState, useAvatarSrc } from "./useAvatarSrc";

vi.mock("@/shared/api/avatars", () => ({
  cachedAssetToMedia: (asset: { path: string; mimeType: string }) => ({
    src: `asset://${asset.path}`,
    mediaType: asset.mimeType.startsWith("video/") ? "video" : "image",
  }),
  getCachedAvatarForRef: vi.fn(),
}));

vi.mock("@/shared/api/localMediaCaches", () => ({
  listenLocalMediaCachesCleared: vi.fn(),
}));

const getCachedAvatarForRefMock = vi.mocked(getCachedAvatarForRef);
const listenLocalMediaCachesClearedMock = vi.mocked(
  listenLocalMediaCachesCleared,
);
let localMediaCachesClearedHandler:
  | ((payload: LocalMediaCachesClearedPayload) => void)
  | undefined;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useAvatarSrc", () => {
  beforeEach(() => {
    getCachedAvatarForRefMock.mockReset();
    localMediaCachesClearedHandler = undefined;
    listenLocalMediaCachesClearedMock.mockReset();
    listenLocalMediaCachesClearedMock.mockImplementation((handler) => {
      localMediaCachesClearedHandler = handler;
      return Promise.resolve(vi.fn());
    });
  });

  it("keeps URL avatar behavior unchanged", () => {
    const mediaState = renderHook(
      () => useAvatarMediaState("https://example.test/scout.png"),
      { wrapper: createWrapper() },
    );
    const avatarSrc = renderHook(() =>
      useAvatarSrc("https://example.test/scout.png"),
    );

    expect(avatarSrc.result.current).toBe("https://example.test/scout.png");
    expect(mediaState.result.current).toMatchObject({
      media: {
        src: "https://example.test/scout.png",
        mediaType: "image",
      },
      loading: false,
      unavailable: false,
    });
    expect(getCachedAvatarForRefMock).not.toHaveBeenCalled();
  });

  it("resolves app-avatar refs with cached-only lookup", async () => {
    getCachedAvatarForRefMock.mockResolvedValueOnce({
      catalogVersion: "v1",
      collectionId: "gloopies",
      asset: {
        id: "gloopy-1",
        path: "/tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
        mimeType: "video/webm",
      },
    });

    const { result } = renderHook(
      () => useAvatarMediaState("app-avatar:gloopy-1"),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.media).toEqual({
        src: "asset:///tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
        mediaType: "video",
      });
    });

    expect(getCachedAvatarForRefMock).toHaveBeenCalledWith({
      avatarRef: "app-avatar:gloopy-1",
    });
  });

  it("marks uncached app-avatar refs unavailable without ensuring downloads", async () => {
    getCachedAvatarForRefMock.mockResolvedValueOnce(null);

    const { result } = renderHook(
      () => useAvatarMediaState("app-avatar:gloopy-1"),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.unavailable).toBe(true);
    });

    expect(result.current.media).toBeUndefined();
    expect(getCachedAvatarForRefMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes repeated app-avatar refs through React Query", async () => {
    getCachedAvatarForRefMock.mockResolvedValue({
      catalogVersion: "v1",
      collectionId: "gloopies",
      asset: {
        id: "gloopy-1",
        path: "/tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
        mimeType: "video/webm",
      },
    });

    const { result } = renderHook(
      () => [
        useAvatarMediaState("app-avatar:gloopy-1"),
        useAvatarMediaState("app-avatar:gloopy-1"),
      ],
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current[0].media?.src).toBe(
        "asset:///tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
      );
      expect(result.current[1].media?.src).toBe(
        "asset:///tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
      );
    });

    expect(getCachedAvatarForRefMock).toHaveBeenCalledTimes(1);
  });

  it("rechecks resolved app-avatar refs after local media caches are cleared", async () => {
    getCachedAvatarForRefMock
      .mockResolvedValueOnce({
        catalogVersion: "v1",
        collectionId: "gloopies",
        asset: {
          id: "gloopy-1",
          path: "/tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
          mimeType: "video/webm",
        },
      })
      .mockResolvedValueOnce(null);

    const { result } = renderHook(
      () => useAvatarMediaState("app-avatar:gloopy-1"),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.media?.src).toBe(
        "asset:///tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
      );
    });

    await act(async () => {
      localMediaCachesClearedHandler?.({
        avatars: true,
        artifacts: false,
      });
    });

    await waitFor(() => {
      expect(result.current.unavailable).toBe(true);
    });
    expect(result.current.media).toBeUndefined();
    expect(getCachedAvatarForRefMock).toHaveBeenCalledTimes(2);
  });

  it("does not recheck resolved app-avatar refs when only project artifact caches are cleared", async () => {
    getCachedAvatarForRefMock.mockResolvedValue({
      catalogVersion: "v1",
      collectionId: "gloopies",
      asset: {
        id: "gloopy-1",
        path: "/tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
        mimeType: "video/webm",
      },
    });

    const { result } = renderHook(
      () => useAvatarMediaState("app-avatar:gloopy-1"),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.media?.src).toBe(
        "asset:///tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
      );
    });

    await act(async () => {
      localMediaCachesClearedHandler?.({
        avatars: false,
        artifacts: true,
      });
    });

    expect(getCachedAvatarForRefMock).toHaveBeenCalledTimes(1);
    expect(result.current.media?.src).toBe(
      "asset:///tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
    );
  });
});
