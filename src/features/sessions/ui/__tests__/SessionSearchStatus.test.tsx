import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/shared/i18n";
import { SessionSearchStatus } from "../SessionSearchStatus";

describe("SessionSearchStatus", () => {
  afterEach(async () => {
    // The Spanish cases mutate the shared i18n instance.
    if (i18n.language !== "en") {
      await act(async () => {
        await i18n.changeLanguage("en");
      });
    }
  });

  it("narrates sweep progress while searching", () => {
    render(
      <SessionSearchStatus
        query="needle"
        isSearching
        progress={{ searched: 3, total: 12 }}
        resultCount={0}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Searching conversations… 3 of 12");
  });

  it("names every searched field when a content sweep ran", () => {
    render(
      <SessionSearchStatus
        query="needle"
        isSearching={false}
        progress={null}
        resultCount={5}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "5 results · titles, agents, projects, dates, and conversation text",
    );
  });

  it("pluralizes a single result", () => {
    render(
      <SessionSearchStatus
        query="needle"
        isSearching={false}
        progress={null}
        resultCount={1}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "1 result · titles, agents, projects, dates, and conversation text",
    );
  });

  // A one-character query never reaches the message corpus, so the completed
  // status must not claim conversation text was read.
  it("omits the conversation-text claim for a query too short to sweep", () => {
    render(
      <SessionSearchStatus
        query="a"
        isSearching={false}
        progress={null}
        resultCount={2}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "2 results · titles, agents, projects, and dates — type more to search conversation text",
    );
    expect(status.textContent).not.toMatch(
      /dates, and conversation text|·[^—]*conversation text\.?$/,
    );
  });

  it("claims conversation text once the query is long enough to sweep", () => {
    render(
      <SessionSearchStatus
        query="ab"
        isSearching={false}
        progress={null}
        resultCount={2}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "2 results · titles, agents, projects, dates, and conversation text",
    );
  });

  // The sweep resolves even when individual corpus exports fail, so a
  // "complete" claim here would present a false negative as authoritative.
  it("admits the gap when some conversations could not be read", () => {
    render(
      <SessionSearchStatus
        query="needle"
        isSearching={false}
        progress={{ searched: 3, total: 5, unreadable: 2 }}
        resultCount={4}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "4 results · titles, agents, projects, dates, and conversation text — 2 conversations could not be read",
    );
  });

  // The result count and the unread count pluralize independently; a single
  // string could only ever agree with one of them.
  it("pluralizes the unread clause on its own count", () => {
    render(
      <SessionSearchStatus
        query="needle"
        isSearching={false}
        progress={{ searched: 4, total: 5, unreadable: 1 }}
        resultCount={1}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "1 result · titles, agents, projects, dates, and conversation text — 1 conversation could not be read",
    );
  });

  it("claims complete coverage only when nothing was skipped", () => {
    render(
      <SessionSearchStatus
        query="needle"
        isSearching={false}
        progress={{ searched: 5, total: 5, unreadable: 0 }}
        resultCount={4}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "4 results · titles, agents, projects, dates, and conversation text",
    );
    expect(status.textContent).not.toContain("could not be read");
  });

  it("admits the gap in Spanish too", async () => {
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    render(
      <SessionSearchStatus
        query="needle"
        isSearching={false}
        progress={{ searched: 3, total: 5, unreadable: 2 }}
        resultCount={4}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "4 resultados · títulos, agentes, proyectos, fechas y texto de conversación — no se pudieron leer 2 conversaciones",
    );
  });

  it("reports a pending edit instead of the previous query's counts", () => {
    render(
      <SessionSearchStatus
        query="needle"
        isPending
        isSearching={false}
        progress={null}
        resultCount={5}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Searching as you type…");
    expect(status.textContent).not.toContain("5 results");
  });

  // The backend's message is English technical prose; only locale copy is
  // shown, so a Spanish UI never surfaces it.
  it("shows localized copy rather than the backend error text", () => {
    render(
      <SessionSearchStatus
        query="needle"
        isSearching={false}
        progress={null}
        resultCount={0}
        error="Search failed: session missing"
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveClass("text-destructive");
    expect(status.textContent).not.toContain("session missing");
    expect(status).toHaveTextContent(
      "Message search failed. Showing title, agent, and project matches only. Try again.",
    );
  });

  it("narrates the searched scope in Spanish", async () => {
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    render(
      <SessionSearchStatus
        query="needle"
        isSearching={false}
        progress={null}
        resultCount={5}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "5 resultados · títulos, agentes, proyectos, fechas y texto de conversación",
    );
  });

  it("shows a localized error in Spanish", async () => {
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    render(
      <SessionSearchStatus
        query="needle"
        isSearching={false}
        progress={null}
        resultCount={0}
        error="Search failed: session missing"
      />,
    );

    const status = screen.getByRole("status");
    expect(status.textContent).not.toContain("session missing");
    expect(status).toHaveTextContent(
      "La búsqueda de mensajes falló. Mostrando solo coincidencias por título, agente y proyecto. Inténtalo de nuevo.",
    );
  });
});
