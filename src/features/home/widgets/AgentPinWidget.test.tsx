import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedAvatarForRef } from "@/shared/api/avatars";
import type { Persona } from "@/shared/types/agents";
import type { WidgetInstance } from "./types";
import { AgentPinWidget } from "./AgentPinWidget";

const state = vi.hoisted(() => ({ personas: [] as Persona[] }));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: (selector: (store: { personas: Persona[] }) => unknown) =>
    selector(state),
}));

vi.mock("@/shared/api/avatars", () => ({
  avatarCachedRefQueryKey: (avatarRef: string) => [
    "avatars",
    "cached-ref",
    avatarRef,
  ],
  cachedAssetToMedia: (asset: { path: string; mimeType: string }) => ({
    src: `asset://${asset.path}`,
    mediaType: asset.mimeType.startsWith("video/") ? "video" : "image",
  }),
  getCachedAvatarForRef: vi.fn(),
  listenAvatarCacheWarmed: vi.fn(() => Promise.resolve(vi.fn())),
}));

const getCachedAvatarForRefMock = vi.mocked(getCachedAvatarForRef);

const instance: WidgetInstance = {
  id: "agent-pin-1",
  type: "agentPin",
  x: 20,
  y: 30,
  z: 1,
  state: { agentId: "agent-1" },
};

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "agent-1",
    displayName: "Agent One",
    systemPrompt: "You are a focused coding agent.",
    isBuiltin: false,
    writable: true,
    ...overrides,
  };
}

function renderPin() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  return render(
    <AgentPinWidget
      instance={instance}
      onUpdateState={vi.fn()}
      onOpenAgent={vi.fn()}
    />,
    { wrapper: Wrapper },
  );
}

describe("AgentPinWidget", () => {
  beforeEach(() => {
    state.personas = [persona()];
    getCachedAvatarForRefMock.mockReset();
    getCachedAvatarForRefMock.mockResolvedValue({
      catalogVersion: "v1",
      collectionId: "gloopies",
      asset: {
        id: "gloopy-1",
        path: "/tmp/goose/avatars/v1/hevc/gloopies/gloopy-1.mp4",
        mimeType: "video/mp4",
      },
    });
    vi.clearAllMocks();
  });

  it.each([
    ["remote", "https://example.test/scout.png", 'img[src$="scout.png"]'],
    ["bundled", "app-avatar:gloopy-1", "video"],
  ])("renders %s avatars as a transparent visual tile", async (_, avatar, media) => {
    state.personas = [persona({ avatar })];

    const { container } = renderPin();
    const button = screen.getByRole("button", {
      name: "Start chat with Agent One",
    });

    await waitFor(() => expect(button).toHaveClass("bg-transparent"));
    expect(button).toHaveClass("aspect-square", "w-full", "rounded-full");
    expect(button).not.toHaveClass("bg-card");
    expect(screen.getByTestId("agent-pin-hover-label")).toHaveTextContent(
      "Agent One",
    );
    expect(screen.getByTestId("agent-pin-hover-label")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByTestId("agent-pin-hover-label")).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100",
      "group-focus-within:opacity-100",
      "bg-card/90",
      "text-foreground",
      "translate-y-2",
      "backdrop-blur-md",
    );
    await waitFor(() =>
      expect(container.querySelector(media)).toBeInTheDocument(),
    );
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
  });

  it("renders the avatar layout with the deterministic agent artwork fallback when no avatar is set", () => {
    const { container } = renderPin();

    const button = screen.getByRole("button", {
      name: "Start chat with Agent One",
    });
    expect(button).toHaveClass("bg-transparent");
    expect(button).not.toHaveClass("bg-card");
    expect(screen.getByTestId("agent-pin-hover-label")).toHaveTextContent(
      "Agent One",
    );
    expect(screen.getByTestId("agent-pin-hover-label")).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100",
    );
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(container.querySelector('img[aria-hidden="true"]')).toBeTruthy();
    expect(screen.queryByText("A")).not.toBeInTheDocument();
  });
});
