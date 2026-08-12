import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listenAcpToolsReconciled,
  type AcpToolsReconciledPayload,
} from "@/shared/api/acpTools";
import { runDoctorFresh } from "@/shared/api/doctor";
import {
  DOCTOR_REPORT_FRESHNESS_QUERY_KEY,
  DOCTOR_REPORT_QUERY_KEY,
} from "@/shared/api/useDoctorReport";
import { AcpToolsEvents } from "./AcpToolsEvents";

vi.mock("@/shared/api/acpTools", () => ({
  listenAcpToolsReconciled: vi.fn(),
}));

vi.mock("@/shared/api/doctor", () => ({
  runDoctor: vi.fn().mockResolvedValue({ checks: [] }),
  runDoctorFresh: vi.fn().mockResolvedValue({ checks: [] }),
}));

const listenAcpToolsReconciledMock = vi.mocked(listenAcpToolsReconciled);
let acpToolsReconciledHandler:
  | ((payload: AcpToolsReconciledPayload) => void)
  | undefined;

describe("AcpToolsEvents", () => {
  beforeEach(() => {
    acpToolsReconciledHandler = undefined;
    listenAcpToolsReconciledMock.mockReset();
    listenAcpToolsReconciledMock.mockImplementation((handler) => {
      acpToolsReconciledHandler = handler;
      return Promise.resolve(vi.fn());
    });
  });

  it("reruns the shared doctor report when the startup reconciler completes", async () => {
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
        <AcpToolsEvents />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(acpToolsReconciledHandler).toBeDefined();
    });

    acpToolsReconciledHandler?.({
      ok: true,
      providerIds: ["claude-acp", "codex-acp"],
    });

    // `rerunDoctorReport` busts both the shared report key and its freshness
    // sibling so availability and version badges repopulate together.
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: DOCTOR_REPORT_QUERY_KEY,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: DOCTOR_REPORT_FRESHNESS_QUERY_KEY,
    });

    // The freshness pass actually re-probes rather than serving cached data.
    await waitFor(() => {
      expect(vi.mocked(runDoctorFresh)).toHaveBeenCalled();
    });
  });
});
