import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listenLocalMediaCachesCleared,
  type LocalMediaCachesClearedPayload,
} from "@/shared/api/localMediaCaches";
import { ARTIFACTS_QUERY_KEY } from "@/shared/api/artifacts";
import { LocalMediaCacheEvents } from "./LocalMediaCacheEvents";

vi.mock("@/shared/api/localMediaCaches", () => ({
  listenLocalMediaCachesCleared: vi.fn(),
}));

const listenLocalMediaCachesClearedMock = vi.mocked(
  listenLocalMediaCachesCleared,
);
let localMediaCachesClearedHandler:
  | ((payload: LocalMediaCachesClearedPayload) => void)
  | undefined;

describe("LocalMediaCacheEvents", () => {
  beforeEach(() => {
    localMediaCachesClearedHandler = undefined;
    listenLocalMediaCachesClearedMock.mockReset();
    listenLocalMediaCachesClearedMock.mockImplementation((handler) => {
      localMediaCachesClearedHandler = handler;
      return Promise.resolve(vi.fn());
    });
  });

  it("invalidates artifacts when the backend clears that cache", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <LocalMediaCacheEvents />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(localMediaCachesClearedHandler).toBeDefined();
    });

    localMediaCachesClearedHandler?.({
      avatars: false,
      artifacts: true,
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ARTIFACTS_QUERY_KEY,
    });
  });

  it("ignores avatar-only cache clear events", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <LocalMediaCacheEvents />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(localMediaCachesClearedHandler).toBeDefined();
    });

    localMediaCachesClearedHandler?.({
      avatars: true,
      artifacts: false,
    });

    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
