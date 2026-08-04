import { describe, expect, it } from "vitest";
import {
  composeBuilderSendOptions,
  resolveAgentBuilderSkillBody,
} from "../useBuilderSendInterceptor";

describe("composeBuilderSendOptions", () => {
  it("returns options unchanged when session is not a builder", () => {
    const options = { assistantPrompt: "from another skill" };

    const out = composeBuilderSendOptions({ intent: null }, options);

    expect(out).toBe(options);
    expect(out.assistantPrompt).toBe("from another skill");
  });

  it("does not inject builder instructions after the capability closes", () => {
    const options = { assistantPrompt: "from another skill" };

    const out = composeBuilderSendOptions(
      {
        intent: "build-agent",
        agentBuilderOpen: false,
        targetAgentPath: "/Users/x/.agents/agents/draft-1.md",
      },
      options,
    );

    expect(out).toBe(options);
  });

  it("prepends builder prompt for builder sessions", () => {
    const out = composeBuilderSendOptions(
      {
        intent: "build-agent",
        targetAgentPath: "/Users/x/.agents/agents/draft-1.md",
      },
      {},
    );

    expect(out.assistantPrompt).toContain("agent-builder");
    expect(out.assistantPrompt).toContain("draft-1.md");
  });

  it("merges with existing assistantPrompt with two-newlines separator", () => {
    const out = composeBuilderSendOptions(
      {
        intent: "build-agent",
        targetAgentPath: "/Users/x/.agents/agents/draft-1.md",
      },
      { assistantPrompt: "from another skill" },
    );

    expect(out.assistantPrompt?.endsWith("from another skill")).toBe(true);
    expect(out.assistantPrompt).toMatch(/\n\nfrom another skill$/);
  });

  it("does not resend the full static skill body on repeated builder sends", () => {
    const session = {
      intent: "build-agent" as const,
      targetAgentPath: "/Users/x/.agents/agents/repeated-draft.md",
    };

    const first = composeBuilderSendOptions(session, {});
    const second = composeBuilderSendOptions(session, {});

    expect(first.assistantPrompt).toContain("# Agent Builder");
    expect(second.assistantPrompt).toContain("agent-builder session path");
    expect(second.assistantPrompt).not.toContain("# Agent Builder");
  });

  it("resolves the bundled app default agent-builder skill body", () => {
    expect(resolveAgentBuilderSkillBody("bundled body")).toBe("bundled body");
  });
});
