import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEventHandler,
  type HTMLAttributes,
  type ReactNode,
  type RefCallback,
} from "react";
import type {
  TranscriptDurableRowState,
  TranscriptMcpActivityKind,
  TranscriptOpenOverlayKind,
  TranscriptRowStatePatchInput,
  TranscriptRowStateUpdateInput,
  TranscriptRowStateRegistry,
} from "./transcriptRowStateRegistry";

interface TranscriptRowStateContextValue {
  registry: TranscriptRowStateRegistry;
  sessionId: string;
  rowId: string;
  sessionEpoch?: number;
  getNowMs?: () => number;
  onRowStateChange?: () => void;
  /**
   * Pin the transcript to its current position, dropping bottom-follow, before
   * this row changes height in place. Without it, an in-place expand while the
   * viewport is pinned to the bottom scrolls the reader past what they revealed.
   */
  onPinScrollAnchor?: () => void;
}

export interface TranscriptRowStateProviderProps
  extends TranscriptRowStateContextValue {
  children: ReactNode;
}

interface TranscriptRowRootAttributes
  extends Pick<HTMLAttributes<HTMLDivElement>, "onFocus" | "onBlur"> {
  ref?: RefCallback<HTMLDivElement>;
  "data-virtual-row-state"?: "enabled";
  "data-virtual-row-state-row-id"?: string;
}

export interface TranscriptRowStateAdapter {
  enabled: boolean;
  rowState: TranscriptDurableRowState | undefined;
  patchRowState: (
    patch: Partial<TranscriptDurableRowState>,
    options?: { markRecent?: boolean },
  ) => TranscriptDurableRowState | undefined;
  updateRowState: (
    updater: TranscriptRowStateUpdateInput["updater"],
    options?: { markRecent?: boolean },
  ) => TranscriptDurableRowState | undefined;
  markRowInteracted: (sourceId?: string) => boolean;
  /**
   * Pin the transcript where it sits before this row changes height in place,
   * so an expand/collapse does not get overridden by bottom-follow.
   */
  pinScrollAnchor: () => void;
}

export interface TranscriptMcpActivityReporter {
  enabled: boolean;
  setMcpActivity: (
    kind: TranscriptMcpActivityKind,
    active: boolean,
    options?: { sourceId?: string; ttlMs?: number },
  ) => boolean;
  patchMcpAppState: (
    patch: NonNullable<TranscriptDurableRowState["mcpApp"]>,
    options?: { markRecent?: boolean },
  ) => TranscriptDurableRowState | undefined;
}

const ROW_FOCUS_SOURCE_ID = "row-focus";
const ACTIVE_STREAM_SOURCE_ID = "message-stream";
const ACTIVE_TOOL_SOURCE_ID = "active-tool";

export const TRANSCRIPT_SELECTED_TEXT_CONTEXT_MENU_EVENT =
  "goose:transcript-selected-text-context-menu";

export interface TranscriptSelectedTextContextMenuEventDetail {
  open: boolean;
  ranges: readonly Range[];
}

const TranscriptRowStateContext =
  createContext<TranscriptRowStateContextValue | null>(null);

export function TranscriptRowStateProvider({
  registry,
  sessionId,
  rowId,
  sessionEpoch,
  getNowMs,
  onRowStateChange,
  onPinScrollAnchor,
  children,
}: TranscriptRowStateProviderProps) {
  const value = useMemo(
    () => ({
      registry,
      sessionId,
      rowId,
      sessionEpoch,
      getNowMs,
      onRowStateChange,
      onPinScrollAnchor,
    }),
    [
      getNowMs,
      onPinScrollAnchor,
      onRowStateChange,
      registry,
      rowId,
      sessionEpoch,
      sessionId,
    ],
  );

  return (
    <TranscriptRowStateContext.Provider value={value}>
      {children}
    </TranscriptRowStateContext.Provider>
  );
}

export function useOptionalTranscriptRowStateContext() {
  return useContext(TranscriptRowStateContext);
}

export function useTranscriptRowStateValue():
  | TranscriptDurableRowState
  | undefined {
  const context = useOptionalTranscriptRowStateContext();
  return useMemo(
    () =>
      context
        ? context.registry.getRowState(getLookupInput(context))
        : undefined,
    [context],
  );
}

