import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_LIMIT_CONFIG_KEY,
  DEFAULT_CONTEXT_LIMIT,
} from "@/features/chat/lib/contextLimit";
import { useGooseContextLimit } from "../useGooseContextLimit";

const { read, upsert, getClient } = vi.hoisted(() => ({
  read: vi.fn(),
  upsert: vi.fn(),
  getClient: vi.fn(),
}));
vi.mock("@/shared/api/acpConnection", () => ({ getClient }));

describe("useGooseContextLimit", () => {
  beforeEach(() => {
    read.mockReset().mockResolvedValue({ value: 272_000 });
    upsert.mockReset().mockResolvedValue(undefined);
    getClient.mockReset().mockResolvedValue({
      goose: {
        GooseUnstableConfigRead: read,
        GooseUnstableConfigUpsert: upsert,
      },
    });
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    128_000,
    "64000",
    2_000_000,
  ])("preserves the effective configured limit %s", async (value) => {
    read.mockResolvedValue({ value });
    const { result } = renderHook(() => useGooseContextLimit());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.contextLimit).toBe(Number(value));
    expect(read).toHaveBeenCalledWith({
      key: CONTEXT_LIMIT_CONFIG_KEY,
      isSecret: false,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    null,
    undefined,
    0,
    "bad",
  ])("uses the fallback without writing config for %s", async (value) => {
    read.mockResolvedValue({ value });
    const { result } = renderHook(() => useGooseContextLimit());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.contextLimit).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("persists updates and synchronizes other mounted controls", async () => {
    const first = renderHook(() => useGooseContextLimit());
    const second = renderHook(() => useGooseContextLimit());
    await waitFor(() => expect(second.result.current.isHydrated).toBe(true));
    read.mockResolvedValue({ value: 450_000 });
    await act(async () => {
      await first.result.current.saveContextLimit(450_000);
    });
    expect(upsert).toHaveBeenCalledWith({
      key: CONTEXT_LIMIT_CONFIG_KEY,
      value: 450_000,
      isSecret: false,
    });
    await waitFor(() =>
      expect(second.result.current.contextLimit).toBe(450_000),
    );
  });

  it("reads back an environment override instead of claiming the saved value is effective", async () => {
    read.mockResolvedValue({ value: 128_000 });
    const { result } = renderHook(() => useGooseContextLimit());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    await act(async () => {
      expect(await result.current.saveContextLimit(450_000)).toBe(128_000);
    });
    expect(result.current.contextLimit).toBe(128_000);
  });

  it("retains the prior value if saving fails", async () => {
    const { result } = renderHook(() => useGooseContextLimit());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    upsert.mockRejectedValue(new Error("write failed"));
    await act(async () => {
      await expect(result.current.saveContextLimit(450_000)).rejects.toThrow(
        "write failed",
      );
    });
    expect(result.current.contextLimit).toBe(272_000);
  });

  it("retries a transient read failure without enabling controls early", async () => {
    vi.useFakeTimers();
    read.mockRejectedValueOnce(new Error("ACP not ready"));
    const { result } = renderHook(() => useGooseContextLimit());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.isHydrated).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.isHydrated).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("cancels hydration retries when unmounted", async () => {
    vi.useFakeTimers();
    read.mockRejectedValue(new Error("ACP not ready"));
    const { unmount } = renderHook(() => useGooseContextLimit());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid writes before reaching ACP", async () => {
    const { result } = renderHook(() => useGooseContextLimit());
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    await expect(result.current.saveContextLimit(0)).rejects.toThrow(
      "Invalid context limit",
    );
    expect(upsert).not.toHaveBeenCalled();
  });
});
