import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type SnapshotV1,
} from "@/features/agents/agent-snapshot";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { AgentImageImportDialog } from "../AgentImageImportDialog";

const avatarApiMocks = vi.hoisted(() => ({
  importUserAvatarDataUrl: vi.fn(),
  deleteUserAvatar: vi.fn(),
}));
const snapshotMocks = vi.hoisted(() => ({
  decodeAvatarAnimation: vi.fn(),
}));

vi.mock("@/shared/api/avatars", () => avatarApiMocks);
vi.mock("@/features/agents/agent-snapshot", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/agents/agent-snapshot")
  >()),
  decodeAvatarAnimation: snapshotMocks.decodeAvatarAnimation,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/providers/hooks/useProviderModels", () => ({
  useProviderModels: () => ({
    getModelsForAgent: (provider: string) =>
      provider === "supported"
        ? [
            {
              id: "supported-model",
              name: "Supported model",
              providerId: "supported",
            },
          ]
        : [],
  }),
}));

vi.mock("@/features/agents/ui/PersonaFields/ProviderModelFields", () => ({
  ProviderModelFields: ({
    provider,
    model,
  }: {
    provider: string;
    model: string;
  }) => <div data-testid="configuration">{`${provider}:${model}`}</div>,
}));

function snapshot(overrides: Partial<SnapshotV1> = {}): SnapshotV1 {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    definition: {
      name: "Researcher",
      systemPrompt: "Research carefully.",
      provider: "supported",
      model: "supported-model",
    },
    profile: { displayName: "Research Assistant" },
    memory: { level: "core", entries: [{ slug: "one", body: "private" }] },
    ...overrides,
  };
}

describe("AgentImageImportDialog", () => {
  beforeEach(() => {
    useAgentStore.setState({
      providers: [{ id: "supported", label: "Supported" }],
    });
    snapshotMocks.decodeAvatarAnimation.mockReset();
    snapshotMocks.decodeAvatarAnimation.mockReturnValue(null);
    avatarApiMocks.importUserAvatarDataUrl.mockReset();
    avatarApiMocks.deleteUserAvatar.mockReset();
    avatarApiMocks.deleteUserAvatar.mockResolvedValue(undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("previews without writing and discloses ignored memory", () => {
    const onConfirm = vi.fn();
    render(
      <AgentImageImportDialog
        snapshot={snapshot()}
        imageBytes={new Uint8Array([1, 2, 3])}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveClass(
      "bg-card",
      "backdrop-filter-none",
    );
    expect(screen.getByDisplayValue("Research Assistant")).toBeInTheDocument();
    expect(screen.getByText("Research carefully.")).toBeInTheDocument();
    expect(screen.getByText("imageImport.description")).toBeInTheDocument();
    expect(screen.getByText("imageImport.memoryIgnored")).toBeInTheDocument();
    expect(screen.getByTestId("configuration")).toHaveTextContent(
      "supported:supported-model",
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("closes from the dialog x button", async () => {
    const onCancel = vi.fn();
    render(
      <AgentImageImportDialog
        snapshot={snapshot()}
        imageBytes={new Uint8Array([1])}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not persist when canceled", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <AgentImageImportDialog
        snapshot={snapshot()}
        imageBytes={new Uint8Array([1])}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "imageImport.cancel" }),
    );

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("submits exactly once while creation is pending", async () => {
    let resolveCreate: (() => void) | undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    render(
      <AgentImageImportDialog
        snapshot={snapshot()}
        imageBytes={new Uint8Array([1])}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const add = screen.getByRole("button", { name: "imageImport.add" });
    fireEvent.click(add);
    fireEvent.click(add);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({
      displayName: "Research Assistant",
      systemPrompt: "Research carefully.",
      provider: "supported",
      modelProviderId: "supported",
      model: "supported-model",
      avatar: undefined,
    });
    resolveCreate?.();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("preserves an imported library gloopie when agent creation fails", async () => {
    snapshotMocks.decodeAvatarAnimation.mockReturnValue({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "video/mp4",
    });
    avatarApiMocks.importUserAvatarDataUrl.mockResolvedValue(
      "user-avatar:temporary",
    );
    const onConfirm = vi.fn().mockRejectedValue(new Error("create failed"));
    render(
      <AgentImageImportDialog
        snapshot={snapshot()}
        imageBytes={new Uint8Array([1])}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "imageImport.add" }),
    );

    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(avatarApiMocks.deleteUserAvatar).not.toHaveBeenCalled();
  });

  it("does not claim memory is present when the field is omitted", () => {
    render(
      <AgentImageImportDialog
        snapshot={snapshot({ memory: undefined })}
        imageBytes={new Uint8Array([1])}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("imageImport.description")).toBeInTheDocument();
    expect(
      screen.queryByText("imageImport.memoryIgnored"),
    ).not.toBeInTheDocument();
  });

  it("clears an unavailable source configuration", () => {
    render(
      <AgentImageImportDialog
        snapshot={snapshot({
          definition: {
            name: "Researcher",
            provider: "missing",
            model: "missing-model",
          },
        })}
        imageBytes={new Uint8Array([1])}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByText("imageImport.unsupportedConfiguration"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("configuration")).toHaveTextContent(":");
  });
});
