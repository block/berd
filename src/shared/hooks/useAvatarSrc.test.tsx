import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalMediaCacheEvents } from "@/app/LocalMediaCacheEvents";
import { ARTIFACTS_QUERY_KEY, type Artifacts } from "@/shared/api/artifacts";
import {
  avatarCachedRefQueryKey,
  getCachedAvatarForRef,
  listenAvatarCacheWarmed,
  type AvatarCacheWarmedPayload,
} from "@/shared/api/avatars";
import {
  listenLocalMediaCachesCleared,
  type LocalMediaCachesClearedPayload,
} from "@/shared/api/localMediaCaches";
import {
  useAvatarImage,
  useAvatarMediaState,
  useAvatarSrc,
} from "./useAvatarSrc";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
  invoke: vi.fn(),
}));

vi.mock("@/shared/api/avatars", () => ({
  AVATAR_CACHED_REF_QUERY_KEY_PREFIX: ["avatars", "cached-ref"],
  avatarCachedRefQueryKey: (avatarRef: string) => [
    "avatars",
    "cached-ref",
    avatarRef,
  ],
  cachedAssetToMedia: (asset: {
    path: string;
    mimeType: string;
    alphaMode?: "stacked";
  }) => ({
    src: `asset://${asset.path}`,
    mediaType: asset.mimeType.startsWith("video/") ? "video" : "image",
    ...(asset.alphaMode ? { alphaMode: asset.alphaMode } : {}),
  }),
  getCachedAvatarForRef: vi.fn(),
  listenAvatarCacheWarmed: vi.fn(),
}));

vi.mock("@/shared/api/localMediaCaches", () => ({
  listenLocalMediaCachesCleared: vi.fn(),
}));

const getCachedAvatarForRefMock = vi.mocked(getCachedAvatarForRef);
const listenAvatarCacheWarmedMock = vi.mocked(listenAvatarCacheWarmed);
const listenLocalMediaCachesClearedMock = vi.mocked(
  listenLocalMediaCachesCleared,
);
let localMediaCachesClearedHandler:
  | ((payload: LocalMediaCachesClearedPayload) => void)
  | undefined;
let avatarCacheWarmedHandler:
  | ((payload: AvatarCacheWarmedPayload) => void)
  | undefined;

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function createWrapper(queryClient = createQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {/* Owns the cleared/warmed cache listeners the tiles react to. */}
        <LocalMediaCacheEvents />
        {children}
      </QueryClientProvider>
    );
  };
}

function createArtifacts(): Artifacts {
  return {
    catalogVersion: "v1",
    assets: [
      {
        kind: "environment",
        path: "/tmp/goose/artifacts/env.exr",
        mimeType: "image/x-exr",
        byteSize: 1,
        sha256: "a".repeat(64),
      },
      {
        kind: "projectImage",
        path: "/tmp/goose/artifacts/project.webp",
        mimeType: "image/webp",
        byteSize: 1,
        sha256: "b".repeat(64),
      },
      {
        kind: "collectionImage",
        path: "/tmp/goose/avatars/gloopies/gloopy-1.png",
        mimeType: "image/png",
        byteSize: 1,
        sha256: "c".repeat(64),
      },
    ],
  };
}

describe("useAvatarSrc", () => {
  beforeEach(() => {
    getCachedAvatarForRefMock.mockReset();
    localMediaCachesClearedHandler = undefined;
    avatarCacheWarmedHandler = undefined;
    listenLocalMediaCachesClearedMock.mockReset();
    listenLocalMediaCachesClearedMock.mockImplementation((handler) => {
      localMediaCachesClearedHandler = handler;
      return Promise.resolve(vi.fn());
    });
    listenAvatarCacheWarmedMock.mockReset();
    listenAvatarCacheWarmedMock.mockImplementation((handler) => {
      avatarCacheWarmedHandler = handler;
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

  it("resolves user-avatar refs with cached-only lookup", async () => {
    getCachedAvatarForRefMock.mockResolvedValueOnce({
      catalogVersion: "user-generated",
      collectionId: "generated-gloopies",
      asset: {
        id: "gloopie-1",
        path: "/tmp/goose/user-avatars/gloopie-1.webm",
        mimeType: "video/webm",
        alphaMode: "stacked",
      },
    });

    const { result } = renderHook(
      () => useAvatarMediaState("user-avatar:gloopie-1"),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.media).toEqual({
        src: "asset:///tmp/goose/user-avatars/gloopie-1.webm",
        mediaType: "video",
        alphaMode: "stacked",
      });
    });

    expect(getCachedAvatarForRefMock).toHaveBeenCalledWith({
      avatarRef: "user-avatar:gloopie-1",
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

  it("reports loading, not unavailable, while re-checking a cached null on remount", async () => {
    const queryClient = createQueryClient();
    const wrapper = createWrapper(queryClient);

    getCachedAvatarForRefMock.mockResolvedValueOnce(null);
    const first = renderHook(() => useAvatarMediaState("app-avatar:gloopy-1"), {
      wrapper,
    });
    await waitFor(() => {
      expect(first.result.current.unavailable).toBe(true);
    });
    first.unmount();

    let resolveRecheck: (value: null) => void = () => {};
    getCachedAvatarForRefMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRecheck = resolve;
        }),
    );

    const second = renderHook(
      () => useAvatarMediaState("app-avatar:gloopy-1"),
      { wrapper },
    );

    await waitFor(() => {
      expect(getCachedAvatarForRefMock).toHaveBeenCalledTimes(2);
    });
    expect(second.result.current.loading).toBe(true);
    expect(second.result.current.unavailable).toBe(false);

    await act(async () => {
      resolveRecheck(null);
    });
    await waitFor(() => {
      expect(second.result.current.unavailable).toBe(true);
    });
    expect(second.result.current.loading).toBe(false);
  });

  it("ignores malformed app-avatar refs without cached lookup", () => {
    const { result } = renderHook(
      () => useAvatarMediaState("app-avatar:../secret"),
      { wrapper: createWrapper() },
    );

    expect(result.current).toMatchObject({
      media: undefined,
      loading: false,
      unavailable: false,
    });
    expect(getCachedAvatarForRefMock).not.toHaveBeenCalled();
  });

  it("rechecks uncached app-avatar refs after the backend warms them", async () => {
    getCachedAvatarForRefMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
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
      expect(result.current.unavailable).toBe(true);
    });

    await act(async () => {
      avatarCacheWarmedHandler?.({
        avatarRefs: ["app-avatar:gloopy-1"],
      });
    });

    await waitFor(() => {
      expect(result.current.media?.src).toBe(
        "asset:///tmp/goose/avatars/v1/webm/gloopies/gloopy-1.webm",
      );
    });
    expect(result.current.unavailable).toBe(false);
    expect(getCachedAvatarForRefMock).toHaveBeenCalledTimes(2);
    expect(avatarCachedRefQueryKey("app-avatar:gloopy-1")).toEqual([
      "avatars",
      "cached-ref",
      "app-avatar:gloopy-1",
    ]);
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

  it("reads avatar images from the raw shared artifacts query cache", async () => {
    const artifacts = createArtifacts();
    const queryClient = createQueryClient();
    queryClient.setQueryData(ARTIFACTS_QUERY_KEY, artifacts);

    const { result } = renderHook(() => useAvatarImage("app-avatar:gloopy-1"), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current).toBe(
        "asset:///tmp/goose/avatars/gloopies/gloopy-1.png",
      );
    });
    expect(queryClient.getQueryData(ARTIFACTS_QUERY_KEY)).toBe(artifacts);
  });
});
