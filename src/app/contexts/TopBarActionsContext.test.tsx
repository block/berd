import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import {
  TopBarActionsProvider,
  useSetTopBarActions,
  useTopBarActions,
} from "./TopBarActionsContext";

function SlotOutlet() {
  const actions = useTopBarActions();
  return <div data-testid="slot">{actions}</div>;
}

function PageMountingActions({ label }: { label: string }) {
  const setActions = useSetTopBarActions();
  useEffect(() => {
    setActions(<button type="button">{label}</button>);
    return () => setActions(null);
  }, [label, setActions]);
  return <div>page body</div>;
}

describe("TopBarActionsContext", () => {
  it("mounts a page's actions into the slot", () => {
    render(
      <TopBarActionsProvider>
        <SlotOutlet />
        <PageMountingActions label="Import" />
      </TopBarActionsProvider>,
    );
    expect(screen.getByRole("button", { name: "Import" })).toBeInTheDocument();
  });

  it("clears actions when the page unmounts", () => {
    const { rerender } = render(
      <TopBarActionsProvider>
        <SlotOutlet />
        <PageMountingActions label="Import" />
      </TopBarActionsProvider>,
    );
    expect(screen.getByRole("button", { name: "Import" })).toBeInTheDocument();

    rerender(
      <TopBarActionsProvider>
        <SlotOutlet />
      </TopBarActionsProvider>,
    );
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
  });

  it("replaces actions when a different page mounts", () => {
    const { rerender } = render(
      <TopBarActionsProvider>
        <SlotOutlet />
        <PageMountingActions label="Import" />
      </TopBarActionsProvider>,
    );
    expect(screen.getByRole("button", { name: "Import" })).toBeInTheDocument();

    rerender(
      <TopBarActionsProvider>
        <SlotOutlet />
        <PageMountingActions label="New" />
      </TopBarActionsProvider>,
    );
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("returns null from the consumer hook when nothing is mounted", () => {
    render(
      <TopBarActionsProvider>
        <SlotOutlet />
      </TopBarActionsProvider>,
    );
    expect(screen.getByTestId("slot")).toBeEmptyDOMElement();
  });
});
