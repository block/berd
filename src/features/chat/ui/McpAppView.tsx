import {
  AppRenderer,
  type AppRendererProps,
  type McpUiHostContext,
} from "@mcp-ui/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import packageJson from "../../../../package.json";
import {
  getClientForSession,
  getWireSessionId,
} from "@/shared/api/acpSessionBackends";
import { getGooseServeHostInfo } from "@/shared/api/gooseServeHost";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { createVirtualLayoutStabilityAttributes } from "@/features/chat/transcript/measurement";
import {
  useTranscriptMcpActivityReporter,
  useTranscriptOpenOverlayProtection,
} from "@/features/chat/transcript/row-state";
import type {
  McpAppPayload,
  ToolResponseContent,
} from "@/shared/types/messages";
import { LinkSafetyModal } from "@/shared/ui/ai-elements/link-safety-modal";
import type { McpAppMessageHandler } from "./mcpAppTypes";
import { extractRenderableMcpAppDocument } from "./mcpAppPayload";
import { useIframeColorScheme } from "./useIframeColorScheme";
import { useMcpAppOpenLink } from "./useMcpAppOpenLink";
import { useMcpAppSandbox } from "./useMcpAppSandbox";

interface McpAppViewProps {
  payload: McpAppPayload;
  toolInput?: Record<string, unknown>;
  toolResponse?: ToolResponseContent;
  onSendMessage?: McpAppMessageHandler;
  onAutoScrollRequest?: (element: HTMLElement | null) => void;
}

const DEFAULT_APP_HEIGHT = 240;
// Goose2 currently only implements inline display mode.
const GOOSE2_DISPLAY_MODE = "inline" satisfies NonNullable<
  McpUiHostContext["displayMode"]
>;
const AVAILABLE_DISPLAY_MODES: NonNullable<
  McpUiHostContext["availableDisplayModes"]
> = [GOOSE2_DISPLAY_MODE];
const GOOSE2_USER_AGENT = `${packageJson.name}/${packageJson.version}`;
const DESKTOP_SAFE_AREA_INSETS = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
} as const;
type SizeChangedParams = Parameters<
  NonNullable<AppRendererProps["onSizeChanged"]>
>[0];
type MessageParams = Parameters<NonNullable<AppRendererProps["onMessage"]>>[0];
type CallToolResult = Awaited<
  ReturnType<NonNullable<AppRendererProps["onCallTool"]>>
>;
type ReadResourceResult = Awaited<
  ReturnType<NonNullable<AppRendererProps["onReadResource"]>>
>;
type HostContextToolInfo = NonNullable<McpUiHostContext["toolInfo"]>;
type HostContextTool = HostContextToolInfo["tool"];

function buildToolResult(
  toolResponse: ToolResponseContent | undefined,
): CallToolResult | undefined {
  if (!toolResponse) {
    return undefined;
  }

  return {
    content: [{ type: "text", text: toolResponse.result }],
    isError: toolResponse.isError,
    structuredContent:
      toolResponse.structuredContent as CallToolResult["structuredContent"],
  };
}

function matchesMedia(query: string): boolean {
  return window.matchMedia?.(query).matches ?? false;
}

function getDeviceCapabilities(): NonNullable<
  McpUiHostContext["deviceCapabilities"]
> {
  return {
    touch:
      navigator.maxTouchPoints > 0 ||
      matchesMedia("(pointer: coarse)") ||
      matchesMedia("(any-pointer: coarse)"),
    hover: matchesMedia("(hover: hover)") || matchesMedia("(any-hover: hover)"),
  };
}

function buildHostContextToolInfo(payload: McpAppPayload): HostContextToolInfo {
  const tool: HostContextTool = {
    name: payload.tool.name,
    title: payload.toolCallTitle,
    inputSchema: {
      type: "object",
    },
  };

  if (payload.tool.meta) {
    tool._meta = payload.tool.meta;
  }

  return {
    id: payload.toolCallId,
    tool,
  };
}

