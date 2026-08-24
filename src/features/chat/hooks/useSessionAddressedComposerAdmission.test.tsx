import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deriveSessionAddressedComposerAdmission,
  useSessionAddressedComposerAdmission,
} from "./useSessionAddressedComposerAdmission";
import {
  useChatSessionStore,
  type ChatSession,
} from "../stores/chatSessionStore";
import { useSessionWindowStore } from "../stores/sessionWindowStore";
import { useSecurityConfirmationStore } from "@/features/security/stores/securityConfirmationStore";

const session = {
  id: "session-1",
  title: "Chat",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  messageCount: 1,
} satisfies ChatSession;

function derive(
  overrides: Partial<
    Parameters<typeof deriveSessionAddressedComposerAdmission>[0]
  > = {},
) {
  return deriveSessionAddressedComposerAdmission({
    session,
    securityConfirmationPending: false,
    sessionCreationFailureFallback: "Session creation failed",
    executionTargetFailureReason: "Agent preparation failed",
    ...overrides,
  });
}

describe("session-addressed composer admission", () => {
  beforeEach(() => {
    useSecurityConfirmationStore.setState({
      pendingBySessionId: {},
      mountedSurfaceCountBySessionId: {},
    });
    useSessionWindowStore.setState({
      openSessions: {},
      handoffs: {},
      hasLoadedSnapshot: false,
    });
    useChatSessionStore.setState({ sessions: [session] });
  });

  it.each([
    ["ordinary session", {}, false, undefined],
    [
      "session creation failure",
      { session: { ...session, creationState: "failed" as const } },
      true,
      "Session creation failed",
    ],
    [
      "execution target failure",
      {
        session: {
          ...session,
          intent: "build-agent" as const,
          targetAgentDraftState: "failed" as const,
        },
      },
      true,
      "Agent preparation failed",
    ],
    ["read-only lifecycle", { readOnlyReason: "Read only" }, true, "Read only"],
    [
      "pending security confirmation",
      { securityConfirmationPending: true },
      true,
      undefined,
    ],
  ])("derives %s consistently", (_label, overrides, blocked, blockingReason) => {
    expect(derive(overrides)).toMatchObject({ blocked, blockingReason });
  });

  it("reacts to the shared security queue and separate-window ownership", () => {
    const { result } = renderHook(() =>
      useSessionAddressedComposerAdmission({
        sessionId: session.id,
        sessionSnapshot: session,
        readOnlyWhenOpenInAnotherWindow: true,
      }),
    );
    expect(result.current.blocked).toBe(false);

    act(() => {
      useSecurityConfirmationStore.setState({
        pendingBySessionId: {
          [session.id]: [
            {
              request: { sessionId: session.id } as never,
              title: "Security",
              command: null,
              alertText: "Alert",
              resolve: () => undefined,
              inferredExplanation: { status: "idle" },
            },
          ],
        },
      });
    });
    expect(result.current).toMatchObject({
      blocked: true,
      securityConfirmationPending: true,
    });

    act(() => {
      useSecurityConfirmationStore.setState({ pendingBySessionId: {} });
      useSessionWindowStore.setState({
        openSessions: { [session.id]: "session-window" },
      });
    });
    expect(result.current).toMatchObject({
      blocked: true,
      readOnlyReason: "Finishing current response...",
      blockingReason: "Finishing current response...",
    });
  });
});
