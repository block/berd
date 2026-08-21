import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setHomePinLabelsAlwaysVisible } from "@/features/home/lib/homePinLabelPreference";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import type { WidgetRenderProps } from "./types";
import { OnboardingTourWidget } from "./OnboardingTourWidget";

vi.mock("@/shared/hooks/useArtifacts", () => ({
  useArtifacts: () => ({ data: null }),
}));

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarMedia: () => ({
    src: "asset://localhost/gloopies-22.webm",
    mediaType: "video",
  }),
}));

const avatarMediaRenderMock = vi.hoisted(() => vi.fn());

vi.mock("@/shared/ui/avatar-media", () => ({
  AvatarMedia: ({
    alt,
    loadingStrategy,
    playbackMode,
  }: {
    alt: string;
    loadingStrategy: string;
    playbackMode: string;
  }) => {
    avatarMediaRenderMock();
    return (
      <div
        role="img"
        aria-label={alt}
        data-testid="animated-berdy"
        data-loading-strategy={loadingStrategy}
        data-playback-mode={playbackMode}
      />
    );
  },
}));

const baseProps: WidgetRenderProps = {
  instance: {
    id: "onboarding-tour-test",
    type: "onboardingTour",
    x: 0,
    y: 0,
    z: 0,
  },
  onUpdateState: vi.fn(),
};

