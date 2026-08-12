import { describe, expect, it } from "vitest";

type Finding = {
  label: string;
  line: number;
  value: string;
};

type DesignSystemTokensModule = {
  findSemanticTokenFindings: (
    globalsText: string,
    options?: {
      rawCssColorTokens?: Set<string>;
      darkPairingExemptions?: Set<string>;
    },
  ) => Finding[];
  findRawCssDocSyncFindings: (options?: {
    docText?: string;
    rawCssColorTokens?: Set<string>;
  }) => Finding[];
};

const modulePath = "../../../scripts/design-system-tokens.mjs";
// Vite resolves the static string while TypeScript sees a dynamic import path.
const { findRawCssDocSyncFindings, findSemanticTokenFindings } = (await import(
  modulePath
)) as DesignSystemTokensModule;

function semanticCss({
  root = "",
  dark = "",
  bridge = "",
}: {
  root?: string;
  dark?: string;
  bridge?: string;
}) {
  return `
    :root {
      ${root}
    }
    .dark {
      ${dark}
    }
    @theme inline {
      ${bridge}
    }
  `;
}

function findingsFor(
  css: string,
  options: {
    rawCssColorTokens?: Set<string>;
    darkPairingExemptions?: Set<string>;
  } = {},
) {
  return findSemanticTokenFindings(css, {
    rawCssColorTokens: new Set(),
    darkPairingExemptions: new Set(),
    ...options,
  });
}

function labelsFor(css: string, options?: Parameters<typeof findingsFor>[1]) {
  return findingsFor(css, options).map(({ label, value }) => ({
    label,
    value,
  }));
}

