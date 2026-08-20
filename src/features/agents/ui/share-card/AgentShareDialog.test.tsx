import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
import { createStoredAgentZip } from "./agentZip";
import type { Persona } from "@/shared/types/agents";
import { toast } from "sonner";
import {
  AgentSnapshotError,
  encodeAgentImage,
  MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES,
  personaToSnapshot,
} from "@/features/agents/agent-snapshot";
import { readCachedAvatarAnimation } from "@/shared/api/avatars";
import {
  AgentShareDialog,
  AVATAR_ANIMATION_EMBED_TIMEOUT_MS,
  createAgentZip,
} from "./AgentShareDialog";
import { downloadBlob, renderAgentShareCard } from "./agentShareCard";

const workerMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  terminate: vi.fn(),
  mode: "success" as "success" | "error" | "hang",
}));

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() {
    workerMocks.construct();
  }

  postMessage(data: { pngFilename: string; contents: Uint8Array }) {
    if (workerMocks.mode === "hang") return;
    if (workerMocks.mode === "error") {
      queueMicrotask(() =>
        this.onmessage?.({ data: { error: "worker failed" } } as MessageEvent),
      );
      return;
    }
    const archive = createStoredAgentZip(data.pngFilename, data.contents);
    queueMicrotask(() =>
      this.onmessage?.({ data: { archive } } as MessageEvent),
    );
  }

  terminate() {
    workerMocks.terminate();
  }
}

vi.stubGlobal("Worker", MockWorker);

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
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/features/agents/agent-snapshot", () => ({
  AgentSnapshotError: class AgentSnapshotError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
  MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES: 5 * 1024 * 1024,
  encodeAgentImage: vi.fn((bytes: Uint8Array) => bytes),
  personaToSnapshot: vi.fn(() => ({})),
}));

