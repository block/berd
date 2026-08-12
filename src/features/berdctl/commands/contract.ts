import { z } from "zod/v4";

import { TOOL_GROUPS } from "./registry";
import type { AppCommand, ToolGroup } from "./types";

/**
 * Builders for the berdctl contract artifacts
 * (src-tauri/crates/berdctl/api-surface.json and cli-surface.json).
 *
 * The colocated command modules are the single authored source — zod schemas
 * carry the wire shape, bounds, and field descriptions (.describe()); each
 * command's summary/description/helpFooter carry the help prose. This module
 * introspects them into two projections:
 *
 * - api-surface.json: the client-neutral wire truth (groups → actions →
 *   description + flat field model + JSON Schema of the args), consumable by
 *   any client of the broker's POST /v1/call endpoint.
 * - cli-surface.json: the CLI projection (noun/verb tree and CLI-only
 *   prose) the bundled berdctl binary hand-projects from.
 *
 * `scripts/generate-berdctl-contract.mjs` writes both to disk; the berdctl
 * crate embeds them and builds its clap tree at startup (tree.rs). The
 * vitest freshness tests (apiSurface.test.ts / cliSurface.test.ts) compare
 * these builders against the checked-in artifacts, so generator and tests
 * cannot disagree: both call this code.
 */

/** Wire protocol version of the broker envelope this surface describes.
 *  Mirror of `PROTOCOL_VERSION` in both discovery.rs copies (a berdctl
 *  crate test pins the CLI copy, and a plugin crate test pins the broker
 *  copy); bump all copies together. */
const WIRE_PROTOCOL_VERSION = 4;

type FieldSpec = {
  /** snake_case wire field name. */
  name: string;
  /** Must be present on the wire — a zod .default() field is NOT required. */
  required: boolean;
  kind: "string" | "string_array" | "number" | "boolean";
  /** Allowed string values for z.enum fields. */
  values?: string[];
  /** Field documentation, from the zod .describe(); the CLI renders it as
   *  the flag's --help text. */
  description: string;
  /** The wire accepts an explicit null. The generated CLI rejects nullable
   *  fields because plain flags cannot express null safely. */
  nullable?: boolean;
  min?: number;
  max?: number;
};

type ActionSpec = {
  /** The command's honest side-effect statement; the CLI renders it as the
   *  --help body. */
  description: string;
  /** Flat wire field model (what the CLI and contract validation consume). */
  fields: FieldSpec[];
  /** JSON Schema (draft 2020-12) of the action's args object, minus the
   *  `action` discriminator, for standard tooling. Same zod source as
   *  `fields`, emitted in the same run, so the two cannot drift. */
  schema: Record<string, unknown>;
};

interface ApiSurfaceContract {
  $comment: string;
  protocolVersion: number;
  groups: Record<
    string,
    { description: string; actions: Record<string, ActionSpec> }
  >;
}

type VerbSpec = {
  /** The wire action this CLI verb maps onto. */
  action: string;
  /** One-line summary in `berdctl <noun> --help`'s verb list. */
  about: string;
  /** Example + result shape rendered after the options (the command's
   *  helpFooter). */
  afterHelp: string;
};

interface CliSurfaceContract {
  $comment: string;
  nouns: Record<
    string,
    { group: string; about: string; verbs: Record<string, VerbSpec> }
  >;
}

const API_COMMENT =
  "GENERATED FILE — do not hand-edit; run `pnpm generate:berdctl-contract`. " +
  "Client-neutral wire surface of the Berd desktop app's control API: " +
  'POST /v1/call {"command": "<group>", "args": {"action": "<action>", ' +
  "...fields}} against the loopback endpoint in the berdctl discovery file. " +
  "protocolVersion mirrors PROTOCOL_VERSION in both discovery.rs copies " +
  "(berdctl and plugin crate tests pin them equal). Per action: " +
  "description, fields " +
  "(flat wire model: name, required, kind, values, description, bounds), and schema " +
  "(JSON Schema 2020-12 of the args object, minus the action discriminator). " +
  "Derived from the authoritative zod schemas in the colocated command " +
  "modules (src/features/berdctl/commands/impl/*.ts); the renderer " +
  "registry's strict zod parse — not this file — is the trust boundary. " +
  "vitest asserts freshness " +
  "(src/features/berdctl/__tests__/apiSurface.test.ts).";

const CLI_COMMENT =
  "GENERATED FILE — do not hand-edit; run `pnpm generate:berdctl-contract`. " +
  "CLI projection of api-surface.json: the noun/verb tree mapping onto " +
  "groups/actions, plus CLI-only prose (noun about lines, verb summaries, " +
  "after-help footers), derived from TOOL_GROUPS' cli metadata and each " +
  "command's summary/helpFooter (src/features/berdctl/commands/registry.ts " +
  "and impl/*.ts). berdctl embeds this file plus api-surface.json and " +
  "builds its clap tree from them at startup (tree.rs); vitest asserts " +
  "freshness (src/features/berdctl/__tests__/cliSurface.test.ts).";

/**
 * Normalize one zod field into the contract's FieldSpec shape. Wrappers are
 * unwrapped to the base type: optional/default make the field non-required on
 * the wire; nullable is recorded as a marker without changing wire presence.
 * Bounds come from explicit zod min/max
 * declarations (string length bounds are represented as min/max too). The
 * field's .describe() text becomes its documentation (and the CLI flag's
 * --help text) and is required.
 */
