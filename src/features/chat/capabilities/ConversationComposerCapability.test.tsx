import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputProps } from "@/features/chat/types";
import {
  ConversationComposerCapability,
  type ConversationComposerBinding,
  type ConversationComposerTarget,
} from "./ConversationComposerCapability";

const chatInputSpy = vi.fn();
const runningMonitorsSpy = vi.fn(
  (
    _sessionId: string | null | undefined,
  ): { data: { sessionId: string; stateKey: string; label: string }[] } => ({
    data: [],
  }),
);

vi.mock("@/features/monitors/MonitorStatus", () => ({
  useRunningMonitors: (sessionId: string | null | undefined) =>
    runningMonitorsSpy(sessionId),
  MonitorStatus: ({
    sessionId,
    variant,
  }: {
    sessionId: string | null | undefined;
    variant: string;
  }) => <span data-testid={`monitor-status-${variant}`}>{sessionId}</span>,
}));

vi.mock("@/features/chat/ui/ChatInput", () => ({
  ChatInput: (props: ChatInputProps) => {
    chatInputSpy(props);
    return <div data-testid="chat-input" />;
  },
}));

function createController() {
  const deferredRecord = {
    kind: "deferred" as const,
    recordId: "deferred-1",
    payload: { text: "waiting for workspace" },
    state: { status: "naming" as const, desired: [] },
  };
  return {
    handleSend: vi.fn(),
    steerDraftMessage: vi.fn(),
    canSteerMessage: true,
    steerQueuedMessage: vi.fn(),
    canSteerQueuedMessage: true,
    projectMetadataPending: false,
    isCompactingContext: false,
    workspaceSetupInProgress: false,
    unresolvedDeferredSend: false,
    deferredWorkspaceError: null,
    deferredWorkspaceRecord: deferredRecord,
    defaultWorkspaceSetup: null,
    queue: {
      queuedMessage: deferredRecord.payload,
      queuedRecord: deferredRecord,
      queuedRecords: [
        deferredRecord,
        {
          kind: "transport-ready" as const,
          recordId: "ready-2",
          payload: { text: "second" },
        },
      ],
      update: vi.fn(),
      beginEditing: vi.fn(),
      cancelEditing: vi.fn(),
      dismiss: vi.fn(),
    },
    sendDeferredAnyway: vi.fn(),
    stopStreaming: vi.fn(),
    chatState: "streaming" as const,
    skillsEnabled: true,
    skillProjectDirs: ["/project"],
    fileMentionProjectDirs: ["/project"],
    selectedProvider: "goose",
    draftValue: "draft",
    draftAttachments: [{ id: "attachment" }],
    handleDraftChange: vi.fn(),
    handleDraftAttachmentsChange: vi.fn(),
    selectedSkills: [{ id: "skill" }],
    handleSkillsChange: vi.fn(),
    personas: [{ id: "persona" }],
    selectedPersonaId: "persona",
    handlePersonaChange: vi.fn(),
    pickerAgents: [{ id: "goose", label: "Goose" }],
    providersLoading: false,
    handleProviderChange: vi.fn(),
    currentModelId: "model",
    currentModelProviderId: "provider",
    currentModelName: "Model",
    currentExecutionTarget: { provider: "goose" },
    availableModels: [{ id: "model", name: "Model" }],
    modelsLoading: false,
    modelStatusMessage: null,
    handleModelChange: vi.fn(),
    handlePickerOpen: vi.fn(),
    reasoningEffort: { currentValue: "high" },
    handleReasoningEffortChange: vi.fn(),
    selectedProjectId: "project",
    availableProjects: [{ id: "project", name: "Project" }],
    handleProjectChange: vi.fn(),
    tokenState: {
      accumulatedTotal: 12,
      contextLimit: 100,
      accumulatedCost: 0.5,
    },
    isContextUsageReady: true,
    compactConversation: vi.fn(),
    canCompactContext: true,
    supportsCompactionControls: true,
    createDeferredWorkspace: vi.fn(),
    cancelDeferredWorkspaceName: vi.fn(),
    submitDeferredWorkspaceName: vi.fn(),
    skipDeferredWorkspace: vi.fn(),
  };
}

function latestProps() {
  return chatInputSpy.mock.calls.at(-1)?.[0] as ChatInputProps;
}

