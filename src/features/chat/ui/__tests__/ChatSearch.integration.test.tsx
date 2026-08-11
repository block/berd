import { useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { MessageTimeline } from "../MessageTimeline";
import { ChatSearchBar } from "../ChatSearchBar";
import { useChatTranscriptSearch } from "@/features/chat/hooks/useChatTranscriptSearch";
import type {
  TranscriptSearchBackend,
  TranscriptSearchSnapshot,
} from "@/features/chat/lib/transcriptSearchBackend";
import type { Message } from "@/shared/types/messages";
import {
  type MockHighlight,
  stubHighlightRegistry,
} from "@/test/highlightRegistryStub";

vi.mock("@/shared/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => children,
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
}));

let registry: Map<string, MockHighlight>;
const scrollIntoViewMock = vi.fn();

beforeEach(() => {
  registry = stubHighlightRegistry();
  // jsdom has no scrollIntoView; stub it to assert the scroll-on-user-intent
  // invariant.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoViewMock,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  scrollIntoViewMock.mockClear();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function message(
  id: string,
  role: Message["role"],
  text: string,
  created = Date.UTC(2026, 5, 1),
): Message {
  return {
    id,
    role,
    created,
    content: [{ type: "text", text }],
  };
}

function SearchHarness({ messages }: { messages: Message[] }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const search = useChatTranscriptSearch(rootRef);

  return (
    <div>
      <button type="button" onClick={search.open}>
        open search
      </button>
      {search.isOpen ? (
        <ChatSearchBar
          query={search.query}
          totalMatches={search.matchCount}
          activeMatchIndex={search.activeMatchIndex}
          isIndexing={search.isIndexing}
          announcedTotalMatches={search.announcedMatchCount}
          announcedActiveMatchIndex={search.announcedActiveMatchIndex}
          announcedIsIndexing={search.announcedIsIndexing}
          focusSignal={search.focusSignal}
          onQueryChange={search.setQuery}
          onNext={search.goToNext}
          onPrevious={search.goToPrevious}
          onClose={search.close}
        />
      ) : null}
      <MessageTimeline messages={messages} searchContentRef={rootRef} />
    </div>
  );
}

const MARKDOWN_FIXTURE = [
  message("user-1", "user", "Please find the needle here"),
  message(
    "assistant-1",
    "assistant",
    "A [needle](https://needle.example/needle) link, `needle` inline, plus **nee**dle bold.",
  ),
];

async function openSearchAndType(query: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "open search" }));
  const input = screen.getByRole("searchbox", {
    name: "Search chat messages",
  });
  await user.type(input, query);
  return { user, input };
}

