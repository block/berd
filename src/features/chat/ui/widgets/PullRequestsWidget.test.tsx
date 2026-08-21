import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPullRequestSummaries } from "@/shared/api/pullRequests";
import { PullRequestsWidget } from "./PullRequestsWidget";

vi.mock("@/shared/api/pullRequests", () => ({
  getPullRequestSummaries: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

describe("PullRequestsWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(openUrl).mockResolvedValue(undefined);
  });

  it("renders live PR metadata and opens GitHub", async () => {
    vi.mocked(getPullRequestSummaries).mockResolvedValue([
      {
        url: "https://github.com/squareup/berd/pull/42",
        repoSlug: "squareup/berd",
        number: 42,
        title: "Show related pull requests",
        state: "OPEN",
        isDraft: false,
        checksStatus: "SUCCESS",
      },
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <PullRequestsWidget
          pullRequests={[
            {
              url: "https://github.com/squareup/berd/pull/42",
              repoSlug: "squareup/berd",
              number: 42,
            },
          ]}
          workspacePath="/repo"
          isOpen
          onToggleOpen={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Show related pull requests")).toBeVisible();
    expect(screen.getByText("Open")).toBeVisible();
    expect(screen.getByText("Checks passed")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open squareup/berd pull request #42 on GitHub",
      }),
    );
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/squareup/berd/pull/42",
    );
  });
});
