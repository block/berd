import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { TOOL_GROUPS } from "@/features/berdctl/commands/registry";
import {
  type AppCommand,
  defineCommand,
} from "@/features/berdctl/commands/types";

const createSessionSchema = TOOL_GROUPS.sessions.actions.create.schema;
const sendSessionSchema = TOOL_GROUPS.sessions.actions.send.schema;
const getSessionSchema = TOOL_GROUPS.sessions.actions.get.schema;
const listSessionsSchema = TOOL_GROUPS.sessions.actions.list.schema;
const renameSessionSchema = TOOL_GROUPS.sessions.actions.rename.schema;
const moveSessionSchema = TOOL_GROUPS.sessions.actions.move.schema;
const createAgentSchema = TOOL_GROUPS.agents.actions.create.schema;
const createSkillSchema = TOOL_GROUPS.skills.actions.create.schema;

// Strict-mode (unknown-key rejection) for EVERY action schema is covered in
// commands.test.ts, derived from TOOL_GROUPS so new actions cannot skip it.
// These bounds assertions read the colocated command modules through the
// registry, so a moved schema cannot silently lose its guardrails.
describe("berdctl command schema bounds", () => {
  it("sessions.create requires prompt and accepts harness selection", () => {
    expect(createSessionSchema.safeParse({}).success).toBe(false);
    expect(
      createSessionSchema.safeParse({
        prompt: "hi",
        harness_id: "codex-acp",
        project_id: "p1",
        agent_id: "a1",
        model_id: "m1",
      }).success,
    ).toBe(true);
  });

  it("sessions.send bounds prompt and defaults if_running to refuse", () => {
    expect(sendSessionSchema.safeParse({ session_id: "s1" }).success).toBe(
      false,
    );
    expect(
      sendSessionSchema.safeParse({ session_id: "s1", prompt: "" }).success,
    ).toBe(false);
    expect(
      sendSessionSchema.safeParse({
        session_id: "s1",
        prompt: "hi",
        if_running: "later",
      }).success,
    ).toBe(false);
    expect(
      sendSessionSchema.safeParse({
        session_id: "s1",
        prompt: "hi",
        startup_name: "   ",
      }).success,
    ).toBe(false);
    expect(
      sendSessionSchema.parse({
        session_id: "s1",
        prompt: "hi",
        startup_name: " feature ",
      }).startup_name,
    ).toBe("feature");
    expect(
      sendSessionSchema.parse({ session_id: "s1", prompt: "hi" }).if_running,
    ).toBe("refuse");
    expect(
      sendSessionSchema.safeParse({
        session_id: "s1",
        prompt: "hi",
        if_running: "queue",
      }).success,
    ).toBe(true);
  });

  it("sessions.get bounds messages and defaults to metadata only", () => {
    expect(
      getSessionSchema.safeParse({ session_id: "s1", messages: -1 }).success,
    ).toBe(false);
    expect(
      getSessionSchema.safeParse({ session_id: "s1", messages: 51 }).success,
    ).toBe(false);
    expect(getSessionSchema.parse({ session_id: "s1" }).messages).toBe(0);
    expect(
      getSessionSchema.parse({ session_id: "s1", messages: 50 }).messages,
    ).toBe(50);
  });

  it("sessions.list enforces limit bounds and defaults to 20", () => {
    expect(listSessionsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listSessionsSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(listSessionsSchema.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(listSessionsSchema.safeParse({ limit: 1 }).success).toBe(true);
    expect(listSessionsSchema.safeParse({ limit: 100 }).success).toBe(true);

    const parsed = listSessionsSchema.parse({});
    expect(parsed.limit).toBe(20);
  });

  it("sessions.rename rejects an empty title", () => {
    expect(
      renameSessionSchema.safeParse({ session_id: "s1", title: "" }).success,
    ).toBe(false);
  });

  it("sessions.move requires a destination project id", () => {
    expect(
      moveSessionSchema.safeParse({ session_id: "s1", project_id: null })
        .success,
    ).toBe(false);
    expect(moveSessionSchema.safeParse({ session_id: "s1" }).success).toBe(
      false,
    );
    expect(
      moveSessionSchema.safeParse({ session_id: "s1", project_id: "p1" })
        .success,
    ).toBe(true);
  });

  it("agents.create requires a concrete provider for a model", () => {
    const base = { name: "reviewer", system_prompt: "review code" };
    expect(
      createAgentSchema.safeParse({ ...base, model: "gpt-5.6" }).success,
    ).toBe(false);
    expect(
      createAgentSchema.safeParse({
        ...base,
        provider: "goose",
        model: "gpt-5.6",
      }).success,
    ).toBe(false);
    expect(
      createAgentSchema.safeParse({
        ...base,
        provider: "openai",
        model: "gpt-5.6",
      }).success,
    ).toBe(true);
  });

  it("defineCommand stays assignable to AppCommand when fields have defaults", async () => {
    // Compile-time check: input/output divergence from .default() must not
    // break `schema: ZodType<In, unknown>`, and defineCommand must infer
    // `args` from the schema without manual annotations.
    const command = defineCommand({
      effect: "read",
      visibility: "none",
      destructive: false,
      summary: "List sessions",
      description: "List sessions",
      helpFooter: "Example: list",
      schema: z
        .object({ limit: z.number().int().min(1).max(100).default(20) })
        .strict(),
      execute: async (args) => ({ count: args.limit }),
    });
    const asAppCommand: AppCommand<{ limit: number }, { count: number }> =
      command;

    const parsed = asAppCommand.schema.parse({});
    await expect(asAppCommand.execute(parsed, {})).resolves.toEqual({
      count: 20,
    });
  });

  it("skills.create requires non-empty name, description, and content", () => {
    expect(
      createSkillSchema.safeParse({ name: "", description: "d", content: "c" })
        .success,
    ).toBe(false);
    expect(
      createSkillSchema.safeParse({ name: "n", description: "", content: "c" })
        .success,
    ).toBe(false);
    expect(
      createSkillSchema.safeParse({ name: "n", description: "d", content: "" })
        .success,
    ).toBe(false);
  });
});