vi.mock("@/shared/api/avatars", () => ({
  readCachedAvatarAnimation: vi.fn(),
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

async function markCardReady(): Promise<void> {
  const preload = await waitFor(() => {
    const image = document.querySelector<HTMLImageElement>(
      '[data-testid="agent-card-avatar-preload"]',
    );
    expect(image).not.toBeNull();
    return image as HTMLImageElement;
  });
  fireEvent.load(preload);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "share.downloadPng" }),
    ).toBeEnabled(),
  );
}

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
    workerMocks.mode = "success";
    avatarHookMocks.image = "https://example.com/avatar.png";
    avatarHookMocks.media = undefined;
    vi.mocked(readCachedAvatarAnimation).mockResolvedValue(null);
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

    await userEvent.click(
      screen.getByRole("button", { name: "share.downloadOptions" }),
    );
    const markdownAction = screen.getByRole("menuitem", {
      name: "share.downloadMarkdown",
    });
    await userEvent.click(markdownAction);
    expect(screen.getByTestId("agent-download-status")).toHaveTextContent(
      "share.downloadingAgent",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "share.downloadOptions" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "share.downloadMarkdown" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(onDownloadAgent).toHaveBeenCalledTimes(1);

    pending.resolve();
    await waitFor(() =>
      expect(
        screen.queryByTestId("agent-download-status"),
      ).not.toBeInTheDocument(),
    );
  });

  it("packages the portable PNG in a ZIP for Slack", async () => {
    const encoded = new Uint8Array([1, 2, 3, 4]);
    vi.mocked(renderAgentShareCard).mockResolvedValue(
      new Blob(["card"], { type: "image/png" }),
    );
    vi.mocked(encodeAgentImage).mockReturnValue(encoded);
    render(
      <AgentShareDialog
        open
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    await markCardReady();

    await userEvent.click(
      screen.getByRole("button", { name: "share.downloadOptions" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "share.downloadZip" }),
    );

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
    expect(filename).toBe("reviewer.agent.zip");
    expect(blob.type).toBe("application/zip");
    const archiveBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(blob);
    });
    const archive = unzipSync(new Uint8Array(archiveBytes));
    expect(archive["reviewer.agent.png"]).toEqual(encoded);
  });

  it("recovers when the ZIP worker fails", async () => {
    workerMocks.mode = "error";
    vi.mocked(renderAgentShareCard).mockResolvedValue(
      new Blob(["card"], { type: "image/png" }),
    );
    render(
      <AgentShareDialog
        open
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    await markCardReady();
    await userEvent.click(
      screen.getByRole("button", { name: "share.downloadOptions" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "share.downloadZip" }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "share.downloadPng" }),
    ).toBeEnabled();
  });

  it("terminates a pending ZIP worker when the dialog closes", async () => {
    workerMocks.mode = "hang";
    vi.mocked(renderAgentShareCard).mockResolvedValue(
      new Blob(["card"], { type: "image/png" }),
    );
    const { rerender } = render(
      <AgentShareDialog
        open
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    await markCardReady();
    await userEvent.click(
      screen.getByRole("button", { name: "share.downloadOptions" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "share.downloadZip" }),
    );
    await waitFor(() => expect(workerMocks.construct).toHaveBeenCalled());

    rerender(
      <AgentShareDialog
        open={false}
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    await waitFor(() => expect(workerMocks.terminate).toHaveBeenCalled());
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("terminates a ZIP worker that never responds", async () => {
    vi.useFakeTimers();
    workerMocks.mode = "hang";
    try {
      const result = createAgentZip(
        "reviewer.agent.png",
        new Uint8Array([1, 2, 3]),
        undefined,
        100,
      );
      const rejection = expect(result).rejects.toThrow("ZIP worker timed out");

      await vi.advanceTimersByTimeAsync(100);

      await rejection;
      expect(workerMocks.terminate).toHaveBeenCalled();
    } finally {
      workerMocks.mode = "success";
      vi.useRealTimers();
    }
  });

  it("recognizes an avatar that completed before its load handler attached", async () => {
    const originalComplete = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "complete",
    );
    const originalNaturalWidth = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "naturalWidth",
    );
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
      configurable: true,
      get: () => 400,
    });

    try {
      render(
        <AgentShareDialog
          open
          persona={persona}
          onOpenChange={vi.fn()}
          onDownloadAgent={vi.fn()}
        />,
      );

      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "share.downloadPng" }),
        ).not.toBeDisabled(),
      );
      await waitFor(() =>
        expect(
          screen.queryByLabelText("share.loadingCard"),
        ).not.toBeInTheDocument(),
      );
    } finally {
      if (originalComplete) {
        Object.defineProperty(
          HTMLImageElement.prototype,
          "complete",
          originalComplete,
        );
      }
      if (originalNaturalWidth) {
        Object.defineProperty(
          HTMLImageElement.prototype,
          "naturalWidth",
          originalNaturalWidth,
        );
      }
    }
  });

  it("keeps the modal out of scroll containment for the refraction halo", () => {
    render(
      <AgentShareDialog
        open
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveClass(
      "overflow-visible",
      "overflow-y-visible",
    );
  });

  it("uses viewport-safe geometry for loading and unavailable states", async () => {
    const { rerender } = render(
      <AgentShareDialog
        open
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText("share.loadingCard").parentElement,
    ).toHaveClass("max-w-[min(19rem,calc((100dvh-18rem)*0.6667))]");

    fireEvent.error(screen.getByTestId("agent-card-avatar-preload"));
    await waitFor(() =>
      expect(screen.getByTestId("agent-card-avatar-preload")).toHaveAttribute(
        "src",
        expect.not.stringContaining("example.com"),
      ),
    );
    fireEvent.error(screen.getByTestId("agent-card-avatar-preload"));
    expect(await screen.findByRole("status")).toHaveClass(
      "max-w-[min(19rem,calc((100dvh-18rem)*0.6667))]",
    );

    rerender(
      <AgentShareDialog
        open={false}
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
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
    await markCardReady();
    await user.click(screen.getByRole("button", { name: "share.downloadPng" }));

    await waitFor(() =>
      expect(renderAgentShareCard).toHaveBeenCalledWith(
        generatedPersona,
        "asset://generated-avatar.png",
        expect.any(String),
        "en",
        expect.any(String),
      ),
    );
  });

  it("does not persist localized fallback copy as an authored description", async () => {
    const user = userEvent.setup();
    render(
      <AgentShareDialog
        open
        persona={{ ...persona, sourceDescription: undefined }}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    await markCardReady();
    await user.click(screen.getByRole("button", { name: "share.downloadPng" }));

    await waitFor(() => expect(personaToSnapshot).toHaveBeenCalled());
    expect(vi.mocked(personaToSnapshot).mock.calls[0]?.[0]).toMatchObject({
      sourceDescription: undefined,
    });
  });

  it("embeds cached asset-protocol avatar animation", async () => {
    avatarHookMocks.image = undefined;
    avatarHookMocks.media = {
      src: "asset://generated-avatar.webm",
      mediaType: "video",
      posterSrc: "asset://generated-avatar.png",
    };
    vi.mocked(readCachedAvatarAnimation).mockResolvedValue({
      bytes: [1, 2, 3],
      mimeType: "video/webm",
    });
    vi.mocked(renderAgentShareCard).mockResolvedValue(
      new Blob(["card"], { type: "image/png" }),
    );

    render(
      <AgentShareDialog
        open
        persona={{ ...persona, avatar: "user-avatar:generated" }}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    await markCardReady();
    await userEvent.click(
      screen.getByRole("button", { name: "share.downloadPng" }),
    );

    await waitFor(() =>
      expect(encodeAgentImage).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        expect.anything(),
        expect.objectContaining({
          bytes: Uint8Array.from([1, 2, 3]),
          mimeType: "video/webm",
        }),
      ),
    );
  });

  it("falls back when an avatar preload stalls", async () => {
    vi.useFakeTimers();
    try {
      render(
        <AgentShareDialog
          open
          persona={persona}
          onOpenChange={vi.fn()}
          onDownloadAgent={vi.fn()}
        />,
      );
      const firstPreload = screen.getByTestId("agent-card-avatar-preload");
      expect(firstPreload).toHaveAttribute(
        "src",
        "https://example.com/avatar.png",
      );

      act(() => vi.advanceTimersByTime(10_000));

      const fallbackPreload = screen.getByTestId("agent-card-avatar-preload");
      expect(fallbackPreload).not.toHaveAttribute(
        "src",
        "https://example.com/avatar.png",
      );
      fireEvent.load(fallbackPreload);
      expect(
        screen.getByRole("button", { name: "share.downloadPng" }),
      ).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an empty-card error when every avatar source fails", async () => {
    render(
      <AgentShareDialog
        open
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );

    fireEvent.error(screen.getByTestId("agent-card-avatar-preload"));
    await waitFor(() =>
      expect(
        screen.getByTestId("agent-card-avatar-preload"),
      ).not.toHaveAttribute("src", "https://example.com/avatar.png"),
    );
    fireEvent.error(screen.getByTestId("agent-card-avatar-preload"));

    const error = await screen.findByRole("status");
    expect(error).toHaveTextContent("share.avatarUnavailable");
    expect(error).toHaveClass("text-sm");
    expect(
      screen.getByRole("button", { name: "share.downloadPng" }),
    ).toBeDisabled();
  });

  it("uses the fetched animation MIME for extensionless URLs", async () => {
    avatarHookMocks.image = undefined;
    avatarHookMocks.media = {
      src: "https://example.com/generated-avatar",
      mediaType: "video",
      posterSrc: "https://example.com/generated-avatar.png",
    };
    vi.mocked(renderAgentShareCard).mockResolvedValue(
      new Blob(["card"], { type: "image/png" }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      const bytes = Uint8Array.from([0, 0, 0, 0, 102, 116, 121, 112]);
      const blob = new Blob([bytes], { type: "video/mp4" });
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
      await markCardReady();
      await userEvent.click(
        screen.getByRole("button", { name: "share.downloadPng" }),
      );

      await waitFor(() =>
        expect(encodeAgentImage).toHaveBeenCalledWith(
          expect.any(Uint8Array),
          expect.anything(),
          expect.objectContaining({ mimeType: "video/mp4" }),
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to a still card when animation fetching stalls", async () => {
    vi.useFakeTimers();
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
    globalThis.fetch = vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith(".png")) {
        const bytes = Uint8Array.from([137, 80, 78, 71]);
        return Promise.resolve({
          ok: true,
          headers: new Headers(),
          blob: async () => new Blob([bytes], { type: "image/png" }),
        } as Response);
      }
      return new Promise<Response>(() => undefined);
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
      fireEvent.load(screen.getByTestId("agent-card-avatar-preload"));
      fireEvent.click(
        screen.getByRole("button", { name: "share.downloadPng" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AVATAR_ANIMATION_EMBED_TIMEOUT_MS);
        await vi.runAllTimersAsync();
      });

      expect(encodeAgentImage).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        expect.anything(),
        null,
      );
      expect(downloadBlob).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: "share.downloadPng" }),
      ).not.toBeDisabled();
    } finally {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });

  it("does not embed failed or non-video animation responses", async () => {
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
    let animationAttempt = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith(".png")) {
        const bytes = Uint8Array.from([137, 80, 78, 71]);
        const blob = new Blob([bytes], { type: "image/png" });
        Object.defineProperty(blob, "arrayBuffer", {
          value: async () => bytes.buffer,
        });
        return {
          ok: true,
          headers: new Headers(),
          blob: async () => blob,
        } as Response;
      }
      animationAttempt += 1;
      return animationAttempt === 1
        ? ({ ok: false } as Response)
        : ({
            ok: true,
            blob: async () => new Blob(["error"], { type: "text/html" }),
          } as Response);
    }) as typeof fetch;

    try {
      const { unmount } = render(
        <AgentShareDialog
          open
          persona={{ ...persona, avatar: "user-avatar:generated" }}
          onOpenChange={vi.fn()}
          onDownloadAgent={vi.fn()}
        />,
      );
      await markCardReady();
      await userEvent.click(
        screen.getByRole("button", { name: "share.downloadPng" }),
      );
      await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
      expect(encodeAgentImage).toHaveBeenLastCalledWith(
        expect.any(Uint8Array),
        expect.anything(),
        null,
      );
      unmount();

      render(
        <AgentShareDialog
          open
          persona={{ ...persona, avatar: "user-avatar:generated" }}
          onOpenChange={vi.fn()}
          onDownloadAgent={vi.fn()}
        />,
      );
      await markCardReady();
      await userEvent.click(
        screen.getByRole("button", { name: "share.downloadPng" }),
      );
      await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(2));
      expect(encodeAgentImage).toHaveBeenLastCalledWith(
        expect.any(Uint8Array),
        expect.anything(),
        null,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries without animation when the combined card exceeds the PNG limit", async () => {
    avatarHookMocks.image = undefined;
    avatarHookMocks.media = {
      src: "https://example.com/generated-avatar.webm",
      mediaType: "video",
      posterSrc: "https://example.com/generated-avatar.png",
    };
    vi.mocked(renderAgentShareCard).mockResolvedValue(
      new Blob(["card"], { type: "image/png" }),
    );
    vi.mocked(encodeAgentImage)
      .mockImplementationOnce(() => {
        throw new AgentSnapshotError("too large", "too-large");
      })
      .mockImplementationOnce((bytes) => bytes);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const blob = new Blob([bytes], { type: "video/webm" });
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
      await markCardReady();
      await userEvent.click(
        screen.getByRole("button", { name: "share.downloadPng" }),
      );

      await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
      expect(encodeAgentImage).toHaveBeenCalledTimes(2);
      expect(encodeAgentImage).toHaveBeenLastCalledWith(
        expect.any(Uint8Array),
        expect.anything(),
        null,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
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
      await markCardReady();
      await userEvent.click(
        screen.getByRole("button", { name: "share.downloadPng" }),
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

  it("does not embed animation when the reviewed still is a fallback", async () => {
    avatarHookMocks.image = undefined;
    avatarHookMocks.media = {
      src: "https://example.com/generated-avatar.webm",
      mediaType: "video",
      posterSrc: "https://example.com/generated-avatar.png",
    };
    vi.mocked(renderAgentShareCard).mockResolvedValue(
      new Blob(["card"], { type: "image/png" }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(
      <AgentShareDialog
        open
        persona={{ ...persona, avatar: "user-avatar:generated" }}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    const poster = document.querySelector<HTMLImageElement>(
      '[data-testid="agent-card-avatar-preload"]',
    );
    fireEvent.error(poster as HTMLImageElement);
    await markCardReady();
    await userEvent.click(
      screen.getByRole("button", { name: "share.downloadPng" }),
    );

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(fetchSpy).not.toHaveBeenCalledWith(
      "https://example.com/generated-avatar.webm",
    );
    expect(encodeAgentImage).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.anything(),
      null,
    );
    fetchSpy.mockRestore();
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

    const fallback = screen.getByTestId("agent-card-avatar-preload");
    expect(fallback).toHaveAttribute(
      "src",
      expect.stringContaining("goose-avatar"),
    );
    fireEvent.load(fallback);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "share.downloadPng" }),
      ).toBeEnabled(),
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

    await markCardReady();
    act(() => {
      screen.getByRole("button", { name: "share.downloadPng" }).click();
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
    await markCardReady();
    const downloadButton = screen.getByRole("button", {
      name: "share.downloadPng",
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

    await markCardReady();
    const downloadButton = screen.getByRole("button", {
      name: "share.downloadPng",
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

    await markCardReady();
    await user.click(screen.getByRole("button", { name: "share.downloadPng" }));
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

    rerender(
      <AgentShareDialog
        open
        persona={persona}
        onOpenChange={vi.fn()}
        onDownloadAgent={vi.fn()}
      />,
    );
    await markCardReady();
    expect(
      screen.getByRole("button", { name: "share.downloadPng" }),
    ).toBeEnabled();
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

    await markCardReady();
    const downloadButton = screen.getByRole("button", {
      name: "share.downloadPng",
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

  it("falls back when cached animation IPC stalls and ignores late bytes", async () => {
    vi.useFakeTimers();
    avatarHookMocks.image = undefined;
    avatarHookMocks.media = {
      src: "asset://generated-avatar.webm",
      mediaType: "video",
      posterSrc: "asset://generated-avatar.png",
    };
    const cachedAnimation = deferred<{
      bytes: number[];
      mimeType: string;
    } | null>();
    vi.mocked(readCachedAvatarAnimation).mockReturnValue(
      cachedAnimation.promise,
    );
    vi.mocked(renderAgentShareCard).mockResolvedValue(
      new Blob(["card"], { type: "image/png" }),
    );

    let unmount: () => void = () => undefined;
    try {
      ({ unmount } = render(
        <AgentShareDialog
          open
          persona={{ ...persona, avatar: "user-avatar:generated" }}
          onOpenChange={vi.fn()}
          onDownloadAgent={vi.fn()}
        />,
      ));
      fireEvent.load(screen.getByTestId("agent-card-avatar-preload"));
      fireEvent.click(
        screen.getByRole("button", { name: "share.downloadPng" }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AVATAR_ANIMATION_EMBED_TIMEOUT_MS);
        await vi.runAllTimersAsync();
      });

      expect(encodeAgentImage).toHaveBeenCalledTimes(1);
      expect(encodeAgentImage).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        expect.anything(),
        null,
      );
      expect(downloadBlob).toHaveBeenCalledTimes(1);

      cachedAnimation.resolve({ bytes: [1, 2, 3], mimeType: "video/webm" });
      await cachedAnimation.promise;
      await Promise.resolve();
      expect(encodeAgentImage).toHaveBeenCalledTimes(1);
      expect(downloadBlob).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });
});
