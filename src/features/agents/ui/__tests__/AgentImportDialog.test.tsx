import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentImportDialog } from "../AgentImportDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return { ...actual, useReducedMotion: () => false };
});

describe("AgentImportDialog", () => {
  it("tilts the rendered import card toward the pointer and resets", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
    } as MediaQueryList);
    const fileBytes = Uint8Array.from([1, 2, 3]);
    const file = new File([fileBytes], "agent.agent.png", {
      type: "image/png",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(fileBytes.buffer),
    });
    render(
      <AgentImportDialog
        open
        onOpenChange={vi.fn()}
        onImportFile={vi.fn()}
        prepareImport={() => ({
          displayName: "Reviewer",
          systemPrompt: "Review carefully.",
          identity: "agent.agent.png",
          cardImageUrl: "blob:card",
          cardAspectRatio: 1 / 8192,
        })}
        validateImportFile={() => null}
        onImportError={vi.fn()}
        maxImportBytes={1024}
        importTooLargeMessage="Too large"
      />,
    );
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    const image = await screen.findByRole("img", {
      name: "importDialog.previewAlt",
    });
    const tiltSurface = image.closest<HTMLDivElement>(
      '[data-agent-card-surface="true"]',
    ) as HTMLDivElement;
    const reveal = tiltSurface.closest<HTMLDivElement>(
      '[data-agent-card-reveal="true"]',
    );
    const revealContent = reveal?.querySelector<HTMLDivElement>(
      '[data-agent-card-reveal-content="true"]',
    );
    expect(revealContent?.className).toContain("z-10");
    expect(tiltSurface.style.aspectRatio).toBe("");
    expect(image).toHaveClass("object-contain");
    expect(
      tiltSurface.querySelector('canvas[data-agent-card-frame-only="true"]'),
    ).not.toBeNull();
    vi.spyOn(tiltSurface, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 200,
    } as DOMRect);

    const move = createEvent.pointerMove(tiltSurface);
    Object.defineProperties(move, {
      clientX: { value: 100 },
      clientY: { value: 0 },
    });
    fireEvent(tiltSurface, move);
    await waitFor(() =>
      expect(tiltSurface.style.transform).toBe("rotateX(8deg) rotateY(8deg)"),
    );

    fireEvent.pointerLeave(tiltSurface);
    expect(tiltSurface.style.transform).toBe("none");
  });
});
