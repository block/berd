import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectionsSettings } from "./ConnectionsSettings";

const testState = vi.hoisted(() => ({ managed: false }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { harnesses?: string }) =>
      options?.harnesses ? `${key}:${options.harnesses}` : key,
  }),
}));

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  onOpenUrl: async () => () => {},
}));

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: () => testState.managed,
}));

vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: (selector: (state: object) => unknown) =>
    selector({ projects: [], activeProjectId: null }),
}));

vi.mock("@/features/connections/api/connections", () => ({
  CONNECTIONS_QUERY_KEY: ["connections"],
  listConnections: async () => ({ connections: [] }),
  disconnectConnection: async () => {},
}));

vi.mock("@/features/connections/api/localMcpInventory", () => ({
  LOCAL_MCP_INVENTORY_QUERY_KEY: ["local-mcp-inventory"],
  listLocalMcpInventory: async () => ({
    harnesses: [
      {
        harness: "goose",
        status: "configured",
        checkedLocations: [],
        servers: [
          {
            id: "goose:user:github",
            harness: "goose",
            source: { scope: "user", label: "Goose user config" },
            configKey: "github",
            name: "GitHub",
            transport: "stdio",
          },
        ],
      },
      {
        harness: "codex",
        status: "configured",
        checkedLocations: [],
        servers: [
          {
            id: "codex:user:github",
            harness: "codex",
            source: { scope: "user", label: "Codex user config" },
            configKey: "github",
            name: "GitHub",
            transport: "stdio",
          },
        ],
      },
    ],
  }),
}));

function renderConnectionsSettings() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ConnectionsSettings />
    </QueryClientProvider>,
  );
}

describe("ConnectionsSettings", () => {
  it("renders passive local inventory without a distribution section", async () => {
    renderConnectionsSettings();

    expect(await screen.findByText("GitHub")).toBeInTheDocument();
    expect(
      screen.getByText("connections.worksWith:Goose, Codex"),
    ).toBeInTheDocument();
    expect(screen.getByText("connections.sections.local")).toBeInTheDocument();
    expect(
      screen.queryByText("connections.sections.managed"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /configure|remove|connect/i }),
    ).not.toBeInTheDocument();
  });

  it("organizes the managed catalog and local inventory without installed or available sections", async () => {
    testState.managed = true;
    renderConnectionsSettings();

    expect(
      await screen.findByText("connections.sections.managed"),
    ).toBeInTheDocument();
    expect(screen.getByText("connections.sections.local")).toBeInTheDocument();
    expect(
      screen.queryByText("connections.sections.installed"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("connections.sections.available"),
    ).not.toBeInTheDocument();
  });

  it("uses one search across managed and local sections", async () => {
    const user = userEvent.setup();
    testState.managed = true;
    renderConnectionsSettings();

    await screen.findByText("GitHub");
    await user.type(
      screen.getByRole("searchbox", { name: "connections.search" }),
      "Codex",
    );

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(
      screen.getByText("connections.worksWith:Goose, Codex"),
    ).toBeInTheDocument();
    expect(screen.getByText("connections.noResults")).toBeInTheDocument();
  });

  it("renders no page wrapper so the caller owns the settings pane", () => {
    const { container } = renderConnectionsSettings();
    expect(container.querySelectorAll(".page-transition")).toHaveLength(0);
  });
});
