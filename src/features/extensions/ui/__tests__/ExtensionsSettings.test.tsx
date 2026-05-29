import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMigrationStore } from "@/features/migration/stores/migrationStore";
import type { ExtensionEntry } from "../../types";
import { ExtensionsSettings } from "../ExtensionsSettings";

const mockUseExtensionsSettings = vi.fn();
const mockDismissMigrationBanner = vi.fn();

vi.mock("@/features/extensions/hooks/useExtensionsSettings", () => ({
  useExtensionsSettings: () => mockUseExtensionsSettings(),
}));

vi.mock("@/features/migration/api/migration", () => ({
  dismissMigrationBanner: () => mockDismissMigrationBanner(),
}));

const extensions: ExtensionEntry[] = [
  {
    type: "stdio",
    name: "Airtable",
    description: "Managed through Connections",
    cmd: "npx",
    args: [],
    config_key: "airtable",
    enabled: true,
  },
  {
    type: "stdio",
    name: "github",
    description: "Issue tracker",
    cmd: "npx",
    args: [],
    config_key: "github",
    enabled: true,
  },
  {
    type: "builtin",
    name: "developer",
    display_name: "Developer",
    description: "Code tools",
    config_key: "developer",
    enabled: true,
  },
  {
    type: "platform",
    name: "summarize",
    display_name: "Summarize",
    description: "Summarize files",
    config_key: "summarize",
    enabled: false,
  },
];