export function useTranscriptRowStateAdapter(): TranscriptRowStateAdapter {
  const context = useOptionalTranscriptRowStateContext();
  const rowState = useTranscriptRowStateValue();

  const patchRowState = useCallback<TranscriptRowStateAdapter["patchRowState"]>(
    (patch, options) => {
      if (!context) {
        return undefined;
      }

      const nextState = context.registry.patchRowState({
        ...getLookupInput(context),
        markRecent: options?.markRecent,
        patch,
      });
      notifyRowStateChange(context, nextState !== undefined);
      return nextState;
    },
    [context],
  );

  const updateRowState = useCallback<
    TranscriptRowStateAdapter["updateRowState"]
  >(
    (updater, options) => {
      if (!context) {
        return undefined;
      }

      const nextState = context.registry.updateRowState({
        ...getLookupInput(context),
        markRecent: options?.markRecent,
        updater,
      });
      notifyRowStateChange(context, nextState !== undefined);
      return nextState;
    },
    [context],
  );

  const markRowInteracted = useCallback<
    TranscriptRowStateAdapter["markRowInteracted"]
  >(
    (sourceId = "row-interaction") => {
      if (!context) {
        return false;
      }

      const changed = context.registry.markRowInteracted({
        ...getLookupInput(context),
        sourceId,
      });
      notifyRowStateChange(context, changed);
      return changed;
    },
    [context],
  );

  const pinScrollAnchor = useCallback<
    TranscriptRowStateAdapter["pinScrollAnchor"]
  >(() => {
    context?.onPinScrollAnchor?.();
  }, [context]);

  return useMemo(
    () => ({
      enabled: context !== null,
      rowState,
      patchRowState,
      updateRowState,
      markRowInteracted,
      pinScrollAnchor,
    }),
    [
      context,
      markRowInteracted,
      patchRowState,
      pinScrollAnchor,
      rowState,
      updateRowState,
    ],
  );
}

export function useTranscriptRowRootAdapter(): TranscriptRowRootAttributes {
  const context = useOptionalTranscriptRowStateContext();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const selectedTextContextMenuActiveRef = useRef(false);

  const ref = useCallback<RefCallback<HTMLDivElement>>((nextElement) => {
    setElement(nextElement);
  }, []);

  const onFocus = useCallback<FocusEventHandler<HTMLDivElement>>(
    (event) => {
      if (!context) {
        return;
      }

      notifyRowStateChange(
        context,
        context.registry.setFocusedRow({
          ...getLookupInput(context),
          focused: true,
          focusTargetId: getFocusTargetId(event.target),
          sourceId: ROW_FOCUS_SOURCE_ID,
        }),
      );
    },
    [context],
  );

  const onBlur = useCallback<FocusEventHandler<HTMLDivElement>>(
    (event) => {
      if (!context) {
        return;
      }

      const nextFocusedNode = event.relatedTarget;
      if (
        nextFocusedNode instanceof Node &&
        event.currentTarget.contains(nextFocusedNode)
      ) {
        return;
      }

      notifyRowStateChange(
        context,
        context.registry.setFocusedRow({
          ...getLookupInput(context),
          focused: false,
          sourceId: ROW_FOCUS_SOURCE_ID,
        }),
      );
    },
    [context],
  );

  useEffect(() => {
    if (!context || !element) {
      return;
    }

    const view = element.ownerDocument.defaultView;

    const updateSelectedTextContextMenuProtection = (event: Event) => {
      const detail = (
        event as CustomEvent<TranscriptSelectedTextContextMenuEventDetail>
      ).detail;
      if (!detail) {
        return;
      }

      const intersects = rangesIntersectElement(detail.ranges, element);
      if (!intersects && !selectedTextContextMenuActiveRef.current) {
        return;
      }

      selectedTextContextMenuActiveRef.current = detail.open && intersects;
      notifyRowStateChange(
        context,
        context.registry.setOpenOverlay({
          ...getLookupInput(context),
          open: detail.open && intersects,
          overlayKind: "context-menu",
          overlayId: "selected-text",
        }),
      );
    };

    view?.addEventListener(
      TRANSCRIPT_SELECTED_TEXT_CONTEXT_MENU_EVENT,
      updateSelectedTextContextMenuProtection,
    );

    return () => {
      view?.removeEventListener(
        TRANSCRIPT_SELECTED_TEXT_CONTEXT_MENU_EVENT,
        updateSelectedTextContextMenuProtection,
      );
      if (selectedTextContextMenuActiveRef.current) {
        notifyRowStateChange(
          context,
          context.registry.setOpenOverlay({
            ...getLookupInput(context),
            open: false,
            overlayKind: "context-menu",
            overlayId: "selected-text",
          }),
        );
        selectedTextContextMenuActiveRef.current = false;
      }
    };
  }, [context, element]);

  return useMemo(
    () =>
      context
        ? {
            ref,
            onFocus,
            onBlur,
            "data-virtual-row-state": "enabled",
            "data-virtual-row-state-row-id": context.rowId,
          }
        : {},
    [context, onBlur, onFocus, ref],
  );
}