describe("design-system semantic color contract", () => {
  it.each([
    ["named", "rebeccapurple", "navy"],
    ["hex", "#abcdef", "#123456"],
    ["functional", "oklch(62% 0.2 30)", "rgb(10 20 30 / 80%)"],
    [
      "color mix",
      "color-mix(in oklab, red 20%, transparent)",
      "color-mix(in srgb, blue 40%, transparent)",
    ],
  ])("governs %s colors", (_label, light, dark) => {
    const findings = labelsFor(
      semanticCss({
        root: `--review: ${light};`,
        dark: `--review: ${dark};`,
      }),
    );

    expect(findings).toContainEqual({
      label: "ungoverned semantic color token",
      value: "--review",
    });
  });

  it("accepts a paired bridged color", () => {
    expect(
      labelsFor(
        semanticCss({
          root: "--review: rebeccapurple;",
          dark: "--review: navy;",
          bridge: "--color-review: var(--review);",
        }),
      ),
    ).not.toContainEqual(expect.objectContaining({ value: "--review" }));
  });

  it.each([
    ":root",
    ".dark",
  ])("rejects duplicate declarations in %s", (selector) => {
    const root =
      selector === ":root"
        ? "--background: red; --background: blue;"
        : "--background: red;";
    const dark =
      selector === ".dark"
        ? "--background: red; --background: blue;"
        : "--background: blue;";

    expect(labelsFor(semanticCss({ root, dark }))).toContainEqual({
      label: `duplicate semantic token in ${selector}`,
      value: "--background",
    });
  });

  it.each([
    ":root",
    ".dark",
  ])("rejects duplicates split across repeated %s blocks", (selector) => {
    const otherSelector = selector === ":root" ? ".dark" : ":root";
    const css = `
      ${selector} { --background: red; }
      ${otherSelector} { --background: blue; }
      ${selector} { --background: green; }
      @theme inline { --color-background: var(--background); }
    `;

    expect(labelsFor(css)).toContainEqual({
      label: `duplicate semantic token in ${selector}`,
      value: "--background",
    });
  });

  it("rejects conditional semantic token blocks with a policy-specific finding", () => {
    const findings = labelsFor(`
      :root { --background: red; }
      .dark { --background: blue; }
      @media (forced-colors: active) {
        :root { --background: Canvas; }
      }
      @theme inline { --color-background: var(--background); }
    `);

    expect(findings).toContainEqual({
      label: "conditional semantic token block",
      value: "@media :root",
    });
    expect(findings).not.toContainEqual({
      label: "duplicate semantic token in :root",
      value: "--background",
    });
  });

  it("rejects a dark-only color token", () => {
    expect(
      labelsFor(
        semanticCss({
          dark: "--review: rebeccapurple;",
        }),
      ),
    ).toContainEqual({
      label: "semantic color token missing root value",
      value: "--review",
    });
  });

  it("accepts a dark alias that inherits a root-only color token", () => {
    const findings = labelsFor(
      semanticCss({
        root: "--background: var(--base); --base: red;",
        dark: "--background: var(--base);",
        bridge:
          "--color-background: var(--background); --color-base: var(--base);",
      }),
      { darkPairingExemptions: new Set(["base"]) },
    );

    expect(findings).not.toContainEqual(
      expect.objectContaining({
        value: expect.stringContaining("--background"),
      }),
    );
  });

  it("rejects a root color with a non-color dark override", () => {
    expect(
      labelsFor(
        semanticCss({
          root: "--background: red;",
          dark: "--background: 12px;",
          bridge: "--color-background: var(--background);",
        }),
      ),
    ).toContainEqual({
      label: "semantic color token has non-color dark value",
      value: "--background: 12px",
    });
  });

  it("rejects a dark color with a non-color root declaration", () => {
    expect(
      labelsFor(
        semanticCss({
          root: "--background: 12px;",
          dark: "--background: red;",
          bridge: "--color-background: var(--background);",
        }),
      ),
    ).toContainEqual({
      label: "dark color token has non-color root value",
      value: "--background",
    });
  });

  it("resolves var-only color aliases transitively", () => {
    const findings = labelsFor(
      semanticCss({
        root: "--background: var(--base); --base: rebeccapurple;",
        dark: "--background: var(--base); --base: navy;",
        bridge:
          "--color-background: var(--background); --color-base: var(--base);",
      }),
    );

    expect(findings).not.toContainEqual(
      expect.objectContaining({ value: "--background" }),
    );
  });

  it("classifies a color var fallback when the referenced token is absent", () => {
    expect(
      labelsFor(
        semanticCss({
          root: "--review: var(--optional-color, rebeccapurple);",
          dark: "--review: var(--optional-color, navy);",
        }),
      ),
    ).toContainEqual({
      label: "ungoverned semantic color token",
      value: "--review",
    });
  });

  it("resolves nested var fallbacks", () => {
    expect(
      labelsFor(
        semanticCss({
          root: "--review: var(--first, var(--second, color-mix(in srgb, red, blue)));",
          dark: "--review: var(--first, var(--second, navy));",
        }),
      ),
    ).toContainEqual({
      label: "ungoverned semantic color token",
      value: "--review",
    });
  });

  it("prefers a defined variable over its fallback", () => {
    expect(
      labelsFor(
        semanticCss({
          root: "--review: var(--base, red); --base: 12px;",
          dark: "--review: var(--base, blue); --base: 12px;",
        }),
      ),
    ).toEqual([]);
  });

  it("does not classify a non-color var fallback", () => {
    expect(
      labelsFor(
        semanticCss({
          root: "--review: var(--optional-size, 12px);",
          dark: "--review: var(--optional-size, 16px);",
        }),
      ),
    ).toEqual([]);
  });

  it("rejects non-color variables embedded in color functions", () => {
    expect(
      labelsFor(
        semanticCss({
          root: `
            --review-size: 12px;
            --review: color-mix(
              in srgb,
              var(--review-size) 20%,
              transparent
            );
          `,
          dark: "--review: navy;",
        }),
      ),
    ).toContainEqual({
      label: "semantic color contains non-color variable",
      value:
        "--review: color-mix(\n              in srgb,\n              var(--review-size) 20%,\n              transparent\n            )",
    });
  });

  it("accepts color variables embedded in color functions", () => {
    const findings = labelsFor(
      semanticCss({
        root: `
          --review-base: rebeccapurple;
          --review: color-mix(
            in srgb,
            var(--review-base) 20%,
            transparent
          );
        `,
        dark: `
          --review-base: navy;
          --review: color-mix(
            in srgb,
            var(--review-base) 20%,
            transparent
          );
        `,
        bridge:
          "--color-review: var(--review); --color-review-base: var(--review-base);",
      }),
    );

    expect(findings).not.toContainEqual(
      expect.objectContaining({ value: expect.stringContaining("--review") }),
    );
  });

  it("resolves embedded color fallbacks", () => {
    expect(
      labelsFor(
        semanticCss({
          root: "--review: color-mix(in srgb, var(--optional, rebeccapurple) 20%, transparent);",
          dark: "--review: color-mix(in srgb, var(--optional, navy) 20%, transparent);",
        }),
      ),
    ).toContainEqual({
      label: "ungoverned semantic color token",
      value: "--review",
    });
  });

  it("rejects embedded non-color fallbacks", () => {
    expect(
      labelsFor(
        semanticCss({
          root: "--review: color-mix(in srgb, var(--optional, 12px) 20%, transparent);",
          dark: "--review: navy;",
        }),
      ),
    ).toContainEqual({
      label: "semantic color contains non-color variable",
      value:
        "--review: color-mix(in srgb, var(--optional, 12px) 20%, transparent)",
    });
  });

  it("does not classify gradients, filters, or scalar values as colors", () => {
    expect(
      labelsFor(
        semanticCss({
          root: `
            --gradient: linear-gradient(red, blue);
            --filter: blur(10px) saturate(120%);
            --opacity: 0.7;
          `,
        }),
      ),
    ).toEqual([]);
  });

  it("parses comments and multiline declarations without losing locations", () => {
    const findings = findingsFor(
      semanticCss({
        root: `
          /* a comment with : and ; */
          --review: color-mix(
            in oklab,
            red 20%,
            transparent
          );
        `,
        dark: "--review: navy;",
      }),
    );

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "ungoverned semantic color token",
          line: expect.any(Number),
          value: "--review",
        }),
      ]),
    );
  });

  it("rejects stale raw-CSS allowlist entries", () => {
    expect(
      labelsFor(
        semanticCss({
          root: "--text-selection-bg: 12px;",
          dark: "--text-selection-bg: 12px;",
        }),
        { rawCssColorTokens: new Set(["text-selection-bg"]) },
      ),
    ).toContainEqual({
      label: "stale raw-CSS allowlist entry",
      value: "--text-selection-bg",
    });
  });

  it("rejects stale dark-pairing exemptions", () => {
    expect(
      labelsFor(
        semanticCss({
          root: "--clock-hand: 12px;",
        }),
        { darkPairingExemptions: new Set(["clock-hand"]) },
      ),
    ).toContainEqual({
      label: "stale dark-pairing exemption",
      value: "--clock-hand",
    });
  });

  it("rejects a pairing exemption once the token gains a dark override", () => {
    expect(
      labelsFor(
        semanticCss({
          root: "--clock-hand: red;",
          dark: "--clock-hand: blue;",
        }),
        { darkPairingExemptions: new Set(["clock-hand"]) },
      ),
    ).toContainEqual({
      label: "stale dark-pairing exemption",
      value: "--clock-hand",
    });
  });
});