describe("OnboardingTourWidget", () => {
  beforeEach(() => {
    localStorage.clear();
    avatarMediaRenderMock.mockClear();
    useAgentStore.setState({
      personas: [
        {
          id: "/Users/test/.agents/agents/berdy.md",
          displayName: "Berdy",
          avatar: "app-avatar:gloopies-22",
          systemPrompt: "Help people use Berd.",
          isBuiltin: false,
          writable: true,
          sourceProperties: {
            metadata: {
              berdBundled: true,
            },
          },
        },
      ],
    });
  });

  it("uses 14px type and grows a gloopy bubble from the avatar", () => {
    render(<OnboardingTourWidget {...baseProps} />);

    expect(screen.getByTestId("animated-berdy")).toHaveAttribute(
      "data-loading-strategy",
      "eager",
    );
    expect(screen.getByTestId("animated-berdy")).toHaveAttribute(
      "data-playback-mode",
      "occasional",
    );
    expect(document.querySelector("[data-onboarding-tour-avatar]")).toHaveClass(
      "overflow-visible",
      "drop-shadow-[0_12px_12px_rgba(0,0,0,0.05)]",
    );
    expect(screen.getByTestId("onboarding-tour-hover-label")).toHaveTextContent(
      "Berdy",
    );
    expect(screen.getByTestId("onboarding-tour-hover-label")).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100",
      "group-focus-within:opacity-100",
      "bg-card/90",
      "text-foreground",
      "top-full",
      "mt-1",
      "backdrop-blur-md",
    );
    expect(screen.getByTestId("onboarding-tour-hover-label")).not.toHaveClass(
      "bottom-1",
      "translate-y-2",
    );
    const bubble = screen
      .getByText("Welcome!")
      .closest("[data-onboarding-tour-bubble]");

    expect(bubble).toHaveClass("absolute", "bottom-24", "left-36", "text-sm");
    expect(
      bubble?.querySelector(".onboarding-tour-bubble-shell"),
    ).not.toBeInTheDocument();
    expect(
      bubble?.querySelector("[data-onboarding-tour-bubble-flow]"),
    ).not.toHaveClass("drop-shadow-[0_12px_18px_rgba(0,0,0,0.14)]");
    expect(
      bubble?.querySelector("[data-onboarding-tour-liquid-shadow] filter"),
    ).toHaveAttribute("x", "-30%");
    expect(
      bubble?.querySelector("[data-onboarding-tour-liquid] path"),
    ).toHaveClass("fill-card");
    expect(
      bubble?.querySelector('[data-onboarding-tour-caret-dot="small"]'),
    ).toHaveClass("-bottom-9", "left-1", "size-3", "rounded-full");
    expect(
      bubble?.querySelector('[data-onboarding-tour-caret-dot="large"]'),
    ).toHaveClass("-bottom-4", "left-4", "size-8", "rounded-full");
    expect(
      bubble?.querySelectorAll("[data-onboarding-tour-liquid-shadow] circle"),
    ).toHaveLength(0);
    expect(
      bubble?.querySelector(".onboarding-tour-bubble-content"),
    ).not.toHaveClass(
      "drop-shadow-[0_12px_18px_rgba(0,0,0,0.14)]",
      "dark:drop-shadow-[0_12px_18px_rgba(0,0,0,0.32)]",
    );
    expect(screen.getByText("Welcome!")).toHaveClass("pr-5");
    expect(
      bubble?.querySelector(".onboarding-tour-bubble-content"),
    ).not.toHaveClass("pr-10");
    expect(screen.getByRole("button", { name: "Take a tour" })).toHaveClass(
      "bg-accent",
      "text-sm",
      "shadow-none",
      "drop-shadow-none",
      "dark:bg-sidebar-accent",
      "dark:text-sidebar-accent-foreground",
    );
    expect(
      screen.queryByText("I’m here to answer any questions you might have."),
    ).not.toBeInTheDocument();
  });

  it("keeps Berdy's label visible with the home pin label preference", () => {
    setHomePinLabelsAlwaysVisible(true);

    render(<OnboardingTourWidget {...baseProps} />);

    const label = screen.getByTestId("onboarding-tour-hover-label");
    expect(label).toHaveTextContent("Berdy");
    expect(label).toHaveClass("opacity-100");
    expect(label).not.toHaveClass("opacity-0", "group-hover:opacity-100");
  });

  it("opens the tour and retires the welcome tooltip", async () => {
    const user = userEvent.setup();
    const onStartOnboardingTour = vi.fn();
    const onRemoveWidget = vi.fn();
    const onUpdateState = vi.fn();

    render(
      <OnboardingTourWidget
        {...baseProps}
        onUpdateState={onUpdateState}
        onStartOnboardingTour={onStartOnboardingTour}
        onRemoveWidget={onRemoveWidget}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Take a tour" }));

    expect(onStartOnboardingTour).toHaveBeenCalledOnce();
    expect(onUpdateState).not.toHaveBeenCalled();
    expect(onRemoveWidget).not.toHaveBeenCalled();
    expect(screen.getByText("Welcome!")).toBeInTheDocument();

    const completeTour = onStartOnboardingTour.mock.calls[0]?.[0];
    act(() => completeTour?.());
    expect(onUpdateState).toHaveBeenCalledWith({ welcomeDismissed: true });
  });

  it("tags Berdy in the composer after the welcome callout", async () => {
    const user = userEvent.setup();
    const onTagAgentInComposer = vi.fn();

    render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
        onTagAgentInComposer={onTagAgentInComposer}
      />,
    );

    expect(screen.queryByText("Welcome!")).not.toBeInTheDocument();
    expect(screen.getByTestId("animated-berdy")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ask Berdy" }));

    expect(onTagAgentInComposer).toHaveBeenCalledOnce();
    expect(onTagAgentInComposer).toHaveBeenCalledWith(
      expect.stringContaining("berdy.md"),
    );
    expect(screen.queryByText("How can I help?")).not.toBeInTheDocument();
  });

  it("does not rerender the avatar as its drag position changes", () => {
    const { rerender } = render(
      <OnboardingTourWidget
        {...baseProps}
        canvasDragPosition={{ x: 0, y: 0 }}
      />,
    );
    expect(avatarMediaRenderMock).toHaveBeenCalledOnce();

    rerender(
      <OnboardingTourWidget
        {...baseProps}
        canvasDragPosition={{ x: 20, y: 12 }}
      />,
    );
    rerender(
      <OnboardingTourWidget
        {...baseProps}
        canvasDragPosition={{ x: 36, y: 18 }}
      />,
    );

    expect(avatarMediaRenderMock).toHaveBeenCalledOnce();
  });

  it("keeps Berdy disabled while personas are loading", () => {
    useAgentStore.setState({ personas: [], personasLoading: true });
    const { rerender } = render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Ask Berdy" })).toBeDisabled();

    act(() => {
      useAgentStore.setState({
        personasLoading: false,
        personas: [
          {
            id: "/Users/test/.agents/agents/berdy.md",
            displayName: "Berdy",
            avatar: "app-avatar:gloopies-22",
            systemPrompt: "Help people use Berd.",
            isBuiltin: false,
            writable: true,
            sourceProperties: {
              metadata: {
                berdBundled: true,
              },
            },
          },
        ],
      });
    });
    rerender(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Ask Berdy" })).toBeEnabled();
  });

  it("repairs a missing Berdy persona before tagging it", async () => {
    const user = userEvent.setup();
    const onResolveBerdyAgent = vi.fn().mockResolvedValue("repaired-berdy");
    const onTagAgentInComposer = vi.fn();
    useAgentStore.setState({ personas: [], personasLoading: false });

    render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
        onResolveBerdyAgent={onResolveBerdyAgent}
        onTagAgentInComposer={onTagAgentInComposer}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Ask Berdy" }));

    expect(onResolveBerdyAgent).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(onTagAgentInComposer).toHaveBeenCalledWith("repaired-berdy");
    });
  });

  it("ignores a completed Berdy repair after unmount", async () => {
    let resolveBerdy!: (personaId: string | null) => void;
    const onResolveBerdyAgent = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveBerdy = resolve;
        }),
    );
    const onTagAgentInComposer = vi.fn();
    useAgentStore.setState({ personas: [], personasLoading: false });

    const { unmount } = render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
        onResolveBerdyAgent={onResolveBerdyAgent}
        onTagAgentInComposer={onTagAgentInComposer}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Ask Berdy" }));
    unmount();
    await act(async () => resolveBerdy("late-berdy"));

    expect(onTagAgentInComposer).not.toHaveBeenCalled();
  });

  it("ignores a completed Berdy repair after onboarding resets", async () => {
    let resolveBerdy!: (personaId: string | null) => void;
    const onResolveBerdyAgent = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveBerdy = resolve;
        }),
    );
    const onTagAgentInComposer = vi.fn();
    useAgentStore.setState({ personas: [], personasLoading: false });

    const { rerender } = render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
        onResolveBerdyAgent={onResolveBerdyAgent}
        onTagAgentInComposer={onTagAgentInComposer}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Ask Berdy" }));
    rerender(<OnboardingTourWidget {...baseProps} />);
    await act(async () => resolveBerdy("late-berdy"));

    expect(onTagAgentInComposer).not.toHaveBeenCalled();
    expect(screen.getByText("Welcome!")).toBeInTheDocument();
  });

  it("contains a rejected Berdy repair and enables retry", async () => {
    const user = userEvent.setup();
    const onResolveBerdyAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("repair unavailable"))
      .mockResolvedValueOnce("repaired-berdy");
    const onTagAgentInComposer = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    useAgentStore.setState({ personas: [], personasLoading: false });

    render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
        onResolveBerdyAgent={onResolveBerdyAgent}
        onTagAgentInComposer={onTagAgentInComposer}
      />,
    );

    const berdyButton = screen.getByRole("button", { name: "Ask Berdy" });
    await user.click(berdyButton);
    await waitFor(() => expect(berdyButton).toBeEnabled());
    expect(onTagAgentInComposer).not.toHaveBeenCalled();

    await user.click(berdyButton);
    await waitFor(() => {
      expect(onTagAgentInComposer).toHaveBeenCalledWith("repaired-berdy");
    });
    consoleError.mockRestore();
  });

  it("disables Berdy when neither a persona nor resolver is available", () => {
    useAgentStore.setState({ personas: [], personasLoading: false });

    render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Ask Berdy" })).toBeDisabled();
  });

  it("dismisses only the welcome tooltip from its close control", async () => {
    const user = userEvent.setup();
    const onRemoveWidget = vi.fn();
    const onUpdateState = vi.fn();

    const { rerender } = render(
      <OnboardingTourWidget
        {...baseProps}
        onRemoveWidget={onRemoveWidget}
        onUpdateState={onUpdateState}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Dismiss onboarding" }),
    );

    expect(onUpdateState).toHaveBeenCalledWith({ welcomeDismissed: true });
    expect(onRemoveWidget).not.toHaveBeenCalled();
    rerender(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
        onRemoveWidget={onRemoveWidget}
        onUpdateState={onUpdateState}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Welcome!")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("animated-berdy")).toBeInTheDocument();
  });
});
