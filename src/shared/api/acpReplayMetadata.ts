import type { MessageMetadata } from "@/shared/types/messages";

type ReplayMetadataSource = {
  _meta?: Record<string, unknown> | null;
  messageId?: string | null;
};

export type ReplayAssistantMetadata = Pick<
  MessageMetadata,
  "personaId" | "personaName"
>;
export type ReplayUserMetadata = Pick<
  MessageMetadata,
  | "delivery"
  | "origin"
  | "berdSenderLabel"
  | "berdDeliveryId"
  | "voiceUtteranceId"
  | "voiceConversationLifecycleId"
  | "voiceConversationRevision"
>;

export function getReplayMessageId(
  source: ReplayMetadataSource,
): string | null {
  if (source.messageId) {
    return source.messageId;
  }

  const metaMessageId = getGooseReplayMeta(source)?.messageId;
  if (typeof metaMessageId === "string" && metaMessageId.length > 0) {
    return metaMessageId;
  }

  return null;
}

export function getReplayCreated(
  source: ReplayMetadataSource,
): number | undefined {
  const goose = getGooseReplayMeta(source);
  return coerceReplayTimestamp(goose?.created ?? goose?.createdAt);
}

export function getReplayAssistantMetadata(
  source: ReplayMetadataSource,
): ReplayAssistantMetadata | undefined {
  const goose = getGooseReplayMeta(source);
  if (!goose) {
    return undefined;
  }

  const personaId = nonEmptyString(goose.personaId);
  const personaName = nonEmptyString(goose.personaName);
  if (!personaId && !personaName) {
    return undefined;
  }

  return {
    ...(personaId ? { personaId } : {}),
    ...(personaName ? { personaName } : {}),
  };
}

export function getReplayUserMetadata(
  source: ReplayMetadataSource,
): ReplayUserMetadata | undefined {
  const goose = getGooseReplayMeta(source);
  if (!goose) {
    return undefined;
  }

  const delivery = goose.steer === true ? "steer" : undefined;
  const origin =
    goose.origin === "berdctl_cross_session"
      ? "berdctl_cross_session"
      : goose.origin === "voice_conversation"
        ? "voice_conversation"
        : undefined;
  const berdSenderLabel =
    origin === "berdctl_cross_session"
      ? boundedSingleLineString(goose.berdSenderLabel, 120)
      : undefined;
  const berdDeliveryId =
    origin === "berdctl_cross_session"
      ? boundedSingleLineString(goose.berdDeliveryId, 200)
      : undefined;
  const voiceUtteranceId =
    origin === "voice_conversation"
      ? nonEmptyString(goose.voiceUtteranceId)
      : undefined;
  const voiceConversationLifecycleId =
    origin === "voice_conversation"
      ? nonEmptyString(goose.voiceConversationLifecycleId)
      : undefined;
  const voiceConversationRevision =
    origin === "voice_conversation" &&
    typeof goose.voiceConversationRevision === "number" &&
    Number.isSafeInteger(goose.voiceConversationRevision) &&
    goose.voiceConversationRevision >= 0
      ? goose.voiceConversationRevision
      : undefined;
  if (!delivery && !origin) {
    return undefined;
  }

  return {
    ...(delivery ? { delivery } : {}),
    ...(origin ? { origin } : {}),
    ...(berdSenderLabel ? { berdSenderLabel } : {}),
    ...(berdDeliveryId ? { berdDeliveryId } : {}),
    ...(voiceUtteranceId ? { voiceUtteranceId } : {}),
    ...(voiceConversationLifecycleId ? { voiceConversationLifecycleId } : {}),
    ...(voiceConversationRevision !== undefined
      ? { voiceConversationRevision }
      : {}),
  };
}

function boundedSingleLineString(
  value: unknown,
  maxLength: number,
): string | undefined {
  const normalized = nonEmptyString(value);
  return normalized &&
    normalized.length <= maxLength &&
    !normalized.includes("\n") &&
    !normalized.includes("\r")
    ? normalized
    : undefined;
}

function getGooseReplayMeta(
  source: ReplayMetadataSource,
): Record<string, unknown> | null {
  if (!isRecord(source._meta)) {
    return null;
  }

  const goose = source._meta.goose;
  return isRecord(goose) ? goose : null;
}

function coerceReplayTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    return normalizeEpochMilliseconds(value);
  }

  return undefined;
}

function normalizeEpochMilliseconds(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
