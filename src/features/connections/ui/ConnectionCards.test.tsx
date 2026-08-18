import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { I18nProvider } from "@/shared/i18n";
import type { ExtensionEntry } from "@/features/extensions/types";
import {
  ExtensionConnectionCard,
  OAuthConnectionCard,
} from "./ConnectionCards";
import { OAUTH_PROVIDERS } from "@/features/connections/catalog";

function renderCard(children: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>{children}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("connection rows", () => {
  it("shows OAuth descriptions inline without a Configure button", () => {
    const slack = OAUTH_PROVIDERS.find((entry) => entry.provider === "slack");
    if (!slack) throw new Error("Slack fixture is missing");

    renderCard(
      <OAuthConnectionCard entry={slack} status={{ kind: "active" }} />,
    );

    expect(screen.getByText(slack.description)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /configure/i }),
    ).not.toBeInTheDocument();
  });

  it("spaces disconnect and reconnect actions", () => {
    const slack = OAUTH_PROVIDERS.find((entry) => entry.provider === "slack");
    if (!slack) throw new Error("Slack fixture is missing");

    renderCard(
      <OAuthConnectionCard entry={slack} status={{ kind: "expired" }} />,
    );

    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    const actions = disconnect.parentElement;
    expect(actions).toHaveClass("flex", "items-center", "gap-2");
    expect(
      screen.getByRole("button", { name: "Reconnect" }).parentElement,
    ).toBe(actions);
  });

  it("keeps Configure for editable user-added MCP servers", () => {
    const onSelect = vi.fn();
    const extension: ExtensionEntry = {
      type: "streamable_http",
      name: "Context7",
      description: "Look up library documentation",
      uri: "https://mcp.context7.com",
      config_key: "context7",
      enabled: true,
    };

    renderCard(
      <ExtensionConnectionCard
        extension={extension}
        onReset={vi.fn()}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText(extension.description)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Configure Context7" }),
    ).toBeInTheDocument();
  });
});