describe("chat search integration", () => {
  it("counts only rendered text, including matches spanning markdown formatting", async () => {
    renderWithProviders(<SearchHarness messages={MARKDOWN_FIXTURE} />);
    // Wait for streamdown to render the markdown body.
    await screen.findByText(/bold\./);

    await openSearchAndType("needle");

    // 1 user text + link text + inline code + bold-split word. The two
    // occurrences inside the link URL are not rendered and must not count.
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("1 / 4");
    });

    const painted = registry.get("chat-search-match");
    expect(painted?.ranges).toHaveLength(4);
    expect(
      painted?.ranges.map((range) => range.toString().toLowerCase()),
    ).toEqual(["needle", "needle", "needle", "needle"]);
  });

  it("navigates with wrap-around and paints the active match", async () => {
    renderWithProviders(<SearchHarness messages={MARKDOWN_FIXTURE} />);
    await screen.findByText(/bold\./);

    const { user } = await openSearchAndType("needle");
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("1 / 4");
    });

    await user.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("2 / 4");

    await user.keyboard("{Enter}{Enter}{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("1 / 4");

    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(screen.getByRole("status")).toHaveTextContent("4 / 4");

    const active = registry.get("chat-search-match-active");
    expect(active?.ranges).toHaveLength(1);
    expect(active?.ranges[0].toString().toLowerCase()).toBe("needle");
    expect(active?.priority).toBe(1);
  });

  it("navigates with arrows and Ctrl+N/P from the input", async () => {
    renderWithProviders(<SearchHarness messages={MARKDOWN_FIXTURE} />);
    await screen.findByText(/bold\./);

    const { user } = await openSearchAndType("needle");
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("1 / 4");
    });

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("status")).toHaveTextContent("2 / 4");

    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("status")).toHaveTextContent("1 / 4");

    await user.keyboard("{Control>}n{/Control}");
    expect(screen.getByRole("status")).toHaveTextContent("2 / 4");

    await user.keyboard("{Control>}p{/Control}");
    expect(screen.getByRole("status")).toHaveTextContent("1 / 4");
  });

  it("shows the no-results state without enabling navigation", async () => {
    renderWithProviders(<SearchHarness messages={MARKDOWN_FIXTURE} />);
    await screen.findByText(/bold\./);

    await openSearchAndType("zzzznope");

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("No results");
    });
    expect(screen.getByRole("button", { name: "Next result" })).toBeDisabled();
    expect(registry.get("chat-search-match")?.ranges ?? []).toHaveLength(0);
    expect(registry.get("chat-search-match-active")?.ranges ?? []).toHaveLength(
      0,
    );
  });

  it("re-matches on transcript changes, preserving the active index without announcing", async () => {
    const { rerender } = renderWithProviders(
      <SearchHarness messages={MARKDOWN_FIXTURE} />,
    );
    await screen.findByText(/bold\./);

    const { user } = await openSearchAndType("needle");
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("1 / 4");
    });
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("2 / 4");

    rerender(
      <SearchHarness
        messages={[
          ...MARKDOWN_FIXTURE,
          message("assistant-2", "assistant", "another needle arrives"),
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-search-match-count")).toHaveTextContent(
        "2 / 5",
      );
    });
    expect(registry.get("chat-search-match")?.ranges).toHaveLength(5);
    // Streaming recounts must not spam the screen-reader live region.
    expect(screen.getByRole("status")).toHaveTextContent("2 / 4");
  });

  it("scrolls only on user intent, never on streaming recomputes", async () => {
    const { rerender } = renderWithProviders(
      <SearchHarness messages={MARKDOWN_FIXTURE} />,
    );
    await screen.findByText(/bold\./);

    const { user } = await openSearchAndType("needle");
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("1 / 4");
    });
    // Query settling reveals the first match once.
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({
      block: "center",
      behavior: "auto",
    });

    rerender(
      <SearchHarness
        messages={[
          ...MARKDOWN_FIXTURE,
          message("assistant-2", "assistant", "another needle arrives"),
        ]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("chat-search-match-count")).toHaveTextContent(
        "1 / 5",
      );
    });
    // The mutation recompute must not move the viewport.
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2);
    });
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({
      block: "center",
      behavior: "smooth",
    });
  });

  it("clamps the active match when the transcript shrinks below it", async () => {
    const { rerender } = renderWithProviders(
      <SearchHarness messages={MARKDOWN_FIXTURE} />,
    );
    await screen.findByText(/bold\./);

    const { user } = await openSearchAndType("needle");
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("1 / 4");
    });
    await user.keyboard("{Enter}{Enter}{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("4 / 4");

    rerender(
      <SearchHarness
        messages={[message("user-1", "user", "Please find the needle here")]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-search-match-count")).toHaveTextContent(
        "1 / 1",
      );
    });
    expect(registry.get("chat-search-match-active")?.ranges).toHaveLength(1);
  });

  it("clears the global highlight registry on unmount", async () => {
    const { unmount } = renderWithProviders(
      <SearchHarness messages={MARKDOWN_FIXTURE} />,
    );
    await screen.findByText(/bold\./);

    await openSearchAndType("needle");
    await waitFor(() => {
      expect(registry.get("chat-search-match")?.ranges).toHaveLength(4);
    });

    unmount();

    expect(registry.size).toBe(0);
  });

  it("closes on Escape, clears highlights, and restores focus", async () => {
    renderWithProviders(<SearchHarness messages={MARKDOWN_FIXTURE} />);
    await screen.findByText(/bold\./);

    const { user, input } = await openSearchAndType("needle");
    await waitFor(() => {
      expect(registry.size).toBeGreaterThan(0);
    });

    await user.keyboard("{Escape}");

    expect(input).not.toBeInTheDocument();
    expect(registry.size).toBe(0);
    expect(screen.getByRole("button", { name: "open search" })).toHaveFocus();
  });

  it("closes on Escape from the close button, not only the input", async () => {
    renderWithProviders(<SearchHarness messages={MARKDOWN_FIXTURE} />);
    await screen.findByText(/bold\./);

    const { user, input } = await openSearchAndType("needle");
    const closeButton = screen.getByRole("button", { name: "Close search" });
    closeButton.focus();

    await user.keyboard("{Escape}");

    expect(input).not.toBeInTheDocument();
  });
});

