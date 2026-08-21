import type { CreatePersonaRequest, Persona } from "@/shared/types/agents";
import { getRealPersonaDescription } from "@/features/agents/lib/personaPresentation";
import { truncateCardGraphemes } from "@/features/agents/ui/share-card/agentShareCardText";
import {
  isRemoteAvatarUrl,
  isSafePngAvatarDataUrl,
} from "@/shared/lib/avatarUrl";
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type SnapshotV1,
  validateSnapshotV1,
} from "./schema";

export interface SnapshotMappingSupport {
  /** Return true only when this exact provider/model can be selected locally. */
  supportsConfiguration?: (provider: string, model: string) => boolean;
}

/** Maps portable fields only; identity, memory, runtime, commands, and unknown fields are ignored. */
export function snapshotToCreatePersonaRequest(
  input: SnapshotV1,
  support: SnapshotMappingSupport = {},
): CreatePersonaRequest {
  const snapshot = validateSnapshotV1(input);
  const displayName =
    snapshot.profile?.displayName?.trim() || snapshot.definition.name?.trim();
  // Validation guarantees one of the two names is non-empty.
  const request: CreatePersonaRequest = {
    displayName: displayName as string,
    systemPrompt: snapshot.definition.systemPrompt ?? "",
  };

  const provider = snapshot.definition.provider?.trim();
  const model = snapshot.definition.model?.trim();
  if (
    provider &&
    model &&
    (support.supportsConfiguration?.(provider, model) ?? true)
  ) {
    request.provider = provider;
    request.modelProviderId =
      snapshot.definition.modelProviderId?.trim() || undefined;
    request.model = model;
  }
  const about = snapshot.profile?.about;
  if (typeof about === "string" && about.trim()) {
    request.description = truncateCardGraphemes(about.trim(), 110);
  }
  const avatarDataUrl = snapshot.profile?.avatarDataUrl;
  if (
    typeof avatarDataUrl === "string" &&
    isSafePngAvatarDataUrl(avatarDataUrl)
  ) {
    request.avatar = avatarDataUrl;
  }
  // Remote avatar URLs are intentionally not persisted: importing an image
  // must not opt the user into future requests to an untrusted host.
  return request;
}

/** Creates a deterministic, config-only snapshot without persistent or secret persona metadata. */
export function personaToSnapshot(persona: Persona): SnapshotV1 {
  const displayName = persona.displayName.trim();
  const authoredDescription = getRealPersonaDescription(persona);
  const snapshot: SnapshotV1 = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    definition: {
      name: displayName,
      systemPrompt: persona.systemPrompt,
      runtime: null,
      model: persona.model ?? null,
      modelProviderId: persona.modelProviderId ?? null,
      provider: persona.provider ?? null,
      parallelism: 1,
      respondTo: null,
      respondToAllowlist: [],
      namePool: [],
      idleTimeoutSeconds: null,
      maxTurnDurationSeconds: null,
    },
    profile: {
      displayName,
      about: authoredDescription
        ? truncateCardGraphemes(authoredDescription, 110)
        : null,
      avatarDataUrl:
        typeof persona.avatar === "string" &&
        isSafePngAvatarDataUrl(persona.avatar)
          ? persona.avatar
          : null,
      avatarUrl:
        typeof persona.avatar === "string" && isRemoteAvatarUrl(persona.avatar)
          ? persona.avatar.trim()
          : null,
    },
  };
  return validateSnapshotV1(snapshot);
}
