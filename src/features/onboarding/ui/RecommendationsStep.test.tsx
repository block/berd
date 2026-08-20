import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecommendationsStep } from "./RecommendationsStep";
import type { OnboardingRuntimeState, RecommendedAgent } from "../model";

let avatarReady: (() => void) | undefined;

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarImage: () => undefined,
  useAvatarMedia: () => ({
    src: "asset://localhost/avatar.webm",
    mediaType: "video",
    alphaMode: "stacked",
  }),
}));

vi.mock("@/shared/ui/avatar-media", () => ({
  AvatarMedia: ({
    className,
    onReady,
  }: {
    className?: string;
    onReady?: () => void;
  }) => {
    avatarReady = onReady;
    return <canvas data-testid="avatar-media" className={className} />;
  },
}));

const agent: RecommendedAgent = {
  id: "test-agent",
  canonicalName: "Test Agent",
  canonicalPromptDescription: "Builds things.",
  avatar: "app-avatar:test-fixture",
  workTypeIds: ["engineering"],
};

const readyRuntime: OnboardingRuntimeState = {
  ready: true,
  failed: false,
  retry: () => {},
};

function renderStep(
  overrides: {
    runtime?: OnboardingRuntimeState;
    onKeep?: () => Promise<void>;
    onSkip?: () => void;
  } = {},
) {
  return render(
    <RecommendationsStep
      agents={[agent]}
      runtime={overrides.runtime ?? readyRuntime}
      onBack={() => {}}
      onKeep={overrides.onKeep ?? (async () => {})}
      onSkip={overrides.onSkip ?? (() => {})}
    />,
  );
}

describe("RecommendationsStep", () => {
  beforeEach(() => {
    avatarReady = undefined;
  });

  it("reveals stacked-alpha avatar media through its shared readiness callback", () => {
    renderStep();

    const media = screen.getByTestId("avatar-media");
    expect(media).toHaveClass("opacity-0");
    if (!avatarReady) throw new Error("Avatar readiness callback missing");

    act(() => avatarReady?.());

    expect(media).toHaveClass("opacity-100");
    expect(media).not.toHaveClass("opacity-0");
  });

  // The step renders before app startup settles, so adoption — the one ACP call
  // in onboarding — has to wait for the runtime instead of hanging on it.
  it("holds Keep in a pending state while the runtime is still starting", async () => {
    const onKeep = vi.fn(async () => {});
    renderStep({
      runtime: { ready: false, failed: false, retry: () => {} },
      onKeep,
    });

    const keep = screen.getByRole("button", { name: "Getting ready…" });
    expect(keep).toBeDisabled();
    await userEvent.click(keep);
    expect(onKeep).not.toHaveBeenCalled();

    // Skipping needs no runtime, so it stays available throughout.
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
  });

  it("offers a runtime retry instead of Keep when startup failed", async () => {
    const retry = vi.fn();
    const onKeep = vi.fn(async () => {});
    renderStep({ runtime: { ready: false, failed: true, retry }, onKeep });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Berd couldn’t finish starting, so agents can’t be added yet.",
    );
    expect(screen.queryByRole("button", { name: "Keep ’em" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(retry).toHaveBeenCalledOnce();
    expect(onKeep).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
  });

  it("adopts agents once the runtime is ready", async () => {
    const onKeep = vi.fn(async () => {});
    renderStep({ onKeep });

    await userEvent.click(screen.getByRole("button", { name: "Keep ’em" }));

    expect(onKeep).toHaveBeenCalledOnce();
  });
});