function createBinding(
  controller: ReturnType<typeof createController>,
  target:
    | Extract<ConversationComposerTarget, { kind: "pendingConversation" }>
    | {
        kind: "existingSession";
        sessionId: string;
        admission?: Partial<
          Extract<
            ConversationComposerTarget,
            { kind: "existingSession" }
          >["admission"]
        >;
      },
) {
  const completeTarget: ConversationComposerTarget =
    target.kind === "existingSession"
      ? {
          ...target,
          admission: {
            blocked: false,
            securityConfirmationPending: false,
            ...target.admission,
          },
        }
      : target;
  const admissionBlockingReason =
    completeTarget.kind === "existingSession"
      ? completeTarget.admission.blockingReason
      : undefined;
  const admissionBlocked =
    completeTarget.kind === "existingSession" &&
    completeTarget.admission.blocked;
  return {
    controller,
    target: completeTarget,
    admissionBlockingReason,
    admissionBlocked,
    onSend: admissionBlocked ? vi.fn(() => false) : controller.handleSend,
    onSendQueue: admissionBlocked ? undefined : controller.sendDeferredAnyway,
  } as never;
}

describe("ConversationComposerCapability surface parity", () => {
  beforeEach(() => {
    chatInputSpy.mockClear();
    runningMonitorsSpy.mockReset();
    runningMonitorsSpy.mockReturnValue({ data: [] });
  });

  it("preserves Home deferred-queue policy while sharing draft and selection behavior", () => {
    const controller = createController();
    render(
      <ConversationComposerCapability
        binding={createBinding(controller, {
          kind: "pendingConversation",
          sessionId: null,
        })}
        renderingPolicy={{
          presentation: { surface: "pill", providerColumnMode: "visible" },
        }}
      />,
    );

    const props = latestProps();
    expect(props.surface).toBe("pill");
    expect(props.composerActions.queuedMessages).toEqual([
      { recordId: "ready-2", payload: { text: "second" } },
    ]);
    expect(props.composerActions.onUpdateQueue).toBeUndefined();
    expect(props.composerActions.onEditQueue).toBeUndefined();
    expect(props.composerActions.onCancelQueueEdit).toBeUndefined();
    expect(props.composerActions.onDismissQueue).toBeUndefined();
    expect(props.initialValue).toBe("draft");
    expect(props.initialAttachments).toBe(controller.draftAttachments);
    expect(props.selectedSkills).toBe(controller.selectedSkills);
    expect(props.personaPicker?.selectedPersonaId).toBe("persona");
    expect(props.agentModelPicker?.currentModelId).toBe("model");
    expect(props.projectPicker?.selectedProjectId).toBe("project");
    expect(props.reasoningEffort?.config).toBe(controller.reasoningEffort);
    expect(props.contextUsage).not.toHaveProperty("onCompactContext");
  });

  it("preserves chat-footer steering, handoff, disabled reasons, voice, and context policy", () => {
    const controller = createController();
    const voiceConversation = { visible: true, onToggle: vi.fn() };
    render(
      <ConversationComposerCapability
        binding={createBinding(controller, {
          kind: "existingSession",
          sessionId: "session-1",
          admission: {
            blocked: true,
            blockingReason: "Agent preparation failed",
            securityConfirmationPending: true,
          },
        })}
        renderingPolicy={{
          presentation: {
            surface: "bare",
            innerBareSurface: true,
            providerColumnMode: "gated",
          },
          lifecycleConstraints: {
            handoff: { active: true, inProgress: true },
            voiceConversation: voiceConversation as never,
          },
        }}
      />,
    );

    const props = latestProps();
    expect(props.surface).toBe("bare");
    expect(props.innerBareSurface).toBe(true);
    expect(props.className).toBe("hidden");
    expect(props.controls?.autoFocus).toBe(false);
    expect(props.composerActions.onSteerMessage).toBeUndefined();
    expect(props.composerActions.canSteerMessage).toBe(false);
    expect(props.composerActions.onSteerQueuedMessage).toBeUndefined();
    expect(props.composerActions.queuedMessage).toBeNull();
    expect(props.composerActions.queuedMessages).toEqual([]);
    expect(props.composerActions.onDismissQueue).toBeUndefined();
    expect(props.composerActions.sendDisabled).toBe(true);
    expect(props.composerActions.sendDisabledReason).toBe(
      "Agent preparation failed",
    );
    expect(props.composerActions.disabled).toBe(true);
    expect(props.composerActions.onSendQueue).toBeUndefined();
    expect(props.composerActions.onSend("blocked")).toBe(false);
    expect(controller.handleSend).not.toHaveBeenCalled();
    expect(props.composerActions.onStop).toBe(controller.stopStreaming);
    expect(props.composerActions.voiceConversation).toBe(voiceConversation);
    expect(props.contextUsage?.onCompactContext).toBe(
      controller.compactConversation,
    );
    expect(props.agentModelPicker?.providerColumnMode).toBe("gated");
  });

  it("passes composer monitor accessory only for existing local sessions with monitors", () => {
    const controller = createController();
    runningMonitorsSpy.mockReturnValue({
      data: [
        { sessionId: "session-1", stateKey: "watch", label: "Build watcher" },
      ],
    });

    const { rerender } = render(
      <ConversationComposerCapability
        binding={createBinding(controller, {
          kind: "existingSession",
          sessionId: "session-1",
        })}
        renderingPolicy={{
          presentation: { surface: "bare", providerColumnMode: "visible" },
        }}
      />,
    );

    expect(runningMonitorsSpy).toHaveBeenLastCalledWith("session-1");
    expect(latestProps().queuedMessageAccessory).not.toBeNull();

    runningMonitorsSpy.mockClear();
    runningMonitorsSpy.mockReturnValue({ data: [] });
    rerender(
      <ConversationComposerCapability
        binding={createBinding(controller, {
          kind: "pendingConversation",
          sessionId: null,
        })}
        renderingPolicy={{
          presentation: { surface: "bare", providerColumnMode: "visible" },
        }}
      />,
    );
    expect(runningMonitorsSpy).toHaveBeenLastCalledWith(null);
    expect(latestProps().queuedMessageAccessory).toBeNull();

    runningMonitorsSpy.mockClear();
    runningMonitorsSpy.mockReturnValue({ data: [] });
    const remoteController = {
      ...createController(),
      selectedRemoteHost: { id: "host-1" },
    };
    rerender(
      <ConversationComposerCapability
        binding={createBinding(remoteController as never, {
          kind: "existingSession",
          sessionId: "session-1",
        })}
        renderingPolicy={{
          presentation: { surface: "bare", providerColumnMode: "visible" },
        }}
      />,
    );
    expect(runningMonitorsSpy).toHaveBeenLastCalledWith(null);
    expect(latestProps().queuedMessageAccessory).toBeNull();
  });
});

