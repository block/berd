import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Persona } from "@/shared/types/agents";
import { toast } from "sonner";
import { AgentShareDialog } from "./AgentShareDialog";
import {
  createAvatarPoster,
  downloadBlob,
  renderAgentShareCard,
} from "./agentShareCard";

const avatarHookMocks = vi.hoisted(() => ({
  image: "https://example.com/avatar.png" as string | undefined,
  media: undefined as
    | {
        src: string;
        mediaType: "image" | "video";
        posterSrc?: string;
      }
    | undefined,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarImage: () => avatarHookMocks.image,
  useAvatarMediaState: () => ({
    media: avatarHookMocks.media,
    loading: false,
    unavailable: false,
    retry: vi.fn(),
  }),
}));

vi.mock("./HolographicAgentCard", () => ({
  HolographicAgentCard: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("./agentShareCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agentShareCard")>();
  return {
    ...actual,
    createAvatarPoster: vi.fn(async (media) =>
      media.posterSrc ? media.posterSrc : "data:image/png;base64,poster",
    ),
    downloadBlob: vi.fn(),
    renderAgentShareCard: vi.fn(),
  };
});

const persona: Persona = {
  id: "/agents/reviewer.md",
  displayName: "Reviewer",
  systemPrompt: "Review code carefully.",
  isBuiltin: false,
  writable: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("AgentShareDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    avatarHookMocks.image = "https://example.com/avatar.png";
    avatarHookMocks.media = undefined;
  });

  it("uses a generated avatar poster when composing the card", async () => {
    avatarHookMocks.image = undefined;
    avatarHookMocks.media = {
      src: "asset://generated-avatar.webm",
      mediaType: "video",
      posterSrc: "asset://generated-avatar.png",
    };
    vi.mocked(renderAgentShareCard).mockResolvedValue(
      new Blob(["card"], { type: "image/png" }),
    );
    const generatedPersona = {
      ...persona,
      avatar: "user-avatar:generated",
    };
    const user = userEvent.setup();

    render(
      <AgentShareDialog
        open
        persona={generatedPersona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "share.downloadCard" }),
    );

    await waitFor(() =>
      expect(renderAgentShareCard).toHaveBeenCalledWith(
        generatedPersona,
        "asset://generated-avatar.png",
        expect.any(String),
      ),
    );
  });

  it("creates a still frame for generated videos without posters", async () => {
    avatarHookMocks.image = undefined;
    avatarHookMocks.media = {
      src: "asset://generated-avatar.mp4",
      mediaType: "video",
    };
    vi.mocked(renderAgentShareCard).mockResolvedValue(
      new Blob(["card"], { type: "image/png" }),
    );
    const generatedPersona = {
      ...persona,
      avatar: "user-avatar:animated",
    };
    const user = userEvent.setup();

    render(
      <AgentShareDialog
        open
        persona={generatedPersona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "share.downloadCard" }),
    );

    await waitFor(() =>
      expect(createAvatarPoster).toHaveBeenCalledWith(avatarHookMocks.media),
    );
    expect(renderAgentShareCard).toHaveBeenCalledWith(
      generatedPersona,
      "data:image/png;base64,poster",
      expect.any(String),
    );
  });

  it("drops a generated poster when the avatar is removed", async () => {
    avatarHookMocks.image = undefined;
    avatarHookMocks.media = {
      src: "asset://generated-avatar.mp4",
      mediaType: "video",
    };
    const generatedPersona = {
      ...persona,
      avatar: "user-avatar:animated",
    };
    const { rerender } = render(
      <AgentShareDialog
        open
        persona={generatedPersona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.querySelector("img")).toHaveAttribute(
        "src",
        "data:image/png;base64,poster",
      ),
    );

    avatarHookMocks.media = undefined;
    rerender(
      <AgentShareDialog
        open
        persona={{ ...persona, avatar: undefined }}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );

    expect(document.querySelector("img")).not.toHaveAttribute(
      "src",
      "data:image/png;base64,poster",
    );
  });

  it("suppresses an in-flight card when the avatar changes", async () => {
    const pendingCard = deferred<Blob>();
    vi.mocked(renderAgentShareCard).mockReturnValueOnce(pendingCard.promise);
    const { rerender } = render(
      <AgentShareDialog
        open
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );

    act(() => {
      screen.getByRole("button", { name: "share.downloadCard" }).click();
    });
    rerender(
      <AgentShareDialog
        open
        persona={{ ...persona, avatar: "https://example.com/new-avatar.png" }}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    await act(async () => {
      pendingCard.resolve(new Blob(["stale-card"], { type: "image/png" }));
      await pendingCard.promise;
    });

    expect(downloadBlob).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    const downloadButton = screen.getByRole("button", {
      name: "share.downloadCard",
    });
    expect(downloadButton).toBeEnabled();

    vi.mocked(renderAgentShareCard).mockResolvedValueOnce(
      new Blob(["new-card"], { type: "image/png" }),
    );
    act(() => {
      downloadButton.click();
    });
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
  });

  it("reports card-generation failures and allows retrying", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const renderCard = vi.mocked(renderAgentShareCard);
    renderCard.mockRejectedValueOnce(new Error("CORS blocked avatar"));
    renderCard.mockResolvedValueOnce(new Blob(["card"], { type: "image/png" }));
    const user = userEvent.setup();

    render(
      <AgentShareDialog
        open
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );

    const downloadButton = screen.getByRole("button", {
      name: "share.downloadCard",
    });
    await user.click(downloadButton);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("share.cardDownloadFailed");
    });
    expect(downloadButton).toBeEnabled();

    await user.click(downloadButton);
    await waitFor(() => expect(renderCard).toHaveBeenCalledTimes(2));
    consoleError.mockRestore();
  });

  it("suppresses a pending card download after the dialog closes", async () => {
    const pendingCard = deferred<Blob>();
    vi.mocked(renderAgentShareCard).mockReturnValueOnce(pendingCard.promise);
    const user = userEvent.setup();
    const { rerender } = render(
      <AgentShareDialog
        open
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "share.downloadCard" }),
    );
    rerender(
      <AgentShareDialog
        open={false}
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    pendingCard.resolve(new Blob(["card"], { type: "image/png" }));

    await waitFor(() => expect(renderAgentShareCard).toHaveBeenCalledTimes(1));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("starts only one card download for rapid duplicate activation", async () => {
    const pendingCard = deferred<Blob>();
    vi.mocked(renderAgentShareCard).mockReturnValue(pendingCard.promise);
    render(
      <AgentShareDialog
        open
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );

    const downloadButton = screen.getByRole("button", {
      name: "share.downloadCard",
    });
    act(() => {
      downloadButton.click();
      downloadButton.click();
    });

    expect(renderAgentShareCard).toHaveBeenCalledTimes(1);
    await act(async () => {
      pendingCard.resolve(new Blob(["card"], { type: "image/png" }));
      await pendingCard.promise;
    });
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
  });
});
