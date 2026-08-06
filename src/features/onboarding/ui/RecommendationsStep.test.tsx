import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecommendationsStep } from "./RecommendationsStep";
import type { RecommendedAgent } from "../model";

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
  id: "builder",
  canonicalName: "Builder",
  canonicalPromptDescription: "Builds things.",
  avatar: "app-avatar:gloopies-01",
  workTypeIds: ["engineering"],
};

describe("RecommendationsStep", () => {
  beforeEach(() => {
    avatarReady = undefined;
  });

  it("reveals stacked-alpha avatar media through its shared readiness callback", () => {
    render(
      <RecommendationsStep
        agents={[agent]}
        onBack={() => {}}
        onKeep={async () => {}}
        onSkip={() => {}}
      />,
    );

    const media = screen.getByTestId("avatar-media");
    expect(media).toHaveClass("opacity-0");
    if (!avatarReady) throw new Error("Avatar readiness callback missing");

    act(() => avatarReady?.());

    expect(media).toHaveClass("opacity-100");
    expect(media).not.toHaveClass("opacity-0");
  });
});
