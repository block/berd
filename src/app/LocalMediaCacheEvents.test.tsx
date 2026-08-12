import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listenLocalMediaCachesCleared,
  type LocalMediaCachesClearedPayload,
} from "@/shared/api/localMediaCaches";
import { ARTIFACTS_QUERY_KEY } from "@/shared/api/artifacts";
import {
  AVATAR_CACHED_REF_QUERY_KEY_PREFIX,
  avatarCachedRefQueryKey,
  listenAvatarCacheWarmed,
  type AvatarCacheWarmedPayload,
} from "@/shared/api/avatars";
import { LocalMediaCacheEvents } from "./LocalMediaCacheEvents";

vi.mock("@/shared/api/localMediaCaches", () => ({
  listenLocalMediaCachesCleared: vi.fn(),
}));

vi.mock("@/shared/api/avatars", () => ({
  AVATAR_CACHED_REF_QUERY_KEY_PREFIX: ["avatars", "cached-ref"],
  avatarCachedRefQueryKey: (avatarRef: string) => [
    "avatars",
    "cached-ref",
    avatarRef,
  ],
  listenAvatarCacheWarmed: vi.fn(),
}));

const listenLocalMediaCachesClearedMock = vi.mocked(
  listenLocalMediaCachesCleared,
);
const listenAvatarCacheWarmedMock = vi.mocked(listenAvatarCacheWarmed);
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

async function renderEvents(queryClient: QueryClient) {
  render(
    <QueryClientProvider client={queryClient}>
      <LocalMediaCacheEvents />
    </QueryClientProvider>,
  );

  await waitFor(() => {
    expect(localMediaCachesClearedHandler).toBeDefined();
    expect(avatarCacheWarmedHandler).toBeDefined();
  });
}

describe("LocalMediaCacheEvents", () => {
  beforeEach(() => {
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

  it("invalidates artifacts when the backend clears that cache", async () => {
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const resetQueries = vi.spyOn(queryClient, "resetQueries");

    await renderEvents(queryClient);

    localMediaCachesClearedHandler?.({
      avatars: false,
      artifacts: true,
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ARTIFACTS_QUERY_KEY,
    });
    expect(resetQueries).not.toHaveBeenCalled();
  });

  it("resets cached avatar refs when the backend clears that cache", async () => {
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const resetQueries = vi.spyOn(queryClient, "resetQueries");

    await renderEvents(queryClient);

    localMediaCachesClearedHandler?.({
      avatars: true,
      artifacts: false,
    });

    expect(resetQueries).toHaveBeenCalledWith({
      queryKey: AVATAR_CACHED_REF_QUERY_KEY_PREFIX,
    });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("logs a failed avatar-listener registration and keeps the sibling subscription working", async () => {
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    listenAvatarCacheWarmedMock.mockImplementation(() =>
      Promise.reject(new Error("event bridge unavailable")),
    );

    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <LocalMediaCacheEvents />
      </QueryClientProvider>,
    );

    // The rejection is caught and logged instead of surfacing as an
    // unhandled promise rejection.
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("avatar-cache-warmed"),
        expect.any(Error),
      );
    });

    // The failed registration must not take down the sibling subscription.
    await waitFor(() => {
      expect(localMediaCachesClearedHandler).toBeDefined();
    });
    localMediaCachesClearedHandler?.({ avatars: false, artifacts: true });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ARTIFACTS_QUERY_KEY,
    });

    // Cleanup settles the failed registration's no-op cleanup quietly.
    unmount();
    consoleError.mockRestore();
  });

  it("resets the warmed avatar refs when the backend reports them", async () => {
    const queryClient = createQueryClient();
    const resetQueries = vi.spyOn(queryClient, "resetQueries");

    await renderEvents(queryClient);

    avatarCacheWarmedHandler?.({
      avatarRefs: ["app-avatar:gloopy-1", "app-avatar:gloopy-2"],
    });

    expect(resetQueries).toHaveBeenCalledWith({
      queryKey: avatarCachedRefQueryKey("app-avatar:gloopy-1"),
    });
    expect(resetQueries).toHaveBeenCalledWith({
      queryKey: avatarCachedRefQueryKey("app-avatar:gloopy-2"),
    });
  });
});
