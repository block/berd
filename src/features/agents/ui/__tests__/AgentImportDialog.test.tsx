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

function importDialogProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    onImportFile: vi.fn(),
    prepareImport: () => ({
      displayName: "Reviewer",
      systemPrompt: "Review carefully.",
      identity: "agent.agent.png",
    }),
    validateImportFile: () => null,
    onImportError: vi.fn(),
    maxImportBytes: 1024,
    importTooLargeMessage: "Too large",
    ...overrides,
  };
}

describe("AgentImportDialog", () => {
  it("clears a prepared import when a replacement file is rejected", async () => {
    const firstBytes = Uint8Array.from([1, 2, 3]);
    const firstFile = new File([firstBytes], "agent.agent.png", {
      type: "image/png",
    });
    Object.defineProperty(firstFile, "arrayBuffer", {
      configurable: true,
      value: vi.fn().mockResolvedValue(firstBytes.buffer),
    });
    const rejectedFile = new File([new Uint8Array([9])], "broken.zip", {
      type: "application/zip",
    });
    const onImportError = vi.fn();
    render(
      <AgentImportDialog
        {...importDialogProps({
          validateImportFile: (file: File) =>
            file.name === "broken.zip" ? "Invalid ZIP" : null,
          onImportError,
        })}
      />,
    );
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [firstFile] },
    });
    expect(
      await screen.findByRole("button", { name: "importDialog.import" }),
    ).toBeInTheDocument();

    fireEvent.change(input as HTMLInputElement, {
      target: { files: [rejectedFile] },
    });

    expect(onImportError).toHaveBeenCalledWith("Invalid ZIP");
    expect(
      screen.queryByRole("button", { name: "importDialog.import" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Reviewer")).not.toBeInTheDocument();
  });

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
