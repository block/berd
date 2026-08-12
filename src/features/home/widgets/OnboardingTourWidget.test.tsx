import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setHomePinLabelsAlwaysVisible } from "@/features/home/lib/homePinLabelPreference";
import type { WidgetRenderProps } from "./types";
import { OnboardingTourWidget } from "./OnboardingTourWidget";

vi.mock("@/shared/hooks/useArtifacts", () => ({
  useArtifacts: () => ({ data: null }),
}));

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarMedia: () => ({
    src: "asset://localhost/gloopies-14.webm",
    mediaType: "video",
  }),
}));

vi.mock("@/shared/ui/avatar-media", () => ({
  AvatarMedia: ({
    alt,
    loadingStrategy,
    playbackMode,
  }: {
    alt: string;
    loadingStrategy: string;
    playbackMode: string;
  }) => (
    <div
      role="img"
      aria-label={alt}
      data-testid="animated-berdy"
      data-loading-strategy={loadingStrategy}
      data-playback-mode={playbackMode}
    />
  ),
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
  });

  it("uses 14px type and grows a gloopy bubble from the avatar", () => {
    render(<OnboardingTourWidget {...baseProps} />);

    expect(screen.getByTestId("animated-berdy")).toHaveAttribute(
      "data-loading-strategy",
      "lazy-once",
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
      .getByText("Welcome to Berd!")
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
      bubble?.querySelector('[data-onboarding-tour-connector-fillet="top"]'),
    ).toHaveClass("rounded-full");
    expect(
      bubble?.querySelector('[data-onboarding-tour-connector-fillet="bottom"]'),
    ).toHaveClass("rounded-full");
    expect(
      bubble?.querySelector(".onboarding-tour-bubble-content"),
    ).not.toHaveClass(
      "drop-shadow-[0_12px_18px_rgba(0,0,0,0.14)]",
      "dark:drop-shadow-[0_12px_18px_rgba(0,0,0,0.32)]",
    );
    expect(screen.getByText("Welcome to Berd!")).toHaveClass("pr-5");
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

  it("opens the tour without dismissing the welcome tooltip", async () => {
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
    expect(screen.getByText("Welcome to Berd!")).toBeInTheDocument();
  });

  it("keeps Berdy and offers suggested questions after the welcome callout", async () => {
    const user = userEvent.setup();
    const onStartChatWithPrompt = vi.fn();

    render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
        onStartChatWithPrompt={onStartChatWithPrompt}
      />,
    );

    expect(screen.queryByText("Welcome to Berd!")).not.toBeInTheDocument();
    expect(screen.getByTestId("animated-berdy")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ask Berdy" }));
    expect(screen.getByText("How can I help?")).toBeInTheDocument();
    const firstSuggestion = screen.getByRole("button", {
      name: /What can I use Berd for/,
    });
    expect(firstSuggestion).toHaveClass(
      "group",
      "w-full",
      "bg-transparent",
      "px-0",
      "py-1.5",
    );
    expect(firstSuggestion).not.toHaveClass("rounded-[10px]", "bg-muted/50");
    expect(firstSuggestion.querySelector("span")).toHaveClass(
      "group-hover:font-medium",
      "group-focus-visible:font-medium",
      "motion-reduce:transition-none",
    );
    expect(firstSuggestion.querySelector("svg")).toHaveClass(
      "size-3",
      "opacity-0",
      "transition-opacity",
      "duration-150",
      "ease-out",
      "group-hover:opacity-100",
      "group-focus-visible:opacity-100",
      "motion-reduce:transition-none",
    );
    expect(
      screen.getByRole("button", { name: "Close help" }).parentElement,
    ).toHaveClass("right-3");
    expect(
      screen.getByRole("button", { name: /How do I start a project/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /How do agents and skills work/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /How do I start a project/ }),
    );

    expect(onStartChatWithPrompt).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("status", { name: "Berdy is typing" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("How can I help?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toHaveAttribute(
      "data-onboarding-tour-back",
    );
    expect(screen.getByRole("button", { name: "Back" })).toHaveClass(
      "font-medium",
      "leading-5",
    );
    await waitFor(() => {
      expect(
        screen.queryByText("How do I start a project?"),
      ).not.toBeInTheDocument();
    });
    expect(
      await screen.findByText(
        "Projects keep related chats, files, and working folders together so agents have the right context.",
        {},
        { timeout: 2_000 },
      ),
    ).toBeInTheDocument();

    const followUpInput = screen.getByRole("textbox", {
      name: "Ask a follow-up",
    });
    expect(followUpInput.closest("[data-slot='input-group']")).toHaveClass(
      "border-transparent",
      "bg-muted/40",
      "shadow-none",
      "focus-within:!border-transparent",
      "dark:bg-muted/40",
    );
    expect(
      followUpInput.closest("[data-onboarding-tour-response]"),
    ).not.toHaveClass("mr-3");
    await user.type(followUpInput, "Can you give me an example?");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(onStartChatWithPrompt).toHaveBeenCalledWith(
      "How do I start a project?\n\nFollow-up: Can you give me an example?",
    );
    await waitFor(() => {
      expect(screen.queryByText("How can I help?")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("animated-berdy")).toBeInTheDocument();
  });

  it("reveals the composer when the user wants to ask something else", async () => {
    const user = userEvent.setup();
    const onStartChatWithPrompt = vi.fn();

    render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
        onStartChatWithPrompt={onStartChatWithPrompt}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Ask Berdy" }));
    await user.click(
      screen.getByRole("button", { name: "Ask something else" }),
    );

    const input = await screen.findByRole("textbox", {
      name: "Ask Berdy anything",
    });
    const inputGroup = input.closest("[data-slot='input-group']");
    const sendButton = screen.getByRole("button", { name: "Send message" });
    expect(inputGroup).toHaveClass(
      "border-transparent",
      "bg-muted/40",
      "shadow-none",
      "focus-within:!border-transparent",
      "dark:bg-muted/40",
    );
    expect(sendButton.closest("[data-align='inline-end']")).toHaveClass(
      "ml-auto",
    );
    expect(sendButton.querySelector("svg")).toHaveClass("size-4");
    expect(screen.getByRole("button", { name: "Back" })).toHaveAttribute(
      "data-onboarding-tour-back",
    );
    expect(screen.getByRole("button", { name: "Back" })).toHaveClass(
      "font-medium",
      "leading-5",
    );
    expect(
      screen.getByRole("button", { name: "Back" }).querySelector("svg"),
    ).toHaveClass("lucide-chevron-left");
    await user.type(input, "How do I create a project?");
    await user.click(sendButton);

    expect(onStartChatWithPrompt).toHaveBeenCalledWith(
      "How do I create a project?",
    );
    await waitFor(() => {
      expect(screen.queryByText("How can I help?")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("animated-berdy")).toBeInTheDocument();
  });

  it("keeps the question open when the Berdy chat cannot start", async () => {
    const user = userEvent.setup();
    const onStartChatWithPrompt = vi.fn(async () => false);

    render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
        onStartChatWithPrompt={onStartChatWithPrompt}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Ask Berdy" }));
    await user.click(
      screen.getByRole("button", { name: "Ask something else" }),
    );
    const input = await screen.findByRole("textbox", {
      name: "Ask Berdy anything",
    });
    await user.type(input, "How do I create a project?");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onStartChatWithPrompt).toHaveBeenCalledOnce();
    expect(input).toHaveValue("How do I create a project?");
    expect(screen.getByText("Back")).toBeInTheDocument();
  });

  it("starts only one chat while a Berdy prompt is pending", async () => {
    const user = userEvent.setup();
    let resolveStart!: (didStart: boolean) => void;
    const onStartChatWithPrompt = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveStart = resolve;
        }),
    );

    render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
        onStartChatWithPrompt={onStartChatWithPrompt}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Ask Berdy" }));
    await user.click(
      screen.getByRole("button", { name: "Ask something else" }),
    );
    const input = await screen.findByRole("textbox", {
      name: "Ask Berdy anything",
    });
    await user.type(input, "How do I create a project?");
    const sendButton = screen.getByRole("button", { name: "Send message" });

    await user.click(sendButton);
    expect(sendButton).toBeDisabled();
    await user.click(sendButton);
    expect(onStartChatWithPrompt).toHaveBeenCalledOnce();

    resolveStart(true);
    await waitFor(() => {
      expect(screen.queryByText("How can I help?")).not.toBeInTheDocument();
    });
  });

  it("collapses the help composer without removing Berdy", async () => {
    const user = userEvent.setup();
    const onRemoveWidget = vi.fn();

    render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
        onRemoveWidget={onRemoveWidget}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Ask Berdy" }));
    await user.click(screen.getByRole("button", { name: "Close help" }));

    await waitFor(() => {
      expect(screen.queryByText("How can I help?")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("animated-berdy")).toBeInTheDocument();
    expect(onRemoveWidget).not.toHaveBeenCalled();
  });

  it("toggles the help bubble when Berdy is clicked again", async () => {
    const user = userEvent.setup();
    const onRemoveWidget = vi.fn();

    render(
      <OnboardingTourWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { welcomeDismissed: true },
        }}
        onRemoveWidget={onRemoveWidget}
      />,
    );

    const berdy = screen.getByRole("button", { name: "Ask Berdy" });
    await user.click(berdy);
    expect(screen.getByText("How can I help?")).toBeInTheDocument();

    await user.click(berdy);
    await waitFor(() => {
      expect(screen.queryByText("How can I help?")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("animated-berdy")).toBeInTheDocument();
    expect(onRemoveWidget).not.toHaveBeenCalled();
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
      expect(screen.queryByText("Welcome to Berd!")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("animated-berdy")).toBeInTheDocument();
  });
});
