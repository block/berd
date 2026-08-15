import type { AppRendererProps, McpUiHostContext } from "@mcp-ui/client";
import { useEffect, useMemo, useState } from "react";
import { createMcpAppSandbox } from "@/shared/api/gooseServeHost";
import type { RenderableMcpAppDocument } from "./mcpAppPayload";

// The backend validates the rendered document against this digest before it
// redeems the one-use store grant. This keeps an old capability from accepting
// replacement HTML even if a renderer races document transitions.
async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

type HostColorScheme = NonNullable<McpUiHostContext["theme"]>;
type Sandbox = NonNullable<AppRendererProps["sandbox"]>;
type SandboxDocument = Pick<
  RenderableMcpAppDocument,
  "resourceUri" | "html" | "csp"
>;

const DOCUMENT_BINDING_BYTES = 32;
const TRUSTED_IPC_NONCE_PROPERTY = "__BERD_MCP_SANDBOX_IPC_NONCE__";

// Defense in depth for Windows WebView2, which installs Tauri initialization
// scripts in subframes: only the trusted top-level app receives this nonce. It
// authorizes minting, never proxying, and is not placed in iframe-visible state.
function trustedIpcNonce(): string {
  const nonce = Object.getOwnPropertyDescriptor(
    window,
    TRUSTED_IPC_NONCE_PROPERTY,
  )?.value;
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
    throw new Error("MCP app sandbox authorization is unavailable");
  }
  return nonce;
}

interface SandboxRequest {
  signature: string;
  generation: number;
  document: SandboxDocument;
  initialColorScheme: HostColorScheme;
}

interface SandboxState {
  generation: number;
  document: PreparedSandboxDocument;
}

export interface PreparedSandboxDocument {
  html: string;
  sandbox: Sandbox;
}

// Keep this transformation aligned with the pinned Goose proxy template in
// `src-tauri/testdata/goose/`. Berd performs it before hashing so the one-use
// store grant is bound to the exact HTML that reaches Goose.
function createColorSchemePrelude(colorScheme: HostColorScheme): string {
  const hostColorScheme = colorScheme === "dark" ? "dark" : "light";
  const matchMediaScript = [
    "<script>",
    "(function(){",
    "var nativeMatchMedia=window.matchMedia&&window.matchMedia.bind(window);",
    'function normalizeColorScheme(value){return value==="dark"?"dark":"light";}',
    'function setHostColorScheme(value){window.__mcpHostColorScheme=normalizeColorScheme(value);document.documentElement.style.colorScheme=window.__mcpHostColorScheme;if(document.body){document.body.style.colorScheme=window.__mcpHostColorScheme;}var meta=document.querySelector("meta[name=\\"color-scheme\\"]");if(meta){meta.setAttribute("content",window.__mcpHostColorScheme);}}',
    `setHostColorScheme(${JSON.stringify(hostColorScheme)});`,
    'document.addEventListener("DOMContentLoaded",function(){setHostColorScheme(window.__mcpHostColorScheme);});',
    'if(nativeMatchMedia){window.matchMedia=function(query){var normalized=String(query).replace(/\\s+/g," ").trim().toLowerCase();var isDark=normalized==="(prefers-color-scheme: dark)";var isLight=normalized==="(prefers-color-scheme: light)";if(!isDark&&!isLight){return nativeMatchMedia(query);}return {matches:isDark?window.__mcpHostColorScheme==="dark":window.__mcpHostColorScheme==="light",media:String(query),onchange:null,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return false;}};};}',
    'window.addEventListener("message",function(event){var data=event.data;if(!data||data.method!=="ui/notifications/host-context-changed"){return;}var theme=data.params&&data.params.theme;if(theme==="light"||theme==="dark"){setHostColorScheme(theme);}});',
    "})();",
    "</script>",
  ].join("");

  return `<meta name="color-scheme" content="${hostColorScheme}"><style id="mcp-app-host-color-scheme">:root{color-scheme:${hostColorScheme};}html,body{background-color:transparent;}</style>${matchMediaScript}`;
}