function describeField(
  group: string,
  action: string,
  name: string,
  schema: z.ZodType,
): FieldSpec {
  let current: z.ZodType = schema;
  let required = true;
  let nullable = false;
  // .describe() annotates whichever wrapper it was called on; take the
  // outermost annotation.
  let description = current.description;
  for (;;) {
    if (current instanceof z.ZodOptional) {
      required = false;
      current = current.unwrap() as z.ZodType;
    } else if (current instanceof z.ZodDefault) {
      required = false;
      current = current.unwrap() as z.ZodType;
    } else if (current instanceof z.ZodNullable) {
      nullable = true;
      current = current.unwrap() as z.ZodType;
    } else {
      break;
    }
    description ??= current.description;
  }
  if (!description) {
    throw new Error(
      `${group}.${action}.${name}: missing .describe(); every wire field ` +
        "needs one — it documents the field and becomes the flag's --help " +
        "text. Add it to the zod schema, then regenerate with " +
        "`pnpm generate:berdctl-contract`",
    );
  }
  const base: FieldSpec = { name, required, kind: "string", description };
  if (nullable) base.nullable = true;
  if (current instanceof z.ZodString) {
    if (current.minLength !== null) base.min = current.minLength;
    if (current.maxLength !== null) base.max = current.maxLength;
    return base;
  }
  if (current instanceof z.ZodArray) {
    if (!(current.element instanceof z.ZodString)) {
      throw new Error(
        `${group}.${action}.${name}: only arrays of strings are supported; ` +
          "use z.array(z.string()) or teach the generated CLI a new array type",
      );
    }
    return { ...base, kind: "string_array" };
  }
  if (current instanceof z.ZodEnum) {
    const values = [...current.options];
    if (!values.every((value): value is string => typeof value === "string")) {
      throw new Error(
        `${group}.${action}.${name}: numeric z.enum values are not supported; ` +
          "use string enum values so berdctl can expose them as CLI possible values",
      );
    }
    return { ...base, values };
  }
  if (current instanceof z.ZodNumber) {
    base.kind = "number";
    if (current.minValue !== null) base.min = current.minValue;
    if (current.maxValue !== null) base.max = current.maxValue;
    return base;
  }
  if (current instanceof z.ZodBoolean) {
    base.kind = "boolean";
    return base;
  }
  throw new Error(
    `${group}.${action}.${name}: unsupported zod type ` +
      `${current.constructor.name}; teach contract.ts to introspect it (and ` +
      "the berdctl crate's tree.rs/wire.rs to build a flag for it), then " +
      "regenerate with `pnpm generate:berdctl-contract`",
  );
}

function commandSchemaShape(
  group: string,
  action: string,
  command: AppCommand<unknown, unknown>,
): Record<string, z.ZodType> {
  if (!(command.schema instanceof z.ZodObject)) {
    throw new Error(
      `${group}.${action}: expected a ZodObject schema at the trust boundary`,
    );
  }
  return command.schema.shape as Record<string, z.ZodType>;
}

/**
 * The CLI verb → registry action mapping for one group: the explicit
 * `cli.verbs` override when present (validated to cover the group's actions
 * exactly), otherwise the identity mapping over the action names.
 */
function groupVerbs(
  groupName: string,
  group: ToolGroup,
): Record<string, string> {
  const actionNames = Object.keys(group.actions);
  if (!group.cli.verbs) {
    return Object.fromEntries(actionNames.map((action) => [action, action]));
  }
  const mapped = Object.values(group.cli.verbs).sort();
  const expected = [...actionNames].sort();
  if (JSON.stringify(mapped) !== JSON.stringify(expected)) {
    throw new Error(
      `registry group "${groupName}": cli.verbs must map verbs onto the ` +
        `group's actions exactly (got [${mapped.join(", ")}], ` +
        `expected [${expected.join(", ")}])`,
    );
  }
  return group.cli.verbs;
}

/** Deterministic (registry/schema-declaration-order) client-neutral wire
 *  surface: per group/action, the description, the flat field model, and a
 *  JSON Schema of the args. */
export function buildApiSurfaceContract(): ApiSurfaceContract {
  const groups: ApiSurfaceContract["groups"] = {};
  for (const [groupName, group] of Object.entries<ToolGroup>(TOOL_GROUPS)) {
    const actions: Record<string, ActionSpec> = {};
    for (const [actionName, command] of Object.entries(group.actions)) {
      actions[actionName] = {
        description: command.description,
        fields: Object.entries(
          commandSchemaShape(groupName, actionName, command),
        ).map(([name, field]) =>
          describeField(groupName, actionName, name, field),
        ),
        // io: "input" — describe what a caller may send (defaulted fields
        // are optional), matching the field model's `required` semantics.
        schema: z.toJSONSchema(command.schema, { io: "input" }) as Record<
          string,
          unknown
        >,
      };
    }
    groups[groupName] = { description: group.description, actions };
  }
  return {
    $comment: API_COMMENT,
    protocolVersion: WIRE_PROTOCOL_VERSION,
    groups,
  };
}

/** Deterministic (registry-declaration-order) CLI projection: noun/verb
 *  tree plus the CLI-only prose (noun abouts, verb summaries, footers). */
export function buildCliSurfaceContract(): CliSurfaceContract {
  const nouns: CliSurfaceContract["nouns"] = {};
  for (const [groupName, group] of Object.entries<ToolGroup>(TOOL_GROUPS)) {
    const { noun, about } = group.cli;
    if (nouns[noun]) {
      throw new Error(
        `registry groups "${nouns[noun].group}" and "${groupName}" both ` +
          `declare CLI noun "${noun}"`,
      );
    }
    const verbs: Record<string, VerbSpec> = {};
    for (const [verb, action] of Object.entries(groupVerbs(groupName, group))) {
      const command = group.actions[action];
      verbs[verb] = {
        action,
        about: command.summary,
        afterHelp: command.helpFooter,
      };
    }
    nouns[noun] = { group: groupName, about, verbs };
  }
  return { $comment: CLI_COMMENT, nouns };
}
