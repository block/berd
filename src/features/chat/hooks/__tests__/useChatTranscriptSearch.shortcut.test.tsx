import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useChatTranscriptSearch } from "../useChatTranscriptSearch";

// Deterministic find modifier across dev machines and CI: "mod" resolves
// to Meta on mac.
vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => "mac",
}));

function Harness() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const search = useChatTranscriptSearch(rootRef);
  return (
    <div>
      <output data-testid="search-state">
        {search.isOpen ? "open" : "closed"}
      </output>
      <div ref={rootRef} />
    </div>
  );
}

describe("useChatTranscriptSearch find shortcut", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("opens on the default Mod+F binding", () => {
    render(<Harness />);

    const prevented = !fireEvent.keyDown(window, { key: "f", metaKey: true });

    expect(prevented).toBe(true);
    expect(screen.getByTestId("search-state")).toHaveTextContent("open");
  });

  it("passes the non-primary modifier through (macOS Ctrl+F caret-forward)", () => {
    render(<Harness />);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    expect(screen.getByTestId("search-state")).toHaveTextContent("closed");
  });

  it("honors a user override and releases the default combo", () => {
    localStorage.setItem(
      "goose:keyboard-shortcuts:v1",
      JSON.stringify({
        version: 1,
        overrides: { "chat.findInConversation": "meta+shift+f" },
      }),
    );
    render(<Harness />);

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(screen.getByTestId("search-state")).toHaveTextContent("closed");

    fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
    expect(screen.getByTestId("search-state")).toHaveTextContent("open");
  });
});
