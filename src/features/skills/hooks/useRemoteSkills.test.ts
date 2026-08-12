import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRemoteSkills } from "./useRemoteSkills";

const mocks = vi.hoisted(() => ({
  getSkillCliStatus: vi.fn(),
  listRemoteSkills: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
  },
}));

vi.mock("../api/skillMarketplace", () => ({
  getSkillCliStatus: mocks.getSkillCliStatus,
  installRemoteSkill: vi.fn(),
  listRemoteSkills: mocks.listRemoteSkills,
}));

vi.mock("../lib/skillsEvents", () => ({
  listenSkillsChanged: () => () => undefined,
}));

vi.mock("@/shared/api/acpErrors", () => ({
  formatAcpErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

describe("useRemoteSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSkillCliStatus.mockResolvedValue({ available: true });
    mocks.listRemoteSkills.mockRejectedValue(new Error("catalog unavailable"));
  });

  it("restarts catalog loading after StrictMode effect replay", async () => {
    mocks.listRemoteSkills.mockResolvedValue([]);
    const { result } = renderHook(() => useRemoteSkills(true, false), {
      wrapper: StrictMode,
    });

    await waitFor(() => expect(result.current.catalogState).toBe("ready"));
    expect(mocks.listRemoteSkills).toHaveBeenCalled();
  });

  it("suppresses errors for a background catalog read", async () => {
    const { result } = renderHook(() => useRemoteSkills(true, false));

    await waitFor(() => expect(result.current.catalogState).toBe("error"));

    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("uses the latest reporting mode when an in-flight request fails", async () => {
    let rejectCatalog: ((error: Error) => void) | undefined;
    mocks.listRemoteSkills.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCatalog = reject;
        }),
    );
    const { result, rerender } = renderHook(
      ({ report }) => useRemoteSkills(true, report),
      { initialProps: { report: false } },
    );

    await waitFor(() => expect(result.current.catalogState).toBe("loading"));
    rerender({ report: true });
    await Promise.resolve();
    rejectCatalog?.(new Error("catalog unavailable"));

    await waitFor(() => expect(result.current.catalogState).toBe("error"));
    expect(mocks.toastError).toHaveBeenCalledWith("discover.loadError");
  });

  it("ignores a pending catalog failure after discovery is disabled", async () => {
    let rejectCatalog: ((error: Error) => void) | undefined;
    mocks.listRemoteSkills.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCatalog = reject;
        }),
    );
    const { result, rerender } = renderHook(
      ({ enabled }) => useRemoteSkills(enabled, true),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.catalogState).toBe("loading"));

    rerender({ enabled: false });
    rejectCatalog?.(new Error("catalog unavailable"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.catalogState).toBe("idle");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("reports errors for an explicit Discover catalog read", async () => {
    const { result } = renderHook(() => useRemoteSkills(true, true));

    await waitFor(() => expect(result.current.catalogState).toBe("error"));

    expect(mocks.toastError).toHaveBeenCalledWith("discover.loadError");
  });
});