/**
 * Scriptable TranscriptSearchBackend double for the controller-delegation
 * path (the virtualized timeline fills the ref with the real one).
 */
function createFakeBackend(
  initialTotal: number,
  onQuerySnapshot?: TranscriptSearchSnapshot,
) {
  const listeners = new Set<(snapshot: TranscriptSearchSnapshot) => void>();
  let snapshot: TranscriptSearchSnapshot = {
    total: 0,
    activeOrdinal: -1,
    indexing: false,
  };

  const emit = (next: TranscriptSearchSnapshot) => {
    if (
      snapshot.total === next.total &&
      snapshot.activeOrdinal === next.activeOrdinal &&
      snapshot.indexing === next.indexing
    ) {
      return;
    }
    act(() => {
      snapshot = next;
      for (const listener of listeners) {
        listener(next);
      }
    });
  };

  const backend: TranscriptSearchBackend = {
    setQuery: vi.fn((query: string) => {
      emit(
        query
          ? (onQuerySnapshot ?? {
              total: initialTotal,
              activeOrdinal: 0,
              indexing: true,
            })
          : { total: 0, activeOrdinal: -1, indexing: false },
      );
    }),
    navigate: vi.fn((direction: 1 | -1) => {
      const next =
        (snapshot.activeOrdinal + direction + snapshot.total) % snapshot.total;
      emit({ ...snapshot, activeOrdinal: next });
    }),
    clear: vi.fn(() => {
      act(() => emit({ total: 0, activeOrdinal: -1, indexing: false }));
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };

  return { backend, emit, getSnapshot: () => snapshot };
}

function BackendHarness({ backend }: { backend: TranscriptSearchBackend }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const backendRef = useRef<TranscriptSearchBackend | null>(backend);
  const search = useChatTranscriptSearch(rootRef, { backendRef });

  return (
    <div>
      <button type="button" onClick={search.open}>
        open search
      </button>
      {search.isOpen ? (
        <ChatSearchBar
          query={search.query}
          totalMatches={search.matchCount}
          activeMatchIndex={search.activeMatchIndex}
          isIndexing={search.isIndexing}
          announcedTotalMatches={search.announcedMatchCount}
          announcedActiveMatchIndex={search.announcedActiveMatchIndex}
          announcedIsIndexing={search.announcedIsIndexing}
          focusSignal={search.focusSignal}
          onQueryChange={search.setQuery}
          onNext={search.goToNext}
          onPrevious={search.goToPrevious}
          onClose={search.close}
        />
      ) : null}
      <div data-testid="backend-raw-match-state">
        {`${search.matchCount}:${search.activeMatchIndex}:${search.isIndexing}`}
      </div>
      <div data-testid="backend-raw-announced-state">
        {`${search.announcedMatchCount}:${search.announcedActiveMatchIndex}:${search.announcedIsIndexing}`}
      </div>
      <div ref={rootRef} />
    </div>
  );
}

describe("chat search backend delegation", () => {
  it("delegates query, navigation, and close to the backend", async () => {
    const { backend } = createFakeBackend(3);
    renderWithProviders(<BackendHarness backend={backend} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "open search" }));
    const input = screen.getByRole("searchbox", {
      name: "Search chat messages",
    });
    await user.type(input, "needle");

    await waitFor(() => {
      expect(backend.setQuery).toHaveBeenCalledWith("needle");
      expect(screen.getByRole("status")).toHaveTextContent("1 / 3");
    });

    await user.keyboard("{Enter}");
    expect(backend.navigate).toHaveBeenCalledWith(1);
    expect(screen.getByRole("status")).toHaveTextContent("2 / 3");

    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(backend.navigate).toHaveBeenCalledWith(-1);
    expect(screen.getByRole("status")).toHaveTextContent("1 / 3");

    await user.keyboard("{Escape}");
    expect(backend.clear).toHaveBeenCalled();
    expect(input).not.toBeInTheDocument();
  });

  it("resets backend-owned state when the query is cleared", async () => {
    const { backend } = createFakeBackend(3);
    vi.mocked(backend.clear).mockImplementation(() => {});
    renderWithProviders(<BackendHarness backend={backend} />);

    const { user, input } = await openSearchAndType("needle");
    await waitFor(() => {
      expect(screen.getByTestId("backend-raw-match-state")).toHaveTextContent(
        "3:0:true",
      );
    });

    await user.clear(input);

    await waitFor(() => {
      expect(screen.getByTestId("backend-raw-match-state")).toHaveTextContent(
        "0:-1:false",
      );
      expect(
        screen.getByTestId("backend-raw-announced-state"),
      ).toHaveTextContent("0:-1:false");
    });
  });

  it("refreshes the visible count silently while indexing, announcing once converged", async () => {
    const { backend, emit, getSnapshot } = createFakeBackend(3);
    renderWithProviders(<BackendHarness backend={backend} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "open search" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search chat messages" }),
      "needle",
    );
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("1 / 3");
    });

    // Indexing progress: counts climb without touching the live region.
    act(() =>
      emit({ ...getSnapshot(), total: 4, activeOrdinal: 1, indexing: true }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("chat-search-match-count")).toHaveTextContent(
        "2 / 4",
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent("1 / 3");

    // Convergence announces once so the live region ends truthful.
    act(() =>
      emit({ ...getSnapshot(), total: 5, activeOrdinal: 2, indexing: false }),
    );
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("3 / 5");
    });
  });

  it("shows a searching state instead of no-results while the index converges", async () => {
    // Query matches nothing in the mounted window; the index is still working.
    const { backend, emit } = createFakeBackend(0, {
      total: 0,
      activeOrdinal: -1,
      indexing: true,
    });
    renderWithProviders(<BackendHarness backend={backend} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "open search" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search chat messages" }),
      "needle",
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-search-match-count")).toHaveTextContent(
        "Searching…",
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent("Searching…");
    expect(screen.getByRole("status")).not.toHaveTextContent("No results");

    // Offscreen matches arrive: the count corrects AND announces.
    act(() => emit({ total: 4, activeOrdinal: 0, indexing: false }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("1 / 4");
    });
  });

  it("announces a real no-results verdict only after indexing completes", async () => {
    const { backend, emit } = createFakeBackend(0, {
      total: 0,
      activeOrdinal: -1,
      indexing: true,
    });
    renderWithProviders(<BackendHarness backend={backend} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "open search" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search chat messages" }),
      "needle",
    );
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Searching…");
    });

    emit({ total: 0, activeOrdinal: -1, indexing: false });
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("No results");
    });
  });
});

