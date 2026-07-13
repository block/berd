import { describe, expect, it, vi } from "vitest";
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
        path: "/usr/local/bin/codex",
        bridgePath: "/usr/local/bin/codex-acp",
        authStatus,
      },
    ],
  };
}

describe("isExternalAgentReady", () => {
  it("allows a ready external ACP agent", async () => {
    runDoctor.mockResolvedValue(codexReport("authenticated"));

    await expect(isExternalAgentReady("codex-acp")).resolves.toBe(true);
  });

  it("rejects an auth-failed external ACP agent", async () => {
    runDoctor.mockResolvedValue(codexReport("notAuthenticated"));

    await expect(isExternalAgentReady("codex-acp")).resolves.toBe(false);
  });
});