describe("ConversationComposerCapability authority boundary", () => {
  it("does not allow presentation policy to assert durable admission authority", () => {
    const controller = createController();
    render(
      <ConversationComposerCapability
        binding={createBinding(controller, {
          kind: "existingSession",
          sessionId: "session-1",
          admission: {
            blocked: true,
            readOnlyReason: "Read only",
            blockingReason: "Read only",
          },
        })}
        renderingPolicy={{
          presentation: { surface: "pill", providerColumnMode: "visible" },
        }}
      />,
    );

    const props = latestProps();
    expect(props.surface).toBe("pill");
    expect(props.composerActions.sendDisabled).toBe(true);
    expect(props.composerActions.sendDisabledReason).toBe("Read only");
    expect(props.composerActions.onStop).toBeUndefined();
    expect(props.controls).toEqual({
      agentModelPicker: false,
      attachments: false,
      autoFocus: false,
      fileMentions: false,
      projectPicker: false,
      skills: false,
      voice: false,
    });
  });

  it("does not let rendering policy independently enable a failed target", () => {
    const controller = createController();
    const binding = createBinding(controller, {
      kind: "existingSession",
      sessionId: "session-1",
      admission: {
        blocked: true,
        blockingReason: "Session creation failed",
      },
    });
    const { rerender } = render(
      <ConversationComposerCapability
        binding={binding}
        renderingPolicy={{
          presentation: { surface: "pill", providerColumnMode: "visible" },
        }}
      />,
    );

    expect(latestProps().composerActions.sendDisabled).toBe(true);
    expect(latestProps().composerActions.sendDisabledReason).toBe(
      "Session creation failed",
    );
    expect(latestProps().composerActions.onSendQueue).toBeUndefined();

    rerender(
      <ConversationComposerCapability
        binding={binding}
        renderingPolicy={{
          presentation: { surface: "bare", providerColumnMode: "gated" },
          allowedInteractions: { controls: {} },
        }}
      />,
    );

    expect(latestProps().composerActions.sendDisabled).toBe(true);
    expect(latestProps().composerActions.sendDisabledReason).toBe(
      "Session creation failed",
    );
  });

  it("makes contradictory target authority and independent bindings unrepresentable", () => {
    const contradictoryTarget: ConversationComposerTarget = {
      kind: "pendingConversation",
      sessionId: null,
      // @ts-expect-error Pending conversations cannot independently claim read-only authority.
      readOnlyReason: "Read only",
    };
    const independentlyAssertedBinding: ConversationComposerBinding = {
      controller: createController() as never,
      target: {
        kind: "existingSession",
        sessionId: "session-1",
        admission: { blocked: false, securityConfirmationPending: false },
      },
      // @ts-expect-error The hook's private brand cannot be independently asserted.
      fakeBrand: true,
    };
    expect(contradictoryTarget.kind).toBe("pendingConversation");
    expect(independentlyAssertedBinding.target.kind).toBe("existingSession");
  });
});
