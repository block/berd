import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { toast } from "sonner";
import { openPath } from "@tauri-apps/plugin-opener";
import { downloadDir } from "@tauri-apps/api/path";

import {
  detectStreamdownMermaidDownloadFormat,
  MessageResponse,
} from "./message";

const streamdownMocks = vi.hoisted(() => ({
  latestProps: undefined as Record<string, unknown> | undefined,
  renderCount: 0,
}));

vi.mock("streamdown", () => ({
  defaultRehypePlugins: {
    raw: vi.fn(),
    sanitize: vi.fn(),
    harden: vi.fn(),
  },
  Streamdown: (props: Record<string, unknown>) => {
    streamdownMocks.latestProps = props;
    streamdownMocks.renderCount += 1;

    return (
      <div data-testid="streamdown">
        <div data-streamdown="mermaid-block-actions">
          <button type="button" title="Download diagram">
            download trigger
          </button>
          <button
            data-streamdown="code-block-copy-button"
            type="button"
            title="Copy Code"
          >
            copy
          </button>
          <button type="button" title="Download diagram as SVG">
            SVG
          </button>
          <button type="button" title="Download diagram as PNG">
            PNG
          </button>
          <button type="button" title="Download diagram as MMD">
            MMD
          </button>
        </div>
      </div>
    );
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: vi.fn().mockResolvedValue("/Users/test/Downloads"),
}));

function mermaidButton(label: string): HTMLButtonElement {
  const actions = document.createElement("div");
  actions.setAttribute("data-streamdown", "mermaid-block-actions");
  const button = document.createElement("button");
  button.type = "button";
  button.title = `Download diagram as ${label}`;
  button.textContent = label;
  actions.appendChild(button);
  document.body.appendChild(actions);
  return button;
}

describe("detectStreamdownMermaidDownloadFormat", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["SVG", "svg"],
    ["PNG", "png"],
    ["MMD", "mmd"],
  ] as const)("detects %s menu item clicks", (label, expected) => {
    expect(detectStreamdownMermaidDownloadFormat(mermaidButton(label))).toBe(
      expected,
    );
  });

  it("ignores the main download trigger", () => {
    const actions = document.createElement("div");
    actions.setAttribute("data-streamdown", "mermaid-block-actions");
    const button = document.createElement("button");
    button.type = "button";
    button.title = "Download diagram";
    actions.appendChild(button);
    document.body.appendChild(actions);

    expect(detectStreamdownMermaidDownloadFormat(button)).toBeNull();
  });

  it("ignores non-mermaid clicks", () => {
    const button = document.createElement("button");
    button.type = "button";
    button.title = "Download diagram as PNG";
    document.body.appendChild(button);

    expect(detectStreamdownMermaidDownloadFormat(button)).toBeNull();
  });
});

describe("MessageResponse mermaid controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamdownMocks.latestProps = undefined;
    delete window.__TAURI_INTERNALS__;
  });

  it("does not override Streamdown mermaid controls", () => {
    render(<MessageResponse>{"```mermaid\ngraph TD"}</MessageResponse>);

    expect(streamdownMocks.latestProps).not.toHaveProperty("controls");
  });

  it("shows a neutral download-started toast for mermaid export clicks", () => {
    render(<MessageResponse>{"```mermaid\ngraph TD"}</MessageResponse>);

    fireEvent.click(screen.getByRole("button", { name: "PNG" }));

    expect(toast.message).toHaveBeenCalledWith(
      "Download started: diagram.png",
      {},
    );
  });

  it("adds an Open Downloads action in Tauri", async () => {
    window.__TAURI_INTERNALS__ = {};
    render(<MessageResponse>{"```mermaid\ngraph TD"}</MessageResponse>);

    fireEvent.click(screen.getByRole("button", { name: "SVG" }));

    const options = vi.mocked(toast.message).mock.calls.at(-1)?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined;
    options?.action?.onClick?.();

    await waitFor(() => {
      expect(downloadDir).toHaveBeenCalled();
      expect(openPath).toHaveBeenCalledWith("/Users/test/Downloads");
    });
  });
});

describe("MessageResponse voice delivery label", () => {
  it("updates the accessible label when only the locale copy changes", () => {
    streamdownMocks.renderCount = 0;
    const { rerender } = render(
      <MessageResponse strikethroughFrom={6} strikethroughLabel="Not spoken">
        Heard. Unheard.
      </MessageResponse>,
    );
    const firstRenderCount = streamdownMocks.renderCount;

    rerender(
      <MessageResponse strikethroughFrom={6} strikethroughLabel="No hablado">
        Heard. Unheard.
      </MessageResponse>,
    );

    expect(streamdownMocks.renderCount).toBeGreaterThan(firstRenderCount);
    const plugins = streamdownMocks.latestProps?.rehypePlugins as unknown[][];
    expect(plugins.at(-1)?.[2]).toBe("No hablado");
  });
});
