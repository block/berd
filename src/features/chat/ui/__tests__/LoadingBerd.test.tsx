import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingBerd } from "../LoadingBerd";
import chat from "@/shared/i18n/locales/en/chat.json";

const { thinking, responding, compacting } = chat.loading;

describe("LoadingBerd", () => {
  it("renders thinking copy for the thinking state", () => {
    render(<LoadingBerd chatState="thinking" />);

    expect(screen.getByRole("status", { name: thinking })).toBeInTheDocument();
  });

  it("uses a valid spaced calc expression for the shimmer gradient", () => {
    render(<LoadingBerd chatState="thinking" />);

    expect(screen.getByText(thinking)).toHaveStyle({
      "--spread": `${thinking.length * 5}px`,
      "--bg":
        "linear-gradient(90deg, #0000 calc(50% - var(--spread)), var(--shimmer-highlight), #0000 calc(50% + var(--spread)))",
    });
  });

  it("keeps the default shimmer animation running", () => {
    render(<LoadingBerd chatState="thinking" />);

    expect(screen.getByText(thinking)).toHaveClass("shimmer-text");
    expect(screen.getByText(thinking)).not.toHaveClass(
      "shimmer-text-continuous",
    );
  });

  it("uses the polished shimmer for the responding surface", () => {
    render(<LoadingBerd chatState="thinking" motionPreset="responding" />);

    expect(screen.getByText(thinking)).toHaveClass(
      "shimmer-text",
      "shimmer-text-continuous",
    );
    expect(screen.getByText(thinking)).toHaveStyle({
      "--spread": `${thinking.length * 2.5}px`,
      "--bg":
        "linear-gradient(100deg, #0000 calc(50% - var(--spread)), var(--shimmer-highlight), #0000 calc(50% + var(--spread)))",
    });
  });

  it("renders responding copy for active response states", () => {
    const { rerender } = render(<LoadingBerd chatState="streaming" />);

    expect(
      screen.getByRole("status", { name: responding }),
    ).toBeInTheDocument();

    rerender(<LoadingBerd chatState="waiting" />);
    expect(
      screen.getByRole("status", { name: responding }),
    ).toBeInTheDocument();
  });

  it("renders compacting copy for the compacting state", () => {
    render(<LoadingBerd chatState="compacting" />);

    expect(
      screen.getByRole("status", { name: compacting }),
    ).toBeInTheDocument();
  });

  it("renders nothing while idle", () => {
    const { container } = render(<LoadingBerd chatState="idle" />);

    expect(container).toBeEmptyDOMElement();
  });
});
