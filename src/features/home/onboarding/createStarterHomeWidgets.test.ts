import { describe, expect, it, vi } from "vitest";
import type { Persona } from "@/shared/types/agents";
import { createStarterHomeWidgets } from "./createStarterHomeWidgets";

function starterPersona(fileName: "tinker.md" | "wildcard.md"): Persona {
  return {
    id: `/Users/test/.agents/agents/${fileName}`,
    displayName: fileName === "tinker.md" ? "Tinker" : "Wildcard",
    systemPrompt: "Help.",
    isBuiltin: false,
    writable: true,
    sourceProperties: {
      metadata: { berdBundled: true, berdBundledSource: fileName.slice(0, -3) },
    },
  };
}

describe("createStarterHomeWidgets", () => {
  it("builds the usable base Home when starter agents are unavailable", () => {
    const widgets = createStarterHomeWidgets([]);

    expect(widgets.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "clock",
        "onboardingTour",
        "onboardingProjectArtifact",
        "stickyNote",
      ]),
    );
    expect(widgets.some(({ type }) => type === "agentPin")).toBe(false);
  });

  it.each([
    ["tinker.md", 410, 191],
    ["wildcard.md", 214, -369],
  ] as const)("keeps %s in its stable slot when it is the only available agent", (fileName, x, y) => {
    const widgets = createStarterHomeWidgets([starterPersona(fileName)]);

    expect(widgets.find((widget) => widget.type === "agentPin")).toMatchObject({
      x,
      y,
      state: { agentId: `/Users/test/.agents/agents/${fileName}` },
    });
  });

  it("contains exactly the visible starter Home widgets", () => {
    const widgets = createStarterHomeWidgets([
      starterPersona("tinker.md"),
      starterPersona("wildcard.md"),
    ]);

    expect(widgets).toHaveLength(6);
    expect(widgets.map(({ type }) => type)).toEqual([
      "clock",
      "onboardingTour",
      "onboardingProjectArtifact",
      "stickyNote",
      "agentPin",
      "agentPin",
    ]);
    expect(
      widgets
        .filter((widget) => widget.type === "stickyNote")
        .map((widget) => widget.state?.noteId),
    ).toEqual(["onboarding:starter-tasks"]);
  });

  it("derives the complete canonical starter composition", () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000003")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000004")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000005")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000006")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000007")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000008")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000009")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000010")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000011");

    const widgets = createStarterHomeWidgets([
      starterPersona("wildcard.md"),
      starterPersona("tinker.md"),
    ]);

    expect(widgets).not.toBeNull();
    expect(widgets?.find((widget) => widget.type === "clock")).toMatchObject({
      x: 522,
      y: -274,
      width: 156,
      height: 156,
    });
    expect(
      widgets
        ?.filter((widget) => widget.type === "agentPin")
        .map((widget) => ({ ...widget.state, x: widget.x, y: widget.y })),
    ).toEqual([
      {
        agentId: "/Users/test/.agents/agents/tinker.md",
        x: 410,
        y: 191,
      },
      {
        agentId: "/Users/test/.agents/agents/wildcard.md",
        x: 214,
        y: -369,
      },
    ]);
  });
});
