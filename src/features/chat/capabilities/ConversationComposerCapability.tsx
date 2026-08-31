import { useCallback, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { summarizeProjectWorkspaceStartup } from "@/features/projects/lib/projectChatWorkspaces";
import type {
  ChatInputControls,
  ChatInputVoiceConversation,
} from "@/features/chat/types";
import {
  useChatSessionController,
  type WorkspaceNameRequest,
} from "@/features/chat/hooks/useChatSessionController";
import { ChatInput } from "@/features/chat/ui/ChatInput";
import { WorkspaceSetupChoice } from "@/features/chat/ui/WorkspaceSetupChoice";
import {
  useSessionAddressedComposerAdmission,
  type SessionAddressedComposerAdmission,
} from "@/features/chat/hooks/useSessionAddressedComposerAdmission";

export type ConversationComposerTarget =
  | {
      kind: "pendingConversation";
      sessionId: string | null;
    }
  | {
      kind: "existingSession";
      sessionId: string;
      admission: SessionAddressedComposerAdmission;
    };

export interface ConversationComposerRenderingPolicy {
  presentation: {
    surface: "pill" | "bare";
    innerBareSurface?: boolean;
    providerColumnMode: "visible" | "gated";
  };
  allowedInteractions?: {
    controls?: ChatInputControls;
    allowRecallLastMessage?: boolean;
  };
  lifecycleConstraints?: {
    handoff?: { active: boolean; inProgress: boolean };
    voiceConversation?: ChatInputVoiceConversation;
  };
}

const conversationComposerBindingBrand: unique symbol = Symbol(
  "ConversationComposerBinding",
);

interface UseConversationComposerBindingOptions {
  target:
    | Extract<ConversationComposerTarget, { kind: "pendingConversation" }>
    | {
        kind: "existingSession";
        sessionId: string;
        sessionSnapshot?: Parameters<
          typeof useSessionAddressedComposerAdmission
        >[0]["sessionSnapshot"];
        readOnlyReason?: string;
        readOnlyWhenOpenInAnotherWindow?: boolean;
      };
  onMessageAccepted?: (sessionId: string) => void;
  onCreatePersonaRequested?: () => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
}

export function useConversationComposerBinding({
  target: requestedTarget,
  onMessageAccepted,
  onCreatePersonaRequested,
  onWorkspaceNameRequest,
}: UseConversationComposerBindingOptions) {
  const admission = useSessionAddressedComposerAdmission({
    sessionId:
      requestedTarget.kind === "existingSession"
        ? requestedTarget.sessionId
        : null,
    sessionSnapshot:
      requestedTarget.kind === "existingSession"
        ? requestedTarget.sessionSnapshot
        : undefined,
    readOnlyReason:
      requestedTarget.kind === "existingSession"
        ? requestedTarget.readOnlyReason
        : undefined,
    readOnlyWhenOpenInAnotherWindow:
      requestedTarget.kind === "existingSession"
        ? requestedTarget.readOnlyWhenOpenInAnotherWindow
        : false,
  });
  const target: ConversationComposerTarget =
    requestedTarget.kind === "existingSession"
      ? {
          kind: "existingSession",
          sessionId: requestedTarget.sessionId,
          admission,
        }
      : requestedTarget;
  const controller = useChatSessionController({
    sessionId: target.sessionId,
    isHomeSession: target.kind === "pendingConversation",
    readOnly:
      target.kind === "existingSession" &&
      Boolean(target.admission.readOnlyReason),
    onMessageAccepted,
    onCreatePersonaRequested,
    onWorkspaceNameRequest,
  });

  const admissionBlockingReason =
    target.kind === "existingSession"
      ? target.admission.blockingReason
      : undefined;
  const admissionBlocked =
    target.kind === "existingSession" && target.admission.blocked;
  const rejectSend = useCallback(
    (..._args: Parameters<typeof controller.handleSend>) => false,
    [],
  );
  const onSend = admissionBlocked ? rejectSend : controller.handleSend;

  return {
    controller,
    target,
    admissionBlockingReason,
    admissionBlocked,
    onSend,
    onSendQueue: admissionBlocked ? undefined : controller.sendDeferredAnyway,
    [conversationComposerBindingBrand]: true as const,
  };
}

export type ConversationComposerBinding = ReturnType<
  typeof useConversationComposerBinding
>;

interface ConversationComposerCapabilityProps {
  binding: ConversationComposerBinding;
  renderingPolicy: ConversationComposerRenderingPolicy;
  onCreateProject?: (options?: {
    onCreated?: (projectId: string) => void;
  }) => void;
  onRecallLastUserMessage?: () => string | null;
  attachmentDropTargetRef?: RefObject<HTMLDivElement | null>;
  onAttachmentDragOverChange?: (isDragOver: boolean) => void;
}

export function ConversationComposerCapability({
  binding,
  renderingPolicy,
  onCreateProject,
  onRecallLastUserMessage,
  attachmentDropTargetRef,
  onAttachmentDragOverChange,
}: ConversationComposerCapabilityProps) {
  const { t } = useTranslation("chat");
  const {
    controller,
    target,
    admissionBlockingReason,
    admissionBlocked,
    onSend,
    onSendQueue,
  } = binding;
  const isPendingConversation = target.kind === "pendingConversation";
  // A remote host without a chosen remote folder cannot start a session, so
  // the send is blocked with an actionable reason until a folder is picked.
  const remoteDirMissing = Boolean(
    controller.remoteHostSelectionEnabled &&
      controller.selectedRemoteHost &&
      !controller.selectedRemoteDir,
  );
  const remoteDirMissingReason = remoteDirMissing
    ? t("toolbar.remoteHost.missingDirectory")
    : undefined;
  const readOnlyReason =
    target.kind === "existingSession"
      ? target.admission.readOnlyReason
      : undefined;
  const isReadOnly = Boolean(readOnlyReason);
  const lifecycle = renderingPolicy.lifecycleConstraints;
  const securityConfirmationPending =
    target.kind === "existingSession" &&
    target.admission.securityConfirmationPending;
  const handoffActive = lifecycle?.handoff?.active === true;
  const handoffInProgress = lifecycle?.handoff?.inProgress === true;
  const deferredWorkspaceInFlight =
    controller.deferredWorkspaceRecord?.state.status === "naming" ||
    controller.deferredWorkspaceRecord?.state.status === "creating";
  const queueRecords = isPendingConversation
    ? (controller.queue.queuedRecords ?? [])
    : (controller.queue.queuedRecords ??
      (controller.queue.queuedRecord ? [controller.queue.queuedRecord] : []));
  const visibleQueueRecords = isPendingConversation
    ? queueRecords.filter(
        (record) => !(record.kind === "deferred" && deferredWorkspaceInFlight),
      )
    : queueRecords;
  const workspaceSetup =
    controller.defaultWorkspaceSetup ??
    controller.deferredWorkspaceRecord?.state;
  const deferredWorkspaceStartup = summarizeProjectWorkspaceStartup(
    workspaceSetup?.desired ?? [],
  );
  const policyControls = renderingPolicy.allowedInteractions?.controls;
  const controls: ChatInputControls | undefined = isReadOnly
    ? {
        agentModelPicker: false,
        attachments: false,
        autoFocus: false,
        fileMentions: false,
        projectPicker: false,
        skills: false,
        voice: false,
      }
    : !controller.skillsEnabled || handoffActive || policyControls
      ? {
          ...policyControls,
          ...(!controller.skillsEnabled ? { skills: false } : {}),
          ...(handoffActive ? { autoFocus: false } : {}),
        }
      : undefined;
  return (
    <ChatInput
      className={securityConfirmationPending ? "hidden" : undefined}
      surface={renderingPolicy.presentation.surface}
      innerBareSurface={renderingPolicy.presentation.innerBareSurface}
      controls={controls}
      queuedMessageAccessory={
        controller.unresolvedDeferredSend ? (
          <p className="text-xs text-destructive" role="alert">
            {controller.deferredWorkspaceError}
          </p>
        ) : !isPendingConversation &&
          !isReadOnly &&
          deferredWorkspaceStartup.worktreeCount > 0 &&
          (workspaceSetup?.status === "choice" ||
            workspaceSetup?.status === "naming" ||
            workspaceSetup?.status === "creating") ? (
          <WorkspaceSetupChoice
            state={workspaceSetup.status}
            worktreeCount={deferredWorkspaceStartup.worktreeCount}
            branchCount={deferredWorkspaceStartup.branchCount}
            exactCounts={deferredWorkspaceStartup.exact}
            error={workspaceSetup.error}
            onCancelName={controller.cancelDeferredWorkspaceName}
            onCreate={controller.createDeferredWorkspace}
            onSubmitName={controller.submitDeferredWorkspaceName}
            onSkip={controller.skipDeferredWorkspace}
          />
        ) : null
      }
      skillProjectDirs={
        isPendingConversation ? undefined : controller.skillProjectDirs
      }
      fileMentionProjectDirs={
        isPendingConversation ? undefined : controller.fileMentionProjectDirs
      }
      skillProviderId={
        isPendingConversation ? undefined : controller.selectedProvider
      }
      composerActions={{
        onSend,
        onSteerMessage:
          isPendingConversation || admissionBlocked
            ? undefined
            : (text, personaId, attachments, options) =>
                controller.steerDraftMessage(
                  text,
                  personaId ?? undefined,
                  attachments,
                  options,
                ),
        canSteerMessage:
          isPendingConversation || admissionBlocked
            ? false
            : controller.canSteerMessage,
        onSteerQueuedMessage: admissionBlocked
          ? undefined
          : controller.steerQueuedMessage,
        canSteerQueuedMessage:
          !admissionBlocked && controller.canSteerQueuedMessage,
        disabled: isPendingConversation
          ? controller.projectMetadataPending
          : admissionBlocked ||
            controller.projectMetadataPending ||
            controller.isCompactingContext,
        sendDisabled: isPendingConversation
          ? remoteDirMissing || undefined
          : admissionBlocked ||
            controller.workspaceSetupInProgress ||
            remoteDirMissing,
        sendDisabledReason: admissionBlockingReason ?? remoteDirMissingReason,
        queuedMessage: handoffInProgress
          ? null
          : (controller.queue.queuedMessage ??
            controller.deferredWorkspaceRecord?.payload ??
            null),
        queuedMessages: handoffInProgress
          ? []
          : visibleQueueRecords.map((record) => ({
              recordId: record.recordId,
              payload: record.payload,
            })),
        onUpdateQueue:
          isPendingConversation && deferredWorkspaceInFlight
            ? undefined
            : controller.queue.update,
        onEditQueue:
          isPendingConversation && deferredWorkspaceInFlight
            ? undefined
            : controller.queue.beginEditing,
        onCancelQueueEdit:
          isPendingConversation && deferredWorkspaceInFlight
            ? undefined
            : controller.queue.cancelEditing,
        onSendQueue:
          !controller.unresolvedDeferredSend &&
          (controller.deferredWorkspaceRecord?.state.status === "failed" ||
            controller.deferredWorkspaceRecord?.state.status === "held")
            ? onSendQueue
            : undefined,
        onDismissQueue:
          handoffInProgress || isReadOnly || deferredWorkspaceInFlight
            ? undefined
            : controller.queue.dismiss,
        onStop: isReadOnly ? undefined : controller.stopStreaming,
        isStreaming:
          !isReadOnly &&
          (controller.chatState === "streaming" ||
            controller.chatState === "thinking"),
        voiceConversation: lifecycle?.voiceConversation,
      }}
      onRecallLastUserMessage={
        isReadOnly ||
        renderingPolicy.allowedInteractions?.allowRecallLastMessage === false
          ? undefined
          : onRecallLastUserMessage
      }
      attachmentDropTargetRef={attachmentDropTargetRef}
      onAttachmentDragOverChange={onAttachmentDragOverChange}
      attachmentsEnabled={!controller.selectedRemoteHost}
      initialValue={controller.draftValue}
      initialAttachments={controller.draftAttachments}
      onDraftChange={controller.handleDraftChange}
      onDraftAttachmentsChange={controller.handleDraftAttachmentsChange}
      selectedSkills={controller.selectedSkills}
      onSkillsChange={controller.handleSkillsChange}
      personaPicker={{
        personas: controller.personas,
        selectedPersonaId: controller.selectedPersonaId,
        onPersonaChange: controller.handlePersonaChange,
      }}
      agentModelPicker={{
        providers: controller.pickerAgents,
        providersLoading: controller.providersLoading,
        selectedProvider: controller.selectedProvider,
        onProviderChange: controller.handleProviderChange,
        currentModelId: controller.currentModelId,
        currentModelProviderId: controller.currentModelProviderId,
        currentModel: controller.currentModelName ?? undefined,
        currentExecutionTarget: controller.currentExecutionTarget,
        availableModels: controller.availableModels,
        modelsLoading: controller.modelsLoading,
        modelStatusMessage: controller.modelStatusMessage,
        onModelChange: controller.handleModelChange,
        onPickerOpen: controller.handlePickerOpen,
        providerColumnMode: renderingPolicy.presentation.providerColumnMode,
      }}
      reasoningEffort={{
        config: controller.reasoningEffort,
        onChange: controller.handleReasoningEffortChange,
      }}
      projectPicker={{
        selectedProjectId: controller.selectedProjectId,
        availableProjects: controller.availableProjects,
        onProjectChange: controller.handleProjectChange,
        onCreateProject: (options) =>
          onCreateProject?.({
            onCreated: (projectId) => {
              controller.handleProjectChange(projectId);
              options?.onCreated?.(projectId);
            },
          }),
      }}
      remoteHostPicker={{
        enabled: controller.remoteHostSelectionEnabled,
        selectedHost: controller.selectedRemoteHost,
        onHostChange: controller.handleRemoteHostChange,
        selectedDir: controller.selectedRemoteDir,
        onDirChange: controller.handleRemoteDirChange,
      }}
      contextUsage={{
        contextTokens: controller.tokenState.accumulatedTotal,
        contextLimit: controller.tokenState.contextLimit,
        accumulatedCost: controller.tokenState.accumulatedCost,
        isContextUsageReady: controller.isContextUsageReady,
        ...(!isPendingConversation
          ? {
              onCompactContext: controller.compactConversation,
              canCompactContext: controller.canCompactContext,
              isCompactingContext: controller.isCompactingContext,
              supportsCompactionControls: controller.supportsCompactionControls,
            }
          : {}),
      }}
    />
  );
}
