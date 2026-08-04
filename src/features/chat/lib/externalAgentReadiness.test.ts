import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { DOCTOR_REPORT_QUERY_KEY } from "@/shared/api/useDoctorReport";
import { isExternalAgentReady } from "./externalAgentReadiness";

const runDoctor = vi.fn();

vi.mock("@/shared/api/doctor", async () => {
  const actual = await vi.importActual<typeof import("@/shared/api/doctor")>(
    "@/shared/api/doctor",
  );
  return {
    ...actual,
    runDoctor: () => runDoctor(),
  };
});

function codexReport(authStatus: "authenticated" | "notAuthenticated") {
  return {
    checks: [
      {
        id: "ai-agent-codex",
        status: authStatus === "authenticated" ? "pass" : "warn",
        fixType: null,
        path: "/Applications/Berd.app/Contents/Resources/acp/bin/codex-acp",
        bridgePath: null,
        authStatus,
      },
    ],
  };
}

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("isExternalAgentReady", () => {
  it("uses the shared cached readiness shown by the UI", async () => {
    const client = queryClient();
    client.setQueryData(DOCTOR_REPORT_QUERY_KEY, codexReport("authenticated"));

    await expect(isExternalAgentReady("codex-acp", client)).resolves.toBe(true);
    expect(runDoctor).not.toHaveBeenCalled();
  });

  it("rejects an auth-failed external ACP agent", async () => {
    const client = queryClient();
    client.setQueryData(
      DOCTOR_REPORT_QUERY_KEY,
      codexReport("notAuthenticated"),
    );

    await expect(isExternalAgentReady("codex-acp", client)).resolves.toBe(
      false,
    );
  });

  it("loads the shared report when the cache is cold", async () => {
    const client = queryClient();
    runDoctor.mockResolvedValue(codexReport("authenticated"));

    await expect(isExternalAgentReady("codex-acp", client)).resolves.toBe(true);
    expect(runDoctor).toHaveBeenCalledTimes(1);
  });
});