export function McpAppView({
  payload,
  toolInput,
  toolResponse,
  onSendMessage,
  onAutoScrollRequest,
}: McpAppViewProps) {
  const { t } = useTranslation("chat");
  const { resolvedTheme } = useTheme();
  const [hostInfo, setHostInfo] = useState<{
    httpBaseUrl: string;
    secretKey: string;
  } | null>(null);
  const [inlineHeight, setInlineHeight] = useState(DEFAULT_APP_HEIGHT);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [activeToolInput, setActiveToolInput] = useState<
    Record<string, unknown> | undefined
  >();
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [isIframeSizingPending, setIsIframeSizingPending] = useState(false);
  const autoScrollTimersRef = useRef<number[]>([]);
  const iframeSizingRafRef = useRef<number[]>([]);
  const mcpRequestSourceCounterRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const {
    enabled: rowStateEnabled,
    setMcpActivity,
    patchMcpAppState,
  } = useTranscriptMcpActivityReporter();
  const {
    handleConfirmOpenLink,
    handleOpenLink,
    handleOpenLinkModalClose,
    pendingOpenLinkUrl,
  } = useMcpAppOpenLink();
  useIframeColorScheme(rootRef, resolvedTheme);

  const renderableDocument = useMemo(
    () => extractRenderableMcpAppDocument(payload),
    [payload],
  );
  const initialToolResult = useMemo(
    () => buildToolResult(toolResponse),
    [toolResponse],
  );
  const currentToolInput = activeToolInput ?? toolInput;
  const currentToolResult = initialToolResult;

  useTranscriptOpenOverlayProtection({
    open: pendingOpenLinkUrl !== null,
    overlayKind: "dialog",
    overlayId: "mcp-link-safety",
  });

  const requestAutoScroll = useCallback(() => {
    if (!onAutoScrollRequest) {
      return;
    }

    for (const timer of autoScrollTimersRef.current) {
      window.clearTimeout(timer);
    }
    autoScrollTimersRef.current = [];

    const runAutoScroll = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          onAutoScrollRequest(rootRef.current);
        });
      });
    };

    runAutoScroll();

    for (const delay of [120, 300, 650]) {
      const timer = window.setTimeout(() => {
        runAutoScroll();
      }, delay);
      autoScrollTimersRef.current.push(timer);
    }
  }, [onAutoScrollRequest]);

  useEffect(
    () => () => {
      for (const timer of autoScrollTimersRef.current) {
        window.clearTimeout(timer);
      }
      autoScrollTimersRef.current = [];
      for (const frame of iframeSizingRafRef.current) {
        window.cancelAnimationFrame(frame);
      }
      iframeSizingRafRef.current = [];
    },
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const updateWidth = (width: number) => {
      if (width > 0) {
        setContainerWidth(Math.round(width));
      }
    };

    updateWidth(root.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (typeof nextWidth === "number") {
        updateWidth(nextWidth);
      }
    });

    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    getGooseServeHostInfo()
      .then((info) => {
        if (!cancelled) {
          setHostInfo(info);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRenderError(t("message.mcpAppRenderError"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [t]);

  const isHostInfoRequestPending =
    renderableDocument !== null && renderError === null && hostInfo === null;
  useEffect(() => {
    if (!rowStateEnabled || !isHostInfoRequestPending) {
      return;
    }

    setMcpActivity("host-request", true, {
      sourceId: "mcp-host-info",
    });

    return () => {
      setMcpActivity("host-request", false, {
        sourceId: "mcp-host-info",
      });
    };
  }, [isHostInfoRequestPending, rowStateEnabled, setMcpActivity]);

  useEffect(() => {
    patchMcpAppState(
      {
        inlineHeightPx: inlineHeight,
      },
      { markRecent: false },
    );
  }, [inlineHeight, patchMcpAppState]);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    console.groupCollapsed(
      `[McpAppView] ${payload.tool.extensionName}/${payload.tool.name}`,
    );
    console.debug("payload", payload);
    console.debug("renderableDocument", renderableDocument);
    console.debug("currentToolInput", currentToolInput ?? null);
    console.debug("currentToolResult", currentToolResult ?? null);
    console.debug("hostInfo", hostInfo);
    console.groupEnd();
  }, [
    currentToolInput,
    currentToolResult,
    hostInfo,
    payload,
    renderableDocument,
  ]);

  const sandbox = useMcpAppSandbox({
    hostInfo,
    renderableDocument,
    colorScheme: resolvedTheme,
  });

  const hostContext = useMemo<McpUiHostContext>(
    () => ({
      theme: resolvedTheme,
      displayMode: GOOSE2_DISPLAY_MODE,
      availableDisplayModes: [...AVAILABLE_DISPLAY_MODES],
      containerDimensions:
        containerWidth !== null
          ? {
              width: containerWidth,
              height: inlineHeight,
            }
          : undefined,
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: GOOSE2_USER_AGENT,
      platform: "desktop",
      deviceCapabilities: getDeviceCapabilities(),
      safeAreaInsets: DESKTOP_SAFE_AREA_INSETS,
      toolInfo: buildHostContextToolInfo(payload),
    }),
    [containerWidth, inlineHeight, payload, resolvedTheme],
  );

  const handleMessage = useCallback(
    async ({ role, content }: MessageParams) => {
      if (role !== "user" || !onSendMessage) {
        return { isError: true };
      }

      const text = content
        .filter((block): block is { type: "text"; text: string } => {
          return (
            block.type === "text" &&
            typeof block.text === "string" &&
            block.text.trim().length > 0
          );
        })
        .map((block) => block.text.trim())
        .join("\n\n");

      if (!text) {
        return { isError: true };
      }

      setMcpActivity("recent-message", true, {
        sourceId: "mcp-message",
      });
      const accepted = await onSendMessage(text);
      return accepted === false ? { isError: true } : {};
    },
    [onSendMessage, setMcpActivity],
  );

  const handleCallTool = useCallback(
    async ({
      name,
      arguments: args,
    }: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => {
      setActiveToolInput(args ?? {});
      mcpRequestSourceCounterRef.current += 1;
      const sourceId = `nested-tool:${name}:${mcpRequestSourceCounterRef.current}`;
      setMcpActivity("nested-tool-request", true, { sourceId });

      try {
        const client = await getClientForSession(payload.sessionId);
        const response = await client.goose.GooseUnstableToolsCall({
          sessionId: getWireSessionId(payload.sessionId),
          name: `${payload.tool.extensionName}__${name}`,
          arguments: args ?? {},
        });

        const toolResult: CallToolResult = {
          content: (response.content ?? []) as CallToolResult["content"],
          isError: response.isError,
          structuredContent:
            response.structuredContent as CallToolResult["structuredContent"],
          _meta: response._meta as CallToolResult["_meta"],
        };

        return toolResult;
      } finally {
        setMcpActivity("nested-tool-request", false, { sourceId });
      }
    },
    [payload.sessionId, payload.tool.extensionName, setMcpActivity],
  );

  const handleReadResource = useCallback(
    async ({ uri }: { uri: string }) => {
      mcpRequestSourceCounterRef.current += 1;
      const sourceId = `resource:${uri}:${mcpRequestSourceCounterRef.current}`;
      setMcpActivity("host-request", true, { sourceId });
      try {
        const client = await getClientForSession(payload.sessionId);
        const response = await client.goose.GooseUnstableResourcesRead({
          sessionId: getWireSessionId(payload.sessionId),
          uri,
          extensionName: payload.tool.extensionName,
        });

        return (response.result ?? { contents: [] }) as ReadResourceResult;
      } finally {
        setMcpActivity("host-request", false, { sourceId });
      }
    },
    [payload.sessionId, payload.tool.extensionName, setMcpActivity],
  );

  const handleSizeChanged = useCallback(
    ({ height }: SizeChangedParams) => {
      if (typeof height === "number" && height > 0) {
        setIsIframeSizingPending(true);
        setInlineHeight(height);
        for (const frame of iframeSizingRafRef.current) {
          window.cancelAnimationFrame(frame);
        }
        iframeSizingRafRef.current = [];
        const firstFrame = window.requestAnimationFrame(() => {
          const secondFrame = window.requestAnimationFrame(() => {
            setIsIframeSizingPending(false);
            iframeSizingRafRef.current = [];
          });
          iframeSizingRafRef.current = [secondFrame];
        });
        iframeSizingRafRef.current = [firstFrame];
        setMcpActivity("recent-resize", true, {
          sourceId: "mcp-size",
        });
        requestAutoScroll();
      }
    },
    [requestAutoScroll, setMcpActivity],
  );

  const handleRenderError = useCallback(() => {
    setRenderError(t("message.mcpAppRenderError"));
  }, [t]);

  const shouldRenderApp =
    renderableDocument !== null && sandbox !== null && renderError === null;
  const shouldShowFallback =
    renderError !== null || renderableDocument === null;
  const isMcpLayoutPending =
    renderableDocument !== null &&
    renderError === null &&
    (!shouldRenderApp || isIframeSizingPending);
  const rootClassName = "my-3 w-full";
  const appChromeClassName = renderableDocument?.prefersBorder
    ? "w-full overflow-hidden rounded-md border border-primary bg-background/40 shadow-sm [&_iframe]:block"
    : "w-full bg-transparent [&_iframe]:block";
  const appChromeStyle = {
    height: inlineHeight,
    colorScheme: resolvedTheme,
  } as const;
  const loadingClassName = renderableDocument?.prefersBorder
    ? "rounded-md border border-dashed border-border px-4 py-3 text-muted-foreground text-sm"
    : "py-1 text-muted-foreground text-sm";

  useEffect(() => {
    if (!import.meta.env.DEV || !shouldShowFallback) {
      return;
    }

    console.debug("[McpAppView] fallback", {
      payload,
      renderableDocument,
      renderError,
      readError: payload.resource.readError,
    });
  }, [payload, renderableDocument, renderError, shouldShowFallback]);

  useEffect(() => {
    if (!shouldRenderApp) {
      return;
    }

    requestAutoScroll();
  }, [requestAutoScroll, shouldRenderApp]);

  return (
    <div
      ref={rootRef}
      className={rootClassName}
      data-testid="mcp-app-view"
      {...createVirtualLayoutStabilityAttributes({
        isPending: isMcpLayoutPending,
        reason: "mcp-iframe-sizing",
        reservedBlockSize: inlineHeight,
      })}
    >
      {shouldRenderApp ? (
        <div className={appChromeClassName} style={appChromeStyle}>
          <AppRenderer
            toolName={payload.tool.name}
            toolResourceUri={renderableDocument.resourceUri}
            html={renderableDocument.html}
            sandbox={sandbox}
            toolInput={currentToolInput}
            toolResult={currentToolResult}
            hostContext={hostContext}
            onOpenLink={handleOpenLink}
            onMessage={handleMessage}
            onCallTool={handleCallTool}
            onReadResource={handleReadResource}
            onSizeChanged={handleSizeChanged}
            onError={handleRenderError}
          />
        </div>
      ) : renderableDocument && renderError === null ? (
        <div className={loadingClassName}>{t("message.mcpAppLoading")}</div>
      ) : null}

      {shouldShowFallback && (
        <div className="mt-3">
          <div className="mb-2 text-muted-foreground text-xs uppercase tracking-wide">
            {t("message.mcpApp")}
          </div>
          {(renderError || payload.resource.readError) && (
            <p className="mb-3 text-muted-foreground text-sm">
              {renderError ?? payload.resource.readError}
            </p>
          )}
        </div>
      )}
      <LinkSafetyModal
        isOpen={pendingOpenLinkUrl !== null}
        onClose={handleOpenLinkModalClose}
        onOpenLink={handleConfirmOpenLink}
        url={pendingOpenLinkUrl ?? ""}
      />
    </div>
  );
}
