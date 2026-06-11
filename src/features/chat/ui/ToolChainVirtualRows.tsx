import { useCallback, useSyncExternalStore } from "react";
import type { MessageContent } from "@/shared/types/messages";
import type {
  TranscriptToolChainDetailPayload,
  TranscriptToolChainPayload,
} from "@/features/chat/transcript/projection/transcriptItemTypes";
import { useOptionalTranscriptRowStateContext } from "@/features/chat/transcript/row-state";
import { ToolChainCards, type ToolChainItem } from "./ToolChainCards";

// Groups adjacent toolRequest/toolResponse blocks into ToolChainItem arrays,
// mirroring the logic in MessageBubble.groupContentSections.
function groupMessageToolChains(
  content: readonly MessageContent[],
): Array<{ chainId: string; toolItems: ToolChainItem[] }> {
  const chains: Array<{ chainId: string; toolItems: ToolChainItem[] }> = [];
  let current: ToolChainItem[] = [];
  let currentKey: string | null = null;

  const flush = () => {
    if (current.length > 0) {
      chains.push({
        chainId: currentKey ?? current[0]?.key ?? "tool-chain",
        toolItems: [...current],
      });
      current = [];
      currentKey = null;
    }
  };

  for (const [index, block] of content.entries()) {
    if (block.type === "toolRequest") {
      currentKey ??= `tool-chain-${block.id}-${index}`;
      current.push({
        key: `tool-request-${block.id}-${index}`,
        request: block,
      });
      continue;
    }
    if (block.type === "toolResponse") {
      const matchIdx = current.findIndex(
        (item) => item.request && item.request.id === block.id,
      );
      if (matchIdx !== -1) {
        const requestName = current[matchIdx]?.request?.name ?? "";
        const existing = current[matchIdx];
        if (existing) {
          current[matchIdx] = {
            ...existing,
            response: { ...block, name: block.name || requestName },
          };
        }
        continue;
      }
      currentKey ??= `tool-chain-${block.id}-${index}`;
      current.push({
        key: `tool-response-${block.id}-${index}`,
        response: block,
      });
      continue;
    }
    flush();
  }
  flush();
  return chains;
}

function useChainExpandState(chainStateId: string): boolean {
  const context = useOptionalTranscriptRowStateContext();

  const subscribe = useCallback(
    (callback: () => void) => {
      if (!context) {
        return () => {};
      }
      return context.registry.subscribeToStateChanges(callback);
    },
    [context],
  );

  const getSnapshot = useCallback(() => {
    if (!context) {
      return false;
    }
    const state = context.registry.getRowState({
      sessionId: context.sessionId,
      rowId: context.rowId,
    });
    return state?.toolChains?.[chainStateId]?.chainExpanded ?? false;
  }, [context, chainStateId]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

function ToolChainDetailItem({
  chainId,
  toolItems,
}: {
  chainId: string;
  toolItems: ToolChainItem[];
}) {
  const isExpanded = useChainExpandState(chainId);

  return (
    <ToolChainCards
      chainId={chainId}
      toolItems={toolItems}
      detailOnly
      externalChainExpanded={isExpanded}
    />
  );
}

export function ToolChainSummaryMessageBubble({
  payload,
}: {
  payload: TranscriptToolChainPayload;
}) {
  const chains = groupMessageToolChains(payload.message.content);
  return (
    <>
      {chains.map(({ chainId, toolItems }) => (
        <ToolChainCards
          key={chainId}
          chainId={chainId}
          toolItems={toolItems}
          hasDetailRow
        />
      ))}
    </>
  );
}

export function ToolChainDetailMessage({
  payload,
}: {
  payload: TranscriptToolChainDetailPayload;
}) {
  const chains = groupMessageToolChains(payload.message.content);
  return (
    <>
      {chains.map(({ chainId, toolItems }) => (
        <ToolChainDetailItem
          key={chainId}
          chainId={chainId}
          toolItems={toolItems}
        />
      ))}
    </>
  );
}
