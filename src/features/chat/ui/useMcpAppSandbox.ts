import type { AppRendererProps, McpUiHostContext } from "@mcp-ui/client";
import { useMemo } from "react";
import type {
  McpAppResourceCsp,
  RenderableMcpAppDocument,
} from "./mcpAppPayload";

type HostColorScheme = NonNullable<McpUiHostContext["theme"]>;
type Sandbox = NonNullable<AppRendererProps["sandbox"]>;

interface GooseServeHostInfo {
  httpBaseUrl: string;
  secretKey: string;
}

function appendDomains(
  params: URLSearchParams,
  key: string,
  domains: string[] | undefined,
) {
  if (domains && domains.length > 0) {
    params.set(key, domains.join(","));
  }
}

function buildProxyUrl(
  httpBaseUrl: string,
  secretKey: string,
  csp: McpAppResourceCsp | null,
  colorScheme: HostColorScheme,
): URL {
  const params = new URLSearchParams({
    secret: secretKey,
    color_scheme: colorScheme,
  });
  appendDomains(params, "connect_domains", csp?.connectDomains);
  appendDomains(params, "resource_domains", csp?.resourceDomains);
  appendDomains(params, "frame_domains", csp?.frameDomains);
  appendDomains(params, "base_uri_domains", csp?.baseUriDomains);
  appendDomains(params, "script_domains", csp?.scriptDomains);
  const proxyBaseUrl = httpBaseUrl.endsWith("/")
    ? httpBaseUrl
    : `${httpBaseUrl}/`;
  return new URL(`mcp-app-proxy?${params.toString()}`, proxyBaseUrl);
}

export function useMcpAppSandbox({
  hostInfo,
  renderableDocument,
  colorScheme,
}: {
  hostInfo: GooseServeHostInfo | null;
  renderableDocument: Pick<RenderableMcpAppDocument, "csp"> | null;
  colorScheme: HostColorScheme;
}): Sandbox | null {
  const httpBaseUrl = hostInfo?.httpBaseUrl;
  const secretKey = hostInfo?.secretKey;
  const csp = renderableDocument?.csp;
  const signature = useMemo(() => {
    if (!httpBaseUrl || !secretKey || !renderableDocument) {
      return null;
    }

    return JSON.stringify({
      httpBaseUrl,
      secretKey,
      csp,
    });
  }, [csp, httpBaseUrl, renderableDocument, secretKey]);

  // `colorScheme` is intentionally captured at build time and excluded from the
  // dependency list: the proxy URL — and therefore the iframe — must stay stable
  // across theme changes. Live theme updates flow through `hostContext.theme`, so
  // rebuilding the URL here would needlessly reload the embedded app.
  // biome-ignore lint/correctness/useExhaustiveDependencies: colorScheme is deliberately baked in once; see comment above.
  const sandbox = useMemo<Sandbox | null>(() => {
    if (!httpBaseUrl || !secretKey || !signature) {
      return null;
    }

    return {
      url: buildProxyUrl(httpBaseUrl, secretKey, csp ?? null, colorScheme),
    };
  }, [csp, httpBaseUrl, secretKey, signature]);

  return sandbox;
}
