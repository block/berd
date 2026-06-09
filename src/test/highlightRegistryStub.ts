import { vi } from "vitest";

/**
 * Minimal CSS Custom Highlight API double. Mirrors the production contract in
 * transcriptSearch.ts: registered Highlight instances are mutated in place
 * via clear()/add() (the WKWebView repaint workaround), so the stub must
 * implement the set-like mutators, not just the constructor.
 */
export class MockHighlight {
  ranges: Range[];
  priority = 0;

  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }

  add(range: Range) {
    this.ranges.push(range);
  }

  clear() {
    this.ranges = [];
  }
}

/**
 * Installs `Highlight` and `CSS.highlights` globals for jsdom. Call in
 * beforeEach and pair with `vi.unstubAllGlobals()` in afterEach.
 */
export function stubHighlightRegistry(): Map<string, MockHighlight> {
  const registry = new Map<string, MockHighlight>();
  vi.stubGlobal("Highlight", MockHighlight);
  vi.stubGlobal("CSS", { highlights: registry });
  return registry;
}