function prepareSandboxHtml(
  html: string,
  colorScheme: HostColorScheme,
): string {
  const prelude = createColorSchemePrelude(colorScheme);
  const cleanedHtml = html.replace(
    /<meta\s+[^>]*name\s*=\s*["']color-scheme["'][^>]*>/gi,
    "",
  );

  if (/<head\b[^>]*>/i.test(cleanedHtml)) {
    return cleanedHtml.replace(/<head\b[^>]*>/i, (match) => match + prelude);
  }
  if (/<html\b[^>]*>/i.test(cleanedHtml)) {
    return cleanedHtml.replace(
      /<html\b[^>]*>/i,
      (match) => `${match}<head>${prelude}</head>`,
    );
  }
  return prelude + cleanedHtml;
}

function documentSignature(
  renderableDocument: Pick<
    RenderableMcpAppDocument,
    "resourceUri" | "html" | "csp"
  >,
): string {
  return JSON.stringify({
    resourceUri: renderableDocument.resourceUri,
    html: renderableDocument.html,
    csp: renderableDocument.csp,
  });
}

function createDocumentBinding(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(DOCUMENT_BINDING_BYTES));
  return bytesToBase64Url(bytes);
}

function parseSandboxProxyUrl(proxyUrl: string): URL {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    throw new Error("Invalid MCP app sandbox proxy URL");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    !/^#document=[A-Za-z0-9_-]{43}$/.test(url.hash) ||
    !/^\/mcp-app-sandbox\/proxy\/[A-Za-z0-9_-]{43}$/.test(url.pathname)
  ) {
    throw new Error("Invalid MCP app sandbox proxy URL");
  }
  return url;
}

export function useMcpAppSandbox({
  renderableDocument,
  colorScheme,
  onPendingChange,
  onError,
}: {
  renderableDocument: SandboxDocument | null;
  colorScheme: HostColorScheme;
  onPendingChange?: (pending: boolean) => void;
  onError: () => void;
}): PreparedSandboxDocument | null {
  // `colorScheme` is intentionally not part of the signature. Theme-only
  // updates flow through host context and must not reload an embedded app.
  const signature = useMemo(
    () => (renderableDocument ? documentSignature(renderableDocument) : null),
    [renderableDocument],
  );
  const [state, setState] = useState<SandboxState | null>(null);
  const [generation, setGeneration] = useState(0);
  const [currentRequest, setCurrentRequest] = useState<{
    signature: string | null;
    request: SandboxRequest | null;
  }>({ signature: null, request: null });
  let request = currentRequest.request;
  if (currentRequest.signature !== signature) {
    const nextGeneration = generation + 1;
    request =
      signature === null
        ? null
        : {
            signature,
            generation: nextGeneration,
            document: renderableDocument as SandboxDocument,
            initialColorScheme: colorScheme,
          };
    setGeneration(nextGeneration);
    setCurrentRequest({ signature, request });
  }
  const requestDocument = request?.document;
  const requestGeneration = request?.generation;
  const requestInitialColorScheme = request?.initialColorScheme;

  useEffect(() => {
    if (
      !requestDocument ||
      requestGeneration === undefined ||
      !requestInitialColorScheme
    ) {
      return;
    }

    const document = requestDocument;
    const generation = requestGeneration;
    const initialColorScheme = requestInitialColorScheme;
    let cancelled = false;
    const csp = document.csp;
    const preparedHtml = prepareSandboxHtml(document.html, initialColorScheme);
    onPendingChange?.(true);
    const createSandbox = async () => {
      const documentBinding = createDocumentBinding();
      const documentDigest = await sha256Base64Url(preparedHtml);
      return createMcpAppSandbox({
        connectDomains: csp?.connectDomains ?? [],
        resourceDomains: csp?.resourceDomains ?? [],
        frameDomains: csp?.frameDomains ?? [],
        baseUriDomains: csp?.baseUriDomains ?? [],
        scriptDomains: csp?.scriptDomains ?? [],
        colorScheme: initialColorScheme,
        documentBinding,
        documentDigest,
        ipcNonce: trustedIpcNonce(),
      });
    };
    createSandbox()
      .then(({ proxyUrl }) => {
        if (!cancelled) {
          setState({
            generation,
            document: {
              html: preparedHtml,
              sandbox: { url: parseSandboxProxyUrl(proxyUrl) },
            },
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          onError();
        }
      })
      .finally(() => {
        if (!cancelled) {
          onPendingChange?.(false);
        }
      });

    return () => {
      cancelled = true;
      onPendingChange?.(false);
    };
    // The initial theme is deliberately baked into the proxy document. Live
    // theme updates flow through hostContext instead of reloading the iframe.
    // `request` is intentionally decomposed so StrictMode's render replay does
    // not retrigger this effect merely because a ref-created wrapper changed.
  }, [
    onError,
    onPendingChange,
    requestDocument,
    requestGeneration,
    requestInitialColorScheme,
  ]);

  return request && state?.generation === request.generation
    ? state.document
    : null;
}
