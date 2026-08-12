import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Persona } from "@/shared/types/agents";
import { toast } from "sonner";
import { MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES } from "@/features/agents/agent-snapshot";
import { encodeAgentImage } from "@/features/agents/agent-snapshot";
import { AgentShareDialog } from "./AgentShareDialog";
import { downloadBlob, renderAgentShareCard } from "./agentShareCard";

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

vi.mock("@/features/agents/agent-snapshot", () => ({
  MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES: 5 * 1024 * 1024,
  encodeAgentImage: vi.fn((bytes: Uint8Array) => bytes),
  personaToSnapshot: vi.fn(() => ({})),
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
  holographicCardPresets: { rainbowPrism: {} },
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

  it("prevents duplicate agent-file downloads while one is pending", async () => {
    const pending = deferred<void>();
    const onDownloadAgent = vi.fn(() => pending.promise);
    render(
      <AgentShareDialog
        open
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={onDownloadAgent}
      />,
    );
    const button = screen.getByRole("button", { name: "share.downloadAgent" });

    act(() => {
      button.click();
      button.click();
    });

    expect(onDownloadAgent).toHaveBeenCalledTimes(1);
    pending.resolve();
    await waitFor(() => expect(button).not.toBeDisabled());
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

  it("omits oversized avatar animation while still downloading the card", async () => {
    avatarHookMocks.image = undefined;
    avatarHookMocks.media = {
      src: "https://example.com/generated-avatar.webm",
      mediaType: "video",
      posterSrc: "https://example.com/generated-avatar.png",
    };
    vi.mocked(renderAgentShareCard).mockResolvedValue(
      new Blob(["card"], { type: "image/png" }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const source = String(input);
      const bytes = source.endsWith(".webm")
        ? new Uint8Array(MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES + 1)
        : new Uint8Array([137, 80, 78, 71]);
      const blob = new Blob([bytes], {
        type: source.endsWith(".webm") ? "video/webm" : "image/png",
      });
      Object.defineProperty(blob, "arrayBuffer", {
        value: async () => bytes.buffer,
      });
      return { ok: true, blob: async () => blob } as Response;
    }) as typeof fetch;

    try {
      render(
        <AgentShareDialog
          open
          persona={{ ...persona, avatar: "user-avatar:generated" }}
          onOpenChange={vi.fn()}
          onDownloadAgent={vi.fn()}
        />,
      );
      await userEvent.click(
        screen.getByRole("button", { name: "share.downloadCard" }),
      );

      await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
      expect(encodeAgentImage).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        expect.anything(),
        null,
      );
      expect(toast.success).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back locally when a configured avatar cannot resolve", async () => {
    avatarHookMocks.image = undefined;
    avatarHookMocks.media = undefined;

    render(
      <AgentShareDialog
        open
        persona={{ ...persona, avatar: "user-avatar:missing" }}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );

    const fallback = document.querySelector<HTMLImageElement>(
      'img[src*="goose-avatar"]',
    );
    expect(fallback).not.toBeNull();
    fireEvent.load(fallback as HTMLImageElement);
    await waitFor(() =>
      expect(
        screen.queryByLabelText("share.loadingCard"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "share.downloadCard" }),
    ).toBeEnabled();
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
