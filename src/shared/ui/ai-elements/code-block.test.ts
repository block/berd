import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN_CACHE_LIMIT = 100;
const CACHE_OVERFLOW_COUNT = 25;
const TOTAL_CACHE_INSERTS = TOKEN_CACHE_LIMIT + CACHE_OVERFLOW_COUNT;

const { codeToTokens } = vi.hoisted(() => ({
  codeToTokens: vi.fn((code: string) => ({
    bg: "transparent",
    fg: "inherit",
    tokens: [
      [
        {
          color: "inherit",
          content: code,
        },
      ],
    ],
  })),
}));

vi.mock("shiki", () => ({
  createHighlighter: vi.fn(() =>
    Promise.resolve({
      codeToTokens,
      getLoadedLanguages: () => ["typescript"],
    }),
  ),
}));

const waitForTokenizations = (count: number) =>
  vi.waitFor(() => {
    expect(codeToTokens).toHaveBeenCalledTimes(count);
  });

describe("highlightCode", () => {
  beforeEach(() => {
    vi.resetModules();
    codeToTokens.mockClear();
  });

  it("evicts older tokenized code entries", async () => {
    const { highlightCode } = await import("./code-block");
    const code = (index: number) => `const evictedValue${index} = ${index};`;

    for (let i = 0; i < TOTAL_CACHE_INSERTS; i += 1) {
      highlightCode(code(i), "typescript");
    }

    await waitForTokenizations(TOTAL_CACHE_INSERTS);

    expect(
      highlightCode(code(CACHE_OVERFLOW_COUNT - 1), "typescript"),
    ).toBeNull();
    expect(
      highlightCode(code(CACHE_OVERFLOW_COUNT), "typescript"),
    ).not.toBeNull();

    await waitForTokenizations(TOTAL_CACHE_INSERTS + 1);
  });

  it("refreshes token cache recency on hits", async () => {
    const { highlightCode } = await import("./code-block");
    const code = (index: number) => `const recentValue${index} = ${index};`;

    for (let i = 0; i < TOKEN_CACHE_LIMIT; i += 1) {
      highlightCode(code(i), "typescript");
    }

    await waitForTokenizations(TOKEN_CACHE_LIMIT);

    expect(highlightCode(code(0), "typescript")).not.toBeNull();

    for (let i = TOKEN_CACHE_LIMIT; i < TOTAL_CACHE_INSERTS; i += 1) {
      highlightCode(code(i), "typescript");
    }

    await waitForTokenizations(TOTAL_CACHE_INSERTS);

    expect(highlightCode(code(0), "typescript")).not.toBeNull();
    expect(highlightCode(code(CACHE_OVERFLOW_COUNT), "typescript")).toBeNull();

    await waitForTokenizations(TOTAL_CACHE_INSERTS + 1);
  });
});
