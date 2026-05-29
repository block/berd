import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingGoose } from "../LoadingGoose";
import chat from "@/shared/i18n/locales/en/chat.json";

const { thinking, responding, compacting } = chat.loading;

describe("LoadingGoose", () => {
  it("renders thinking copy for the thinking state", () => {
    render(<LoadingGoose chatState="thinking" />);

    expect(screen.getByRole("status", { name: thinking })).toBeInTheDocument();
  });

  it("uses a valid spaced calc expression for the shimmer gradient", () => {
    render(<LoadingGoose chatState="thinking" />);

    expect(screen.getByText(thinking)).toHaveStyle({
      "--bg":
        "linear-gradient(90deg, #0000 calc(50% - var(--spread)), var(--shimmer-highlight), #0000 calc(50% + var(--spread)))",
    });
  });

  it("keeps the shimmer animation running", () => {
    render(<LoadingGoose chatState="thinking" />);

    expect(screen.getByText(thinking)).toHaveClass("shimmer-text");
  });

  it("renders responding copy for active response states", () => {
    const { rerender } = render(<LoadingGoose chatState="streaming" />);

    expect(
      screen.getByRole("status", { name: responding }),
    ).toBeInTheDocument();

    rerender(<LoadingGoose chatState="waiting" />);
    expect(
      screen.getByRole("status", { name: responding }),
    ).toBeInTheDocument();
  });

  it("renders compacting copy for the compacting state", () => {
    render(<LoadingGoose chatState="compacting" />);

    expect(
      screen.getByRole("status", { name: compacting }),
    ).toBeInTheDocument();
  });

  it("renders nothing while idle", () => {
    const { container } = render(<LoadingGoose chatState="idle" />);

    expect(container).toBeEmptyDOMElement();
  });
});
