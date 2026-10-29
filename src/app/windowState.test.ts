import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Native plugin wiring is outside jsdom. Guard the exclusion that prevents
// stale persisted geometry from overriding the fixed-size call controls.
const app = readFileSync(resolve("src-tauri/src/lib.rs"), "utf8");

describe("window-state persistence", () => {
  it("excludes floating voice controls from geometry restoration and tracking", () => {
    const builder = app.match(
      /tauri_plugin_window_state::Builder::default\(\)([\s\S]*?)\.build\(\)/,
    )?.[1];
    expect(builder).toBeDefined();
    expect(builder).toContain(
      ".with_denylist(&[commands::voice_buddy::WINDOW_LABEL])",
    );
  });

  it("continues restoring ordinary windows without restoring visibility", () => {
    expect(app).toContain(
      ".with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)",
    );
  });
});