describe("raw-CSS color documentation contract", () => {
  const startMarker = "<!-- raw-css-color-tokens:start -->";
  const endMarker = "<!-- raw-css-color-tokens:end -->";

  function docWithTokens(lines: string[]) {
    return `${startMarker}\n${lines.join("\n")}\n${endMarker}`;
  }

  it("rejects missing machine-readable markers", () => {
    expect(
      findRawCssDocSyncFindings({
        docText: "--selection-bg",
        rawCssColorTokens: new Set(["selection-bg"]),
      }),
    ).toEqual([
      expect.objectContaining({ label: "missing raw-CSS token markers" }),
    ]);
  });

  it("rejects allowlisted tokens missing from docs", () => {
    expect(
      findRawCssDocSyncFindings({
        docText: docWithTokens([]),
        rawCssColorTokens: new Set(["selection-bg"]),
      }),
    ).toEqual([
      expect.objectContaining({
        label: "raw-CSS token missing from docs",
        value: "--selection-bg",
      }),
    ]);
  });

  it("rejects documented tokens missing from the allowlist", () => {
    expect(
      findRawCssDocSyncFindings({
        docText: docWithTokens(["--selection-bg"]),
        rawCssColorTokens: new Set(),
      }),
    ).toEqual([
      expect.objectContaining({
        label: "documented raw-CSS token missing from allowlist",
        value: "--selection-bg",
      }),
    ]);
  });

  it("does not treat token-like text in comments as documentation", () => {
    expect(
      findRawCssDocSyncFindings({
        docText: docWithTokens(["# Replace --selection-bg later"]),
        rawCssColorTokens: new Set(["selection-bg"]),
      }),
    ).toEqual([
      expect.objectContaining({
        label: "raw-CSS token missing from docs",
        value: "--selection-bg",
      }),
    ]);
  });
});
