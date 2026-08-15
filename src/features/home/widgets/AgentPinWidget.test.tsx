import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedAvatarForRef } from "@/shared/api/avatars";
import { setHomePinLabelsAlwaysVisible } from "@/features/home/lib/homePinLabelPreference";
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

function renderPin({
  onOpenAgent = vi.fn(),
  onTagAgentInComposer,
}: {
  onOpenAgent?: (agentId: string) => void;
  onTagAgentInComposer?: (agentId: string) => void;
} = {}) {
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
      onOpenAgent={onOpenAgent}
      onTagAgentInComposer={onTagAgentInComposer}
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
    localStorage.clear();
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

  it("keeps the decoded avatar node mounted across rerenders", async () => {
    state.personas = [
      persona({ avatar: "https://example.test/berdy-drag-frame.png" }),
    ];
    const onOpenAgent = vi.fn();
    const view = renderPin({ onOpenAgent });
    const button = screen.getByRole("button", {
      name: "Start chat with Agent One",
    });

    await waitFor(() =>
      expect(
        view.container.querySelector(
          'img[src="https://example.test/berdy-drag-frame.png"]',
        ),
      ).toBeInTheDocument(),
    );
    const avatarBeforeDrag = view.container.querySelector(
      'img[src="https://example.test/berdy-drag-frame.png"]',
    );
    expect(avatarBeforeDrag).toBeInTheDocument();
    fireEvent.pointerDown(button);

    view.rerender(
      <AgentPinWidget
        instance={{ ...instance }}
        onUpdateState={vi.fn()}
        onOpenAgent={onOpenAgent}
      />,
    );

    const matchingImages = view.container.querySelectorAll(
      'img[src="https://example.test/berdy-drag-frame.png"]',
    );
    expect(matchingImages).toHaveLength(1);
    expect(matchingImages[0]).toBe(avatarBeforeDrag);
    expect(matchingImages[0]?.parentElement).not.toHaveClass("invisible");
  });

  it("keeps the label always visible when the home pin labels preference is enabled", () => {
    setHomePinLabelsAlwaysVisible(true);

    renderPin();

    const label = screen.getByTestId("agent-pin-hover-label");
    expect(label).toHaveTextContent("Agent One");
    expect(label).toHaveClass("opacity-100");
    expect(label).not.toHaveClass("opacity-0", "group-hover:opacity-100");
  });

  it("tags the agent in the composer instead of opening the agent directly when requested", () => {
    const onOpenAgent = vi.fn();
    const onTagAgentInComposer = vi.fn();
    renderPin({ onOpenAgent, onTagAgentInComposer });

    fireEvent.click(
      screen.getByRole("button", { name: "Start chat with Agent One" }),
    );

    expect(onTagAgentInComposer).toHaveBeenCalledWith("agent-1");
    expect(onOpenAgent).not.toHaveBeenCalled();
  });
});