describe("ExtensionsSettings", () => {
  beforeEach(() => {
    mockUseExtensionsSettings.mockReturnValue({
      extensions,
      isLoading: false,
      modalMode: null,
      editingExtension: null,
      handleAdd: vi.fn(),
      handleConfigure: vi.fn(),
      handleSubmit: vi.fn(),
      handleDelete: vi.fn(),
      handleReset: vi.fn(),
      handleModalClose: vi.fn(),
    });
    mockDismissMigrationBanner.mockReset();
    mockDismissMigrationBanner.mockResolvedValue({
      done: true,
      completedAt: "2026-05-19T12:00:00Z",
      disabledExtensions: [{ configKey: "github", name: "GitHub" }],
      bannerDismissedAt: "2026-05-19T13:00:00Z",
    });
  });

  afterEach(() => {
    useMigrationStore.getState().reset();
  });

  it("reveals matching Goose capabilities while searching", async () => {
    const user = userEvent.setup();
    render(<ExtensionsSettings />);

    expect(screen.queryByText("Developer")).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "developer");

    expect(screen.getByText("Developer")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /show .*built-in goose capabilities/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("does not show global enable toggles", async () => {
    const user = userEvent.setup();
    render(<ExtensionsSettings />);

    expect(
      screen.queryByRole("switch", { name: /disable github/i }),
    ).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "summarize");

    expect(
      screen.queryByRole("switch", { name: /enable summarize/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: /enable developer/i }),
    ).not.toBeInTheDocument();
  });

  it("hides company-managed extensions in the custom tab variant", () => {
    render(
      <ExtensionsSettings
        variant="custom"
        hideCompanyManagedExtensions
        showAddAction={false}
      />,
    );

    expect(screen.queryByText("Airtable")).not.toBeInTheDocument();
    expect(screen.getByText("github")).toBeInTheDocument();
  });

  it("only lists disabled extensions visible in the current variant banner", () => {
    useMigrationStore.getState().setStatus({
      done: true,
      completedAt: "2026-05-19T12:00:00Z",
      disabledExtensions: [
        { configKey: "airtable", name: "Airtable" },
        { configKey: "github", name: "GitHub" },
      ],
    });

    render(
      <ExtensionsSettings
        variant="custom"
        hideCompanyManagedExtensions
        showAddAction={false}
      />,
    );

    expect(
      screen.getByText("Some extensions are now enabled on demand"),
    ).toBeInTheDocument();
    expect(screen.getByText(/GitHub/)).toBeInTheDocument();
    expect(screen.queryByText(/Airtable/)).not.toBeInTheDocument();
  });

  it("hides the disabled banner when only hidden managed extensions were disabled", () => {
    useMigrationStore.getState().setStatus({
      done: true,
      completedAt: "2026-05-19T12:00:00Z",
      disabledExtensions: [{ configKey: "airtable", name: "Airtable" }],
    });

    render(
      <ExtensionsSettings
        variant="custom"
        hideCompanyManagedExtensions
        showAddAction={false}
      />,
    );

    expect(
      screen.queryByText("Some extensions are now enabled on demand"),
    ).not.toBeInTheDocument();
  });

  it("renders the migration banner when extensions were disabled", () => {
    useMigrationStore.getState().setStatus({
      done: true,
      completedAt: "2026-05-19T12:00:00Z",
      disabledExtensions: [
        { configKey: "github", name: "GitHub" },
        { configKey: "summarize", name: "Summarize" },
      ],
      backupPath: "/tmp/config.yaml.backup-2026-05-19T12-00-00Z",
    });

    render(<ExtensionsSettings />);

    expect(
      screen.getByText("Some extensions are now enabled on demand"),
    ).toBeInTheDocument();
    // The banner lists every disabled extension's display name.
    expect(screen.getByText(/GitHub.*Summarize/)).toBeInTheDocument();
  });

  it("does not render the migration banner when no extensions were disabled", () => {
    useMigrationStore.getState().setStatus({
      done: true,
      completedAt: "2026-05-19T12:00:00Z",
      disabledExtensions: [],
    });

    render(<ExtensionsSettings />);

    expect(
      screen.queryByText("Some extensions are now enabled on demand"),
    ).not.toBeInTheDocument();
  });

  it("hides the migration banner and persists dismissal when the dismiss button is clicked", async () => {
    useMigrationStore.getState().setStatus({
      done: true,
      completedAt: "2026-05-19T12:00:00Z",
      disabledExtensions: [{ configKey: "github", name: "GitHub" }],
    });

    const user = userEvent.setup();
    render(<ExtensionsSettings />);

    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(
      screen.queryByText("Some extensions are now enabled on demand"),
    ).not.toBeInTheDocument();
    // Dismissal must round-trip through the Tauri command so it survives
    // the next launch rather than only living in memory for the session.
    expect(mockDismissMigrationBanner).toHaveBeenCalledTimes(1);
    expect(useMigrationStore.getState().bannerDismissedAt).toBeDefined();
  });

  it("stays dismissed when the marker already carries bannerDismissedAt", () => {
    useMigrationStore.getState().setStatus({
      done: true,
      completedAt: "2026-05-19T12:00:00Z",
      disabledExtensions: [{ configKey: "github", name: "GitHub" }],
      bannerDismissedAt: "2026-05-19T13:00:00Z",
    });

    render(<ExtensionsSettings />);

    expect(
      screen.queryByText("Some extensions are now enabled on demand"),
    ).not.toBeInTheDocument();
  });

  it("flags enabled non-whitelisted extensions as Always on with a Reset button", () => {
    render(<ExtensionsSettings />);

    // `github` is enabled and not in KEEP_ENABLED — banner + Reset visible.
    expect(
      screen.getByRole("button", { name: /reset github to on-demand/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Always on").length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag KEEP_ENABLED extensions even when they are enabled", async () => {
    const user = userEvent.setup();
    render(<ExtensionsSettings />);

    // `developer` lives under Goose capabilities — reveal that section first.
    await user.click(
      screen.getByRole("button", {
        name: /show .*built-in goose capabilities/i,
      }),
    );

    expect(
      screen.queryByRole("button", { name: /reset developer to on-demand/i }),
    ).not.toBeInTheDocument();
  });

  it("does not flag extensions that are already disabled", async () => {
    const user = userEvent.setup();
    render(<ExtensionsSettings />);

    // `summarize` is in the platform category (Goose capabilities) and
    // enabled=false; reveal that section and verify no Reset surfaces.
    await user.click(
      screen.getByRole("button", {
        name: /show .*built-in goose capabilities/i,
      }),
    );

    expect(
      screen.queryByRole("button", { name: /reset summarize to on-demand/i }),
    ).not.toBeInTheDocument();
  });

  it("invokes handleReset with the config key when Reset is clicked", async () => {
    const handleReset = vi.fn();
    mockUseExtensionsSettings.mockReturnValue({
      extensions,
      isLoading: false,
      modalMode: null,
      editingExtension: null,
      handleAdd: vi.fn(),
      handleConfigure: vi.fn(),
      handleSubmit: vi.fn(),
      handleDelete: vi.fn(),
      handleReset,
      handleModalClose: vi.fn(),
    });

    const user = userEvent.setup();
    render(<ExtensionsSettings />);

    await user.click(
      screen.getByRole("button", { name: /reset github to on-demand/i }),
    );

    expect(handleReset).toHaveBeenCalledWith("github");
  });
});