describe("chat search bar keyboard ownership", () => {
  const windowKeyDown = vi.fn();

  beforeEach(() => {
    windowKeyDown.mockClear();
    window.addEventListener("keydown", windowKeyDown);
  });

  afterEach(() => {
    window.removeEventListener("keydown", windowKeyDown);
  });

  function renderBar() {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <ChatSearchBar
        query="needle"
        totalMatches={3}
        activeMatchIndex={0}
        isIndexing={false}
        announcedTotalMatches={3}
        announcedActiveMatchIndex={0}
        announcedIsIndexing={false}
        focusSignal={0}
        onQueryChange={vi.fn()}
        onNext={onNext}
        onPrevious={onPrevious}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("searchbox", {
      name: "Search chat messages",
    });
    return { input, onNext, onPrevious, onClose };
  }

  it("stops consumed Ctrl+N/Ctrl+P from reaching window-level handlers", () => {
    const { input, onNext, onPrevious } = renderBar();

    fireEvent.keyDown(input, { key: "n", ctrlKey: true });
    expect(onNext).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "p", ctrlKey: true });
    expect(onPrevious).toHaveBeenCalledTimes(1);

    // Off macOS these combos are the new-conversation and quick-switch
    // defaults; consumed navigation must not also fire window commands.
    expect(windowKeyDown).not.toHaveBeenCalled();

    // Control: unconsumed keys keep bubbling to window handlers.
    fireEvent.keyDown(input, { key: "a" });
    expect(windowKeyDown).toHaveBeenCalledTimes(1);
  });

  it("stops the closing Escape from reaching window-level handlers", () => {
    const { input, onClose } = renderBar();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(windowKeyDown).not.toHaveBeenCalled();
  });

  it("consumes Enter with any modifiers for result navigation", () => {
    const { input, onNext, onPrevious } = renderBar();

    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onNext).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(onPrevious).toHaveBeenCalledTimes(1);

    expect(windowKeyDown).not.toHaveBeenCalled();
  });
});
