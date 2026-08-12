import { beforeEach, describe, expect, it } from "vitest";
import type { AcpSessionInfo } from "@/shared/api/acp";
import {
  acpSessionToChatSession,
  mergeAcpSessionInfo,
} from "./acpSessionMapping";

function sessionInfo(patch: Partial<AcpSessionInfo> = {}): AcpSessionInfo {
  return {
    sessionId: "session-1",
    title: "Chat",
    updatedAt: "2026-08-06T00:00:00.000Z",
    createdAt: "2026-08-06T00:00:00.000Z",
    lastMessageAt: null,
    archivedAt: null,
    userSetName: false,
    messageCount: 0,
    subtitle: null,
    workingDir: null,
    providerId: null,
    modelId: null,
    personaId: null,
    ...patch,
  };
}

describe("acpSessionToChatSession execution target", () => {
  beforeEach(() => window.localStorage.clear());

  it("leaves model-only ACP metadata unresolved", () => {
    expect(
      acpSessionToChatSession(sessionInfo({ modelId: "orphaned-model" }))
        .executionTarget,
    ).toBeUndefined();
  });

  it("canonicalizes ACP agent aliases", () => {
    expect(
      acpSessionToChatSession(
        sessionInfo({ providerId: "codex", modelId: "gpt-5.6" }),
      ).executionTarget,
    ).toEqual({
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
      modelId: "gpt-5.6",
      modelName: "gpt-5.6",
    });
  });

  it("preserves the complete UI-owned target over stale ACP metadata", () => {
    const executionTarget = {
      harnessId: "goose" as const,
      modelProviderId: "databricks_v2",
      modelId: "goose-gpt-5-6-sol",
      modelName: "GPT-5.6 Sol",
    };

    const merged = mergeAcpSessionInfo(
      {
        sessions: [
          {
            id: "session-1",
            title: "Chat",
            executionTarget,
            executionTargetSource: "ui",
            createdAt: "2026-08-06T00:00:00.000Z",
            updatedAt: "2026-08-06T00:00:00.000Z",
            messageCount: 0,
          },
        ],
        archiveMutationBySessionId: {},
      },
      sessionInfo({
        providerId: "databricks_v2",
        modelId: "goose-gpt-5-5",
      }),
    );

    expect(merged.sessions[0]?.executionTarget).toEqual(executionTarget);
  });
});