export function useTranscriptActiveStreamingProtection(active: boolean) {
  useTranscriptActiveRowProtection(active, ACTIVE_STREAM_SOURCE_ID);
}

export function useTranscriptActiveToolProtection(active: boolean) {
  useTranscriptActiveRowProtection(active, ACTIVE_TOOL_SOURCE_ID);
}

export function useTranscriptOpenOverlayProtection({
  open,
  overlayKind,
  overlayId,
}: {
  open: boolean;
  overlayKind: TranscriptOpenOverlayKind;
  overlayId: string;
}) {
  const context = useOptionalTranscriptRowStateContext();
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!context) {
      return;
    }

    if (open || wasOpenRef.current) {
      notifyRowStateChange(
        context,
        context.registry.setOpenOverlay({
          ...getLookupInput(context),
          open,
          overlayKind,
          overlayId,
        }),
      );
      wasOpenRef.current = open;
    }

    return () => {
      if (wasOpenRef.current) {
        notifyRowStateChange(
          context,
          context.registry.setOpenOverlay({
            ...getLookupInput(context),
            open: false,
            overlayKind,
            overlayId,
          }),
        );
        wasOpenRef.current = false;
      }
    };
  }, [context, open, overlayId, overlayKind]);
}

export function useTranscriptMcpActivityReporter(): TranscriptMcpActivityReporter {
  const context = useOptionalTranscriptRowStateContext();

  const setMcpActivity = useCallback<
    TranscriptMcpActivityReporter["setMcpActivity"]
  >(
    (kind, active, options) => {
      if (!context) {
        return false;
      }

      const changed = context.registry.setMcpActivity({
        ...getLookupInput(context),
        active,
        kind,
        sourceId: options?.sourceId,
        ttlMs: options?.ttlMs,
      });
      notifyRowStateChange(context, changed);
      return changed;
    },
    [context],
  );

  const patchMcpAppState = useCallback<
    TranscriptMcpActivityReporter["patchMcpAppState"]
  >(
    (patch, options) => {
      if (!context) {
        return undefined;
      }

      const nextState = context.registry.updateRowState({
        ...getLookupInput(context),
        markRecent: options?.markRecent,
        updater: (current) => ({
          ...current,
          mcpApp: {
            ...current.mcpApp,
            ...patch,
          },
        }),
      });
      notifyRowStateChange(context, nextState !== undefined);
      return nextState;
    },
    [context],
  );

  return useMemo(
    () => ({
      enabled: context !== null,
      setMcpActivity,
      patchMcpAppState,
    }),
    [context, patchMcpAppState, setMcpActivity],
  );
}

function useTranscriptActiveRowProtection(active: boolean, sourceId: string) {
  const context = useOptionalTranscriptRowStateContext();
  const wasActiveRef = useRef(false);

  useEffect(() => {
    if (!context) {
      return;
    }

    if (active || wasActiveRef.current) {
      notifyRowStateChange(
        context,
        context.registry.setActiveStreamingRow({
          ...getLookupInput(context),
          active,
          sourceId,
        }),
      );
      wasActiveRef.current = active;
    }

    return () => {
      if (wasActiveRef.current) {
        notifyRowStateChange(
          context,
          context.registry.setActiveStreamingRow({
            ...getLookupInput(context),
            active: false,
            sourceId,
          }),
        );
        wasActiveRef.current = false;
      }
    };
  }, [active, context, sourceId]);
}

function getLookupInput(
  context: TranscriptRowStateContextValue,
): Pick<
  TranscriptRowStatePatchInput,
  "sessionId" | "rowId" | "sessionEpoch" | "nowMs"
> {
  return {
    sessionId: context.sessionId,
    rowId: context.rowId,
    sessionEpoch: context.sessionEpoch,
    nowMs: getContextNowMs(context),
  };
}

function getContextNowMs(
  context: TranscriptRowStateContextValue,
): number | undefined {
  return context.getNowMs?.();
}

function notifyRowStateChange(
  context: TranscriptRowStateContextValue,
  changed: boolean,
): void {
  if (changed) {
    context.onRowStateChange?.();
  }
}

function getFocusTargetId(target: EventTarget | null): string | undefined {
  if (!(target instanceof HTMLElement)) {
    return undefined;
  }

  return (
    target.id ||
    target.getAttribute("data-role") ||
    target.getAttribute("data-testid") ||
    target.tagName.toLowerCase()
  );
}

function rangesIntersectElement(
  ranges: readonly Range[],
  element: Element,
): boolean {
  return ranges.some((range) => {
    try {
      return range.intersectsNode(element);
    } catch {
      return false;
    }
  });
}
