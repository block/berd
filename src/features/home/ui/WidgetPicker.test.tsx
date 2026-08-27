import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROMPT_PINS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  setExperimentEnabled,
} from "@/features/experiments/experimentPreferences";
import { WidgetPicker } from "./WidgetPicker";

function renderPicker({ onSelect = vi.fn() }: { onSelect?: () => void } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  return render(
    <WidgetPicker
      open
      x={0}
      y={0}
      instances={[]}
      onClose={vi.fn()}
      onSelect={onSelect}
      onRestoreStarterTasks={vi.fn()}
    />,
    { wrapper: Wrapper },
  );
}

function openWidgetsPanel() {
  fireEvent.click(screen.getByRole("button", { name: "Widgets" }));
}

describe("WidgetPicker prompt pin gating", () => {
  beforeEach(() => {
    localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
  });

  it("shows the Prompt row when the prompt-pins experiment is enabled", () => {
    setExperimentEnabled(PROMPT_PINS_EXPERIMENT_ID, true);
    const onSelect = vi.fn();
    renderPicker({ onSelect });
    openWidgetsPanel();

    fireEvent.click(screen.getByRole("button", { name: "Prompt" }));

    expect(onSelect).toHaveBeenCalledWith("promptPin");
  });

  it("hides the Prompt row when the prompt-pins experiment is disabled", () => {
    setExperimentEnabled(PROMPT_PINS_EXPERIMENT_ID, false);
    renderPicker();
    openWidgetsPanel();

    expect(
      screen.getByRole("button", { name: "Sticky note" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Prompt" }),
    ).not.toBeInTheDocument();
  });
});
