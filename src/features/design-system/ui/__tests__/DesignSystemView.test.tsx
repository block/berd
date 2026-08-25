import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Rendering DesignSystemView under jsdom currently hangs in an effect loop,
// so this pins the source directly, in the same spirit as globals.test.ts.
const source = readFileSync(
  join(__dirname, "..", "DesignSystemView.tsx"),
  "utf8",
);

describe("DesignSystemView surfaces", () => {
  it("keeps the page-sized explorer shell on the canvas surface, not paper", () => {
    // The explorer is a full main-panel product surface. bg-background is
    // the paper alias of card, so a page-sized fill would repaint the whole
    // view as one raised card in dark mode. Preview tiles inside sections
    // use bg-background deliberately; only the page-sized wrappers are
    // pinned here.
    expect(source).toContain(
      '<MainPanelLayout backgroundColor="bg-canvas-base">',
    );
    expect(source).not.toContain('backgroundColor="bg-background"');
    expect(source).not.toContain("overflow-hidden bg-background");
  });

  it("documents radio cards with state-aware controls and token rows", () => {
    expect(source).toContain('id: "radio-group-presentation"');
    expect(source).toContain('id: "radio-group-selected"');
    expect(source).toContain(
      'onValueChange={(value) => setSelected(value === "option")}',
    );
    expect(source).toContain('id: "radio-group-disabled"');
    expect(source).toContain('anatomy: "Card surface"');
    expect(source).toContain('state: "Focus visible"');
    expect(source).toContain("...(!disabled");
    expect(source).toContain('"muted-foreground / 50% opacity"');
    expect(source).toContain(
      'presentation === "card" ? "font-medium" : "font-normal"',
    );
    expect(source).not.toContain(
      'function RadioGroupPage() {\n  return <GenericComponentPage name="Radio Group" />;',
    );
  });
});
