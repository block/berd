import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { usePerch } from "@/features/desktop-agent/hooks/usePerch";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listen).mockResolvedValue(vi.fn());
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "desktop_agent_perch_status") return { perched: false };
    return { appName: "Finder", title: "Files" };
  });
});
it("only explicit drop attaches; renderer changes update existing seating without permission commands", async () => {
  const { result, rerender } = renderHook(
    ({ character }) => usePerch(vi.fn(), character),
    { initialProps: { character: false } },
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("desktop_agent_perch_status", {
      characterSeat: false,
    }),
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "desktop_agent_perch_on",
    expect.anything(),
  );
  rerender({ character: true });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("desktop_agent_perch_status", {
      characterSeat: true,
    }),
  );
  await act(async () => {
    expect(await result.current.endTargetingAndMaybePerch()).toBe(true);
  });
  expect(invoke).toHaveBeenCalledWith("desktop_agent_perch_on", {
    characterSeat: true,
  });
  expect(result.current.phase).toBe("perched");
  rerender({ character: false });
  await act(async () => {
    await result.current.endTargetingAndMaybePerch();
  });
  expect(invoke).toHaveBeenCalledWith("desktop_agent_perch_on", {
    characterSeat: false,
  });
});
it("unmount before async listener registration releases listener without reconciliation", async () => {
  let finish: (fn: () => void) => void = () => {};
  vi.mocked(listen).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const unlisten = vi.fn();
  const { unmount } = renderHook(() => usePerch(vi.fn()));
  unmount();
  await act(async () => finish(unlisten));
  expect(unlisten).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalledWith("desktop_agent_perch_status");
});

it("keeps cancellation and drag callbacks stable across phase and renderer changes", async () => {
  const { result, rerender } = renderHook(
    ({ character }) => usePerch(vi.fn(), character),
    { initialProps: { character: false } },
  );
  await act(async () => {});
  const initial = result.current;
  await act(async () => result.current.beginTargeting());
  expect(result.current.phase).toBe("targeting");
  expect(result.current.cancelTargeting).toBe(initial.cancelTargeting);
  rerender({ character: true });
  expect(result.current.cancelTargeting).toBe(initial.cancelTargeting);
  expect(result.current.beginTargeting).toBe(initial.beginTargeting);
  expect(result.current.dismount).toBe(initial.dismount);
  await act(async () => result.current.cancelTargeting());
  expect(result.current.phase).toBe("unperched");
});

it.each([
  "hit-test",
  "attach",
])("cancellation during %s cannot leave a new perch attached", async (stage) => {
  const { result } = renderHook(() => usePerch(vi.fn()));
  await act(async () => {});
  await act(async () => result.current.beginTargeting());
  let finish!: (value: { appName: string; title: string }) => void;
  const command =
    stage === "hit-test"
      ? "desktop_agent_perch_end_targeting"
      : "desktop_agent_perch_on";
  vi.mocked(invoke).mockImplementation(async (name) => {
    if (name === command) {
      // Only the in-flight drop is delayed, not cancellation's stop command.
      vi.mocked(invoke).mockResolvedValue(null);
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return { appName: "Finder", title: "Files" };
  });
  let drop!: Promise<boolean>;
  await act(async () => {
    drop = result.current.endTargetingAndMaybePerch();
  });
  await act(async () => result.current.cancelTargeting());
  await act(async () => {
    finish({ appName: "Finder", title: "Files" });
    expect(await drop).toBe(false);
  });
  expect(result.current.phase).toBe("unperched");
  if (stage === "hit-test") {
    expect(invoke).not.toHaveBeenCalledWith(
      "desktop_agent_perch_on",
      expect.anything(),
    );
  } else {
    expect(invoke).toHaveBeenCalledWith("desktop_agent_perch_dismount");
  }
});
