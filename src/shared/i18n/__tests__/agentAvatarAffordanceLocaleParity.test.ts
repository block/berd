import { describe, expect, it } from "vitest";
import enAgents from "../locales/en/agents.json";
import esAgents from "../locales/es/agents.json";

/**
 * Focused parity check for the agent-profile avatar affordance strings.
 *
 * These keys shipped once as raw `editor.changeAvatar` text in the UI because
 * the `t()` call had no locale entry behind it. Component tests cannot catch
 * that class of bug: they mock `react-i18next` so `t()` echoes the key back,
 * which means a missing translation and a present one look identical.
 *
 * A blanket en↔es gate would be the better long-term tool, but the locales
 * have pre-existing gaps that predate this feature. Until that backlog is
 * cleared, this pins the contract for the keys the avatar affordance owns.
 */

const AVATAR_AFFORDANCE_KEYS = ["changeAvatar", "customizeAvatar"] as const;

describe("agent avatar affordance locale parity", () => {
  it.each(
    AVATAR_AFFORDANCE_KEYS,
  )("resolves editor.%s to real copy in both locales", (key) => {
    const en = enAgents.editor[key];
    const es = esAgents.editor[key];

    expect(en).toBeTruthy();
    expect(es).toBeTruthy();
    // Guards the original bug: a value equal to the lookup key means the UI
    // would render "editor.changeAvatar" instead of "Change avatar".
    expect(en).not.toBe(`editor.${key}`);
    expect(es).not.toBe(`editor.${key}`);
    // Spanish must be translated, not an untouched English copy.
    expect(es).not.toBe(en);
  });
});
