import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { reportRendererError } from "@/app/lib/rendererDiagnostics";
import { RendererErrorBoundary } from "./RendererErrorBoundary";

vi.mock("@/app/lib/rendererDiagnostics", () => ({
  reportRendererError: vi.fn(),
}));

function ThrowingChild(): never {
  throw new Error("render failed");
}

describe("RendererErrorBoundary", () => {
  beforeEach(() => {
    vi.mocked(reportRendererError).mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("reports React render failures and shows reload fallback", async () => {
    render(
      <RendererErrorBoundary>
        <ThrowingChild />
      </RendererErrorBoundary>,
    );

    expect(screen.getByRole("heading")).toHaveTextContent(
      "Something went wrong",
    );
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    await waitFor(() => {
      expect(reportRendererError).toHaveBeenCalledWith(
        "react_error_boundary",
        expect.any(Error),
        expect.objectContaining({
          componentStack: expect.any(String),
        }),
      );
    });
  });
});
