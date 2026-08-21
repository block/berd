import { serializeMessageResponseSelection } from "@/shared/ui/ai-elements/message-response-selection";
import type { Message, StagedQuoteItem } from "@/shared/types/messages";

const MESSAGE_ID_ATTRIBUTE = "data-quote-message-id";
const MESSAGE_ROLE_ATTRIBUTE = "data-quote-message-role";
const QUOTE_SURFACE_ATTRIBUTE = "data-quote-surface";

export const QUOTE_MESSAGE_SELECTOR = `[${MESSAGE_ID_ATTRIBUTE}]`;
export const QUOTE_SURFACE_SELECTOR = `[${QUOTE_SURFACE_ATTRIBUTE}]`;

export function quoteMessageAttributes(
  messageId: string,
  role: "user" | "assistant" | "system",
) {
  return {
    [MESSAGE_ID_ATTRIBUTE]: messageId,
    [MESSAGE_ROLE_ATTRIBUTE]: role,
  };
}

export function quoteSurfaceAttributes() {
  return { [QUOTE_SURFACE_ATTRIBUTE]: "true" };
}

function elementFromNode(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function intersects(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function messageOwner(node: Node): Element | null {
  return elementFromNode(node)?.closest(QUOTE_MESSAGE_SELECTOR) ?? null;
}

/** Captures selected rendered text inside exactly one logical message. */
export function stagedQuoteFromSelection({
  messages,
  root,
  selection,
  id = crypto.randomUUID(),
}: {
  messages: readonly Message[];
  root: HTMLElement;
  selection: Selection;
  id?: string;
}): StagedQuoteItem | null {
  if (selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const startOwner = messageOwner(range.startContainer);
  const endOwner = messageOwner(range.endContainer);
  const messageId = startOwner?.getAttribute(MESSAGE_ID_ATTRIBUTE);
  if (
    !messageId ||
    endOwner?.getAttribute(MESSAGE_ID_ATTRIBUTE) !== messageId
  ) {
    return null;
  }

  const message = messages.find((candidate) => candidate.id === messageId);
  if (!message || (message.role !== "user" && message.role !== "assistant")) {
    return null;
  }

  const excerpts = Array.from(
    root.querySelectorAll<HTMLElement>(QUOTE_SURFACE_SELECTOR),
  )
    .filter(
      (surface) =>
        surface
          .closest(QUOTE_MESSAGE_SELECTOR)
          ?.getAttribute(MESSAGE_ID_ATTRIBUTE) === messageId &&
        intersects(range, surface),
    )
    .map((surface) => serializeMessageResponseSelection(surface, range))
    .filter((excerpt): excerpt is string => Boolean(excerpt));
  const excerpt = excerpts.join("\n\n");
  if (!excerpt.trim()) return null;

  return {
    id,
    kind: "quote",
    excerpt,
    source: { messageId, role: message.role },
  };
}

export function getQuoteAffordancePosition(
  range: Range,
  root: HTMLElement,
): { left: number; top: number } | null {
  const rects = Array.from(
    typeof range.getClientRects === "function" ? range.getClientRects() : [],
  ).filter((rect) => rect.width > 0 || rect.height > 0);
  let anchor: { left: number; width: number; top: number };
  if (rects.length > 0) {
    const firstLine = rects[0];
    let left = firstLine.left;
    let right = firstLine.right;
    for (const rect of rects) {
      const centerY = rect.top + rect.height / 2;
      if (centerY < firstLine.top || centerY > firstLine.bottom) continue;
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
    anchor = { left, width: right - left, top: firstLine.top };
  } else {
    const boundingRect = range.getBoundingClientRect();
    if (boundingRect.width === 0 && boundingRect.height === 0) return null;
    anchor = {
      left: boundingRect.left,
      width: boundingRect.width,
      top: boundingRect.top,
    };
  }
  const rootRect = root.getBoundingClientRect();
  return {
    left: Math.min(
      Math.max(anchor.left + anchor.width / 2 - rootRect.left, 16),
      Math.max(16, rootRect.width - 16),
    ),
    top: Math.max(anchor.top - rootRect.top - 8, 8),
  };
}
