import type {
  ToolCallLocation,
  ToolRequestContent,
} from "@/shared/types/messages";
import { stableValueRevision } from "./messageRevisions";
import type {
  TranscriptArtifactDescriptor,
  TranscriptArtifactIndex,
  TranscriptItemDescriptor,
} from "./transcriptItemTypes";

interface BuildTranscriptArtifactIndexInput {
  sessionId: string;
  items: readonly TranscriptItemDescriptor[];
  previous?: TranscriptArtifactIndex;
}

interface TranscriptArtifactKeyInput {
  sessionId: string;
  messageId: string;
  toolRequestId: string;
  locationRevision: string;
}

export function buildTranscriptArtifactIndex({
  sessionId,
  items,
  previous,
}: BuildTranscriptArtifactIndexInput): TranscriptArtifactIndex {
  const artifacts: TranscriptArtifactDescriptor[] = [];
  const artifactByKey = new Map<string, TranscriptArtifactDescriptor>();
  const artifactKeysByMessageId = new Map<string, string[]>();
  const artifactKeysByToolRequestId = new Map<string, string[]>();
  const artifactKeysByRowId = new Map<string, string[]>();
  const changedArtifactKeys = new Set<string>();

  for (const item of items) {
    if (item.kind !== "message" && item.kind !== "agent-work") {
      continue;
    }

    const visibleContent =
      item.kind === "agent-work" ? item.message.content : item.visibleContent;

    visibleContent.forEach((content, contentIndex) => {
      if (content.type !== "toolRequest") {
        return;
      }

      const locations = content.locations?.filter(isArtifactLocation) ?? [];
      for (const location of locations) {
        const path = normalizeArtifactPath(location.path);
        const normalizedLocation = { ...location, path };
        const locationRevision = stableValueRevision(normalizedLocation);
        const artifactKey = buildTranscriptArtifactKey({
          sessionId,
          messageId: item.messageId,
          toolRequestId: content.id,
          locationRevision,
        });

        if (artifactByKey.has(artifactKey)) {
          continue;
        }

        const nextArtifact: TranscriptArtifactDescriptor = {
          artifactKey,
          sessionId,
          rowId: item.rowId,
          messageId: item.messageId,
          blockId:
            "blockIds" in item
              ? (item.blockIds[contentIndex] ?? `toolRequest:${content.id}`)
              : `toolRequest:${content.id}`,
          toolRequestId: content.id,
          toolName: getToolName(content),
          toolKind: content.toolKind,
          location: normalizedLocation,
          locationRevision,
          path,
          line: location.line ?? null,
          messageCreated: item.message.created,
        };
        const previousArtifact = previous?.artifactByKey.get(artifactKey);
        const artifact =
          previousArtifact &&
          canReuseTranscriptArtifactDescriptor(previousArtifact, nextArtifact)
            ? previousArtifact
            : nextArtifact;

        if (artifact !== previousArtifact) {
          changedArtifactKeys.add(artifactKey);
        }

        artifacts.push(artifact);
        artifactByKey.set(artifactKey, artifact);
        appendMapValue(
          artifactKeysByMessageId,
          item.messageId,
          artifact.artifactKey,
        );
        appendMapValue(
          artifactKeysByToolRequestId,
          content.id,
          artifact.artifactKey,
        );
        appendMapValue(artifactKeysByRowId, item.rowId, artifact.artifactKey);
      }
    });
  }

  if (previous) {
    for (const artifactKey of previous.artifactByKey.keys()) {
      if (!artifactByKey.has(artifactKey)) {
        changedArtifactKeys.add(artifactKey);
      }
    }
  }

  return {
    artifacts,
    artifactByKey,
    artifactKeysByMessageId,
    artifactKeysByToolRequestId,
    artifactKeysByRowId,
    changedArtifactKeys,
  };
}

export function buildTranscriptArtifactKey({
  sessionId,
  messageId,
  toolRequestId,
  locationRevision,
}: TranscriptArtifactKeyInput): string {
  return ["artifact", sessionId, messageId, toolRequestId, locationRevision]
    .map(encodeURIComponent)
    .join(":");
}

export function canReuseTranscriptArtifactDescriptor(
  previous: TranscriptArtifactDescriptor,
  next: TranscriptArtifactDescriptor,
): boolean {
  return (
    previous.artifactKey === next.artifactKey &&
    previous.sessionId === next.sessionId &&
    previous.rowId === next.rowId &&
    previous.messageId === next.messageId &&
    previous.blockId === next.blockId &&
    previous.toolRequestId === next.toolRequestId &&
    previous.toolName === next.toolName &&
    previous.toolKind === next.toolKind &&
    previous.locationRevision === next.locationRevision &&
    previous.path === next.path &&
    previous.line === next.line &&
    previous.messageCreated === next.messageCreated
  );
}

function isArtifactLocation(
  location: ToolCallLocation,
): location is ToolCallLocation & { path: string } {
  return (
    typeof location.path === "string" &&
    normalizeArtifactPath(location.path).length > 0
  );
}

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/").trim();
}

function getToolName(content: ToolRequestContent): string {
  return content.toolName ?? content.name;
}

function appendMapValue(
  map: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const values = map.get(key);
  if (values) {
    values.push(value);
    return;
  }

  map.set(key, [value]);
}
