import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsSettings } from "./ConnectionsSettings";

const testState = vi.hoisted(() => ({
  managed: false,
  projectId: null as string | null,
  inventoryMode: "configured" as "configured" | "empty" | "error" | "partial",
  inventoryCalls: [] as string[][],
  disabledExtensions: [] as Array<{ configKey: string; name: string }>,
  dismissBanner: vi.fn(),
}));

const configuredServers = [
  {
    id: "goose:user:github",
    harness: "goose",
    source: { scope: "user", label: "Goose user config" },
    configKey: "github",
    name: "GitHub",
    transport: "stdio",
    identityFingerprint: "stdio-shared",
  },
  {
    id: "codex:user:github",
    harness: "codex",
    source: { scope: "user", label: "Codex user config" },
    configKey: "github",
    name: "GitHub",
    transport: "stdio",
    identityFingerprint: "stdio-shared",
  },
];

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
    selector({
      activeProjectId: testState.projectId,
      projects: testState.projectId
        ? [
            {
              id: testState.projectId,
              workingDirs: [`/${testState.projectId}`],
            },
          ]
        : [],
    }),
}));

vi.mock("@/features/migration/stores/migrationStore", () => ({
  useMigrationStore: (selector: (state: object) => unknown) =>
    selector({
      disabledExtensions: testState.disabledExtensions,
      bannerDismissedAt: undefined,
      dismissBanner: testState.dismissBanner,
    }),
}));

vi.mock("@/features/connections/api/connections", () => ({
  CONNECTIONS_QUERY_KEY: ["connections"],
  listConnections: async () => ({ connections: [] }),
  disconnectConnection: async () => {},
}));

vi.mock("@/features/connections/api/localMcpInventory", () => ({
  LOCAL_MCP_INVENTORY_QUERY_KEY: ["local-mcp-inventory"],
  listLocalMcpInventory: async (workspacePaths: string[]) => {
    testState.inventoryCalls.push(workspacePaths);
    if (testState.inventoryMode === "error") throw new Error("unavailable");
    if (testState.inventoryMode === "empty") return { harnesses: [] };
    return {
      harnesses: [
        {
          harness: "goose",
          status: "configured",
          checkedLocations: [],
          servers: configuredServers.slice(0, 1),
        },
        {
          harness: "codex",
          status:
            testState.inventoryMode === "partial" ? "partial" : "configured",
          checkedLocations: [],
          servers: configuredServers.slice(1),
          message:
            testState.inventoryMode === "partial"
              ? "Codex project config could not be parsed."
              : null,
        },
      ],
    };
  },
}));

function renderConnectionsSettings(
  onAskAgentToAddMcp?: (request: { title: string; prompt: string }) => void,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ConnectionsSettings onAskAgentToAddMcp={onAskAgentToAddMcp} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe("ConnectionsSettings", () => {
  beforeEach(() => {
    testState.managed = false;
    testState.projectId = null;
    testState.inventoryMode = "configured";
    testState.inventoryCalls = [];
    testState.disabledExtensions = [];
    testState.dismissBanner.mockReset().mockResolvedValue(undefined);
  });

  it("renders passive local inventory without managed connections", async () => {
    renderConnectionsSettings();
    expect(await screen.findByText("GitHub")).toBeInTheDocument();
    expect(
      screen.getByText("connections.worksWith:Goose, Codex"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("connections.sections.managed"),
    ).not.toBeInTheDocument();
  });

  it("preserves the migration warning for visible disabled Goose extensions", async () => {
    testState.disabledExtensions = [{ configKey: "github", name: "GitHub" }];
    const user = userEvent.setup();
    renderConnectionsSettings();

    expect(
      await screen.findByText("extensions.disabledBanner.title"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "extensions.disabledBanner.dismiss" }),
    );
    expect(testState.dismissBanner).toHaveBeenCalledOnce();
  });

  it("organizes managed and local connections without installed or available sections", async () => {
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

  it("distinguishes successful empty inventory from failure", async () => {
    testState.inventoryMode = "empty";
    const empty = renderConnectionsSettings(vi.fn());
    expect(
      await screen.findByText("connections.empty.title"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("connections.localError.title"),
    ).not.toBeInTheDocument();
    empty.unmount();

    testState.inventoryMode = "error";
    renderConnectionsSettings(vi.fn());
    expect(
      await screen.findByText("connections.localError.title"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("connections.empty.title"),
    ).not.toBeInTheDocument();
  });

  it("preserves confirmed rows and offers retry for partial inventory", async () => {
    testState.inventoryMode = "partial";
    const user = userEvent.setup();
    renderConnectionsSettings();
    expect(await screen.findByText("GitHub")).toBeInTheDocument();
    expect(
      screen.getByText("connections.localError.partialTitle"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "connections.localError.retry" }),
    );
    await waitFor(() =>
      expect(testState.inventoryCalls.length).toBeGreaterThan(1),
    );
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("re-queries local project configuration when the active project changes", async () => {
    testState.projectId = "project-a";
    const view = renderConnectionsSettings();
    await screen.findByText("GitHub");
    expect(testState.inventoryCalls).toContainEqual(["/project-a"]);

    testState.projectId = "project-b";
    view.rerender(
      <QueryClientProvider client={view.client}>
        <ConnectionsSettings />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(testState.inventoryCalls).toContainEqual(["/project-b"]),
    );
  });

  it("starts Add connection through the neutral setup request", async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    renderConnectionsSettings(onAdd);
    await user.click(
      screen.getByRole("button", { name: "connections.askAgent" }),
    );
    expect(onAdd).toHaveBeenCalledWith({
      title: "connections.askAgentTitle",
      prompt: "connections.askAgentPrompt",
    });
  });

  it("renders no page wrapper so the caller owns the settings pane", () => {
    const { container } = renderConnectionsSettings();
    expect(container.querySelectorAll(".page-transition")).toHaveLength(0);
  });
});
