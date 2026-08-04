import { useCallback } from "react";
import agentBuilderSkillBody from "../../../../distro/skills/agent-builder/SKILL.md?raw";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type {
  ChatInputSendHandler,
  ChatSendOptions,
} from "@/features/chat/types";

export function resolveAgentBuilderSkillBody(
  skillBody = agentBuilderSkillBody,
) {
  return skillBody;
}

const SKILL_BODY = resolveAgentBuilderSkillBody();
const sentStaticPromptByPath = new Set<string>();

export function composeBuilderSendOptions(
  session:
    | Pick<ChatSession, "intent" | "agentBuilderOpen" | "targetAgentPath">
    | null
    | undefined,
  options: ChatSendOptions = {},
): ChatSendOptions {
  if (
    session?.intent !== "build-agent" ||
    session.agentBuilderOpen === false ||
    !session.targetAgentPath
  ) {
    return options;
  }

  const pathNote = [
    "agent-builder session path instructions:",
    "This session is bound to an existing draft that the Goose UI is previewing.",
    "These instructions override the generic create/rename workflow above:",
    `- Edit exactly this file: ${session.targetAgentPath}`,
    "- Do not rename, move, delete, or replace it with a new slug-named file.",
    "- Update the frontmatter name for the agent's display name, but keep the filename/path unchanged.",
    "- Preserve every existing frontmatter key, especially draft and builderSessionId.",
  ].join("\n");
  const existingAssistantPrompt = options.assistantPrompt?.trim();
  const hasStaticPrompt =
    existingAssistantPrompt?.includes(SKILL_BODY.trim()) ?? false;
  const shouldSendStaticPrompt =
    !hasStaticPrompt && !sentStaticPromptByPath.has(session.targetAgentPath);
  const builderPrompt = shouldSendStaticPrompt
    ? `${SKILL_BODY}\n\n${pathNote}`
    : pathNote;
  sentStaticPromptByPath.add(session.targetAgentPath);

  return {
    ...options,
    assistantPrompt: existingAssistantPrompt
      ? `${builderPrompt}\n\n${existingAssistantPrompt}`
      : builderPrompt,
  };
}

export function useBuilderSendInterceptor(
  session:
    | Pick<ChatSession, "intent" | "agentBuilderOpen" | "targetAgentPath">
    | null
    | undefined,
  baseSend: ChatInputSendHandler,
): ChatInputSendHandler {
  return useCallback(
    (text, personaId, attachments, options) =>
      baseSend(
        text,
        personaId,
        attachments,
        composeBuilderSendOptions(session, options),
      ),
    [baseSend, session],
  );
}
